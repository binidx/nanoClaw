# Repo Review Tool Budget Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce repo-review runtime, tool-iteration failures, and split-mode memory spikes without weakening review correctness.

**Architecture:** Keep `diff` as the primary evidence and preserve the model's ability to read directly related repository files when needed. Optimize the executor around three hard constraints instead of replacing model judgment: parse the diff once, hydrate heavy payloads lazily, and schedule full-file work by byte budget rather than task count. Any system-generated context must remain hint-only metadata, not a substitute for the model's own diff reasoning.

**Tech Stack:** Node.js, TypeScript, Express, better-sqlite3, Vitest, Codex agent runner

---

## Problem Statement

The current issue is not simply "the model explores too much". It is the interaction of permissive exploration, duplicated payload construction, and unbounded in-memory orchestration.

Three points must stay explicit:

1. **Split review is already configurable.** `diffSubagentThreshold` controls when diff review splits, and global subagent concurrency is controlled separately by `maxActive`. The optimization target is therefore not "add splitting", but "make split execution cheaper and memory-bounded".
2. **Correctness must stay diff-first.** The system must not replace model review with a pre-generated summary as the source of truth. Lightweight metadata is acceptable only if it reduces obviously redundant reads while keeping the real diff and directly related files available.
3. **Memory pressure is now a first-class problem.** After split mode is enabled, the executor duplicates diff slices, preloads full-file content, expands giant orchestration prompts, and repeatedly persists growing `reviewTurns` arrays. That design amplifies memory use even when the model behavior itself is reasonable.

## Current Root Causes

### 1. Tool usage grows because stage 1 still permits broad free exploration

The stage-1 prompt explicitly tells the model it can read the mounted repository to obtain full context. For Java / XML / test chains, this reliably causes repeated `read_file` calls across service, mapper, DTO, constants, and tests.

This is not a model defect. It is a predictable outcome of the current contract: the system asks for high-confidence review findings, but injects only the diff plus very thin project context.

### 2. Split diff review duplicates the diff repeatedly

`buildFilteredDiff(...)` reparses and rebuilds strings every time it prepares a file task or a grouped worker payload. In split mode, the same large diff is sliced many times for single-file tasks and then again for grouped tasks. The more files are split, the more duplicated strings are created.

### 3. Full-file review is eager, not streaming

The full-file phase currently fetches content for every changed file up front, stores `fileDiff` and `fileContent` on every prepared task, then also keeps `preparedTasks`, `taskGroups`, `allTasks`, `remainingGroups`, and `supplementalResults` alive together. That means peak memory is driven by the whole review set, not the currently executing batch.

### 4. The full-file orchestrator prompt is itself a large memory spike

The orchestrator prompt inlines grouped task blocks containing diff slices, full file contents, and related findings. If orchestration falls back to batch workers, the system repackages large payloads again. This means the second phase pays for the same data multiple times.

### 5. `reviewTurns` persistence keeps growing the live payload

Intermediate progress persistence accumulates and writes full `reviewTurns` snapshots repeatedly. At the top level, callback context merges `phase1Turns` and `phase2Turns` again and again. This increases heap pressure and serialization overhead independently of the model's actual reasoning.

## Non-Goals

- Do **not** replace diff review with retrieval-only or summary-only review.
- Do **not** remove repository reads entirely; constrain them to directly relevant follow-up reads.
- Do **not** treat the current threshold semantics as the main problem. The current UI says "超过此值时" and the executor uses `>`, which is consistent with that wording.
- Do **not** solve this primarily by just raising global tool limits or timeouts.

## File Structure

**Create:**

- `src/repo-review-diff-index.ts`
  Parse a unified diff once, store file section offsets, and expose lazy slice helpers plus diff-weight estimation.
- `src/repo-review-diff-index.test.ts`
  Cover multi-file diff indexing, slice extraction, stable offsets, and weight estimation.
- `src/repo-review-budget.ts`
  Centralize payload-size estimation, byte-budget reservation, and group sizing for split and full-file stages.
- `src/repo-review-budget.test.ts`
  Cover reservation logic, oversized-group splitting, and deterministic budget behavior.

**Modify:**

- `src/repo-review-run-executor.ts`
  Replace repeated diff copying, stream full-file payload hydration, shrink orchestrator payloads, and persist compact progress.
- `src/repo-review-model.ts`
  Add execution-budget types, instrumentation fields, and compact progress snapshot types.
- `src/repo-review-service.test.ts`
  Add regression tests for lazy diff slicing, byte-budgeted scheduling, compact progress persistence, and prompt exploration limits.
- `docs/RepoReview.md`
  Document the revised execution model and its guardrails.

**Reference:**

- `src/runtime-customization.ts`
- `web/src/components/repo-review/RepoReviewProfileSection.tsx`
- `src/repo-review-run-executor.ts`
- `src/repo-review-model.ts`

---

### Task 1: Instrument the Real Hotspots Before Changing Control Flow

**Files:**
- Create: `src/repo-review-budget.ts`
- Create: `src/repo-review-budget.test.ts`
- Modify: `src/repo-review-model.ts`
- Modify: `src/repo-review-run-executor.ts`
- Test: `src/repo-review-service.test.ts`

- [ ] **Step 1: Write failing tests for payload estimation and budget stats**

Add tests for functions such as:

```ts
expect(estimateRepoReviewPayloadBytes({
  diffBytes: 1200,
  fileContentBytes: 8000,
  relatedFindingBytes: 300,
})).toBeGreaterThan(9000);

expect(splitTasksByByteBudget([
  { filePath: 'A.java', estimatedBytes: 90_000 },
  { filePath: 'B.xml', estimatedBytes: 70_000 },
  { filePath: 'CTest.java', estimatedBytes: 60_000 },
], 120_000)).toEqual([
  ['A.java'],
  ['B.xml'],
  ['CTest.java'],
]);
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `npx vitest run src/repo-review-budget.test.ts`

Expected: FAIL because the budget helpers and types do not exist.

- [ ] **Step 3: Add execution-budget model types**

In `src/repo-review-model.ts`, add explicit instrumentation fields instead of inferring memory behavior from logs:

```ts
export interface RepoReviewExecutionStats {
  diffFiles: number;
  diffBytes: number;
  splitGroups: number;
  peakReservedBytes: number;
  fullFileBytesLoaded: number;
  promptBytesBuilt: number;
  progressSnapshotBytes: number;
  extraRepoReadCount: number;
}
```

- [ ] **Step 4: Implement deterministic budget helpers**

In `src/repo-review-budget.ts`, add helpers such as:

```ts
export function estimateRepoReviewPayloadBytes(input: {
  diffBytes: number;
  fileContentBytes: number;
  relatedFindingBytes: number;
}): number;

export function splitTasksByByteBudget<T extends { estimatedBytes: number }>(
  tasks: T[],
  maxBytes: number,
): T[][];
```

- [ ] **Step 5: Emit execution stats from the executor**

Capture at least:
- stage-1 extra file reads
- bytes reserved by each full-file worker batch
- total bytes loaded from full files
- size of persisted progress snapshots
- peak bytes of constructed prompts

Do this inside `src/repo-review-run-executor.ts` so optimization work can be validated with data instead of guesswork.

- [ ] **Step 6: Run targeted tests**

Run: `npx vitest run src/repo-review-budget.test.ts src/repo-review-service.test.ts -t "budget"`

Expected: PASS with deterministic byte-budget coverage.

- [ ] **Step 7: Commit**

```bash
git add src/repo-review-budget.ts src/repo-review-budget.test.ts src/repo-review-model.ts src/repo-review-run-executor.ts src/repo-review-service.test.ts
git commit -m "refactor: add repo review budget instrumentation"
```

### Task 2: Replace Repeated Diff Copying with a Single Diff Index

**Files:**
- Create: `src/repo-review-diff-index.ts`
- Create: `src/repo-review-diff-index.test.ts`
- Modify: `src/repo-review-run-executor.ts`
- Test: `src/repo-review-service.test.ts`

- [ ] **Step 1: Write failing tests for diff indexing**

Add tests that prove the diff is parsed once and slices are extracted by file path without reparsing the whole input each time.

```ts
const index = buildRepoReviewDiffIndex(sampleDiff);
expect(index.files).toEqual(['A.java', 'B.xml', 'CTest.java']);
expect(getRepoReviewDiffSlice(index, ['B.xml'])).toContain('diff --git a/B.xml b/B.xml');
expect(getRepoReviewDiffSlice(index, ['A.java', 'CTest.java'])).not.toContain('B.xml');
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `npx vitest run src/repo-review-diff-index.test.ts`

Expected: FAIL because the diff index helpers do not exist.

- [ ] **Step 3: Implement the diff index**

In `src/repo-review-diff-index.ts`, add:

```ts
export interface RepoReviewDiffIndexEntry {
  filePath: string;
  startOffset: number;
  endOffset: number;
  estimatedBytes: number;
}

export function buildRepoReviewDiffIndex(diffText: string): RepoReviewDiffIndex;
export function getRepoReviewDiffSlice(index: RepoReviewDiffIndex, files: string[]): string;
```

The source diff string must remain single-owned for the whole run. Slice extraction should reuse offsets instead of re-splitting the full diff for every task.

- [ ] **Step 4: Move split-phase task preparation to references, not copied strings**

In `src/repo-review-run-executor.ts`, replace task shapes like:

```ts
{ filePath, fileDiff }
```

with reference-based task shapes like:

```ts
{ filePath, diffFiles: [filePath], estimatedDiffBytes }
```

Only materialize the string slice when actually building a worker prompt.

- [ ] **Step 5: Remove duplicate grouped diff construction**

Use the same indexed diff source for:
- phase-1 split worker prompts
- full-file review worker prompts
- any fallback batch prompts

Do not rebuild filtered diffs separately for single-file and grouped tasks.

- [ ] **Step 6: Run targeted tests**

Run: `npx vitest run src/repo-review-diff-index.test.ts src/repo-review-service.test.ts -t "diff index"`

Expected: PASS with stable slicing behavior.

- [ ] **Step 7: Commit**

```bash
git add src/repo-review-diff-index.ts src/repo-review-diff-index.test.ts src/repo-review-run-executor.ts src/repo-review-service.test.ts
git commit -m "perf: index repo review diffs once"
```

### Task 3: Convert Full-File Review from Eager Materialization to Streaming Batches

**Files:**
- Modify: `src/repo-review-run-executor.ts`
- Modify: `src/repo-review-model.ts`
- Modify: `src/repo-review-service.test.ts`
- Test: `src/repo-review-budget.test.ts`

- [ ] **Step 1: Write failing tests for streaming full-file preparation**

Add tests that assert the executor no longer preloads content for every changed file before dispatching work.

```ts
expect(fetchChangedFileContentForReview).toHaveBeenCalledTimes(0);
await prepareNextFullFileBatch(...);
expect(fetchChangedFileContentForReview).toHaveBeenCalledTimes(2);
```

The expected behavior is "load only the next batch", not "load every file up front".

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run: `npx vitest run src/repo-review-service.test.ts -t "full-file streaming"`

Expected: FAIL because the current implementation eagerly loads all changed files.

- [ ] **Step 3: Replace prepared full-file tasks with lightweight manifests**

In `src/repo-review-run-executor.ts`, keep only metadata in memory during planning:

```ts
interface RepoReviewFullFileTaskManifest {
  filePath: string;
  estimatedDiffBytes: number;
  estimatedFileBytes: number;
  relatedFindingIndexes: number[];
}
```

Do not attach `fileContent` or rendered `fileDiff` until the scheduler is ready to dispatch that specific batch.

- [ ] **Step 4: Schedule by byte budget, not only by worker count**

Use `splitTasksByByteBudget(...)` so peak in-flight payload is limited by bytes. `maxActive` remains the concurrency ceiling, but dispatch now also requires enough remaining byte budget.

Required behavior:
- if one batch would exceed the budget, split it further
- if one file alone exceeds the budget, run it alone and record a scope limitation when truncation is necessary
- never keep every changed file's content in memory just because full-file mode is enabled

- [ ] **Step 5: Make the orchestrator manifest-only**

If the orchestrator stays in the flow, it must receive only:
- file paths
- estimated sizes
- related phase-1 findings
- grouping metadata

It must not receive every full file's text in one prompt. The actual file content belongs only in the worker prompt for the current batch.

- [ ] **Step 6: Run targeted tests**

Run: `npx vitest run src/repo-review-budget.test.ts src/repo-review-service.test.ts -t "full-file streaming"`

Expected: PASS with bounded batch hydration.

- [ ] **Step 7: Commit**

```bash
git add src/repo-review-run-executor.ts src/repo-review-model.ts src/repo-review-service.test.ts src/repo-review-budget.test.ts
git commit -m "perf: stream repo review full-file batches"
```

### Task 4: Stop Persisting Full `reviewTurns` Snapshots on Every Progress Tick

**Files:**
- Modify: `src/repo-review-run-executor.ts`
- Modify: `src/repo-review-model.ts`
- Modify: `src/repo-review-service.test.ts`

- [ ] **Step 1: Write failing tests for compact progress persistence**

Add tests that verify intermediate persistence stores a compact snapshot or delta instead of the entire accumulated turn list.

```ts
expect(persisted.callback_context.reviewTurns).toBeUndefined();
expect(persisted.callback_context.reviewProgress).toMatchObject({
  latestAssistantText: expect.any(String),
  turnCount: expect.any(Number),
});
```

The full `reviewTurns` array may still be written once at completion if the detail page needs it, but intermediate writes must stay compact.

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run: `npx vitest run src/repo-review-service.test.ts -t "progress persistence"`

Expected: FAIL because the current implementation persists merged turn arrays repeatedly.

- [ ] **Step 3: Add compact snapshot types**

In `src/repo-review-model.ts`, define a structure such as:

```ts
export interface RepoReviewProgressSnapshot {
  turnCount: number;
  latestAssistantText: string;
  latestErrorText: string | null;
  hasTerminalOutput: boolean;
}
```

- [ ] **Step 4: Persist compact snapshots during execution**

In `src/repo-review-run-executor.ts`:
- persist `reviewProgress` during phase execution
- defer full `reviewTurns` persistence until final completion only
- if final `reviewTurns` is still too large, trim tool-heavy items before writing callback context and keep the canonical full detail in runtime memory only long enough to finish the run

- [ ] **Step 5: Run targeted tests**

Run: `npx vitest run src/repo-review-service.test.ts -t "progress persistence"`

Expected: PASS with reduced callback-context size.

- [ ] **Step 6: Commit**

```bash
git add src/repo-review-run-executor.ts src/repo-review-model.ts src/repo-review-service.test.ts
git commit -m "perf: compact repo review progress persistence"
```

### Task 5: Tighten the Prompt Contract to Targeted Exploration Instead of Free Exploration

**Files:**
- Modify: `src/repo-review-run-executor.ts`
- Modify: `src/repo-review-service.test.ts`
- Modify: `docs/RepoReview.md`

- [ ] **Step 1: Write failing tests for the revised prompt contract**

Add prompt assertions such as:

```ts
expect(prompt).toContain('优先基于已提供的 diff 完成判断');
expect(prompt).toContain('仅在需要确认高风险判断时，补读直接相关文件');
expect(prompt).not.toContain('你可以使用挂载到工作区的只读仓库自行读取文件内容，获取完整上下文。');
```

- [ ] **Step 2: Run the prompt tests and confirm they fail**

Run: `npx vitest run src/repo-review-service.test.ts -t "prompt contract"`

Expected: FAIL because the current prompt still invites broad exploration.

- [ ] **Step 3: Rewrite the stage-1 prompt**

The new contract should say:
- diff is the primary evidence
- directly related reads are allowed only for high-risk confirmation
- if confidence still depends on broader exploration, record `scope_limitations` instead of continuing an open-ended file chase

Use wording close to:

```text
优先基于已提供的 diff、提交摘要和项目上下文完成审查。
仅当某个高风险判断需要额外确认，且补读一个直接相关文件即可确认时，才读取额外文件。
若仍缺少上下文，请写入 scope_limitations，不要继续扩展探索范围。
```

- [ ] **Step 4: Keep any system-generated context strictly hint-only**

If later added, lightweight file metadata may include only facts such as symbol names, imports, or mapper statement IDs. It must never contain model-written conclusions, and must never replace the real diff or full file read path.

- [ ] **Step 5: Update the module doc**

In `docs/RepoReview.md`, document:
- split review remains threshold-driven and configurable
- full-file stage is payload-budgeted
- repo reads are still allowed, but targeted
- tool limits are now treated as a recovery boundary rather than the normal control flow

- [ ] **Step 6: Run targeted tests**

Run: `npx vitest run src/repo-review-service.test.ts -t "prompt contract"`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/repo-review-run-executor.ts src/repo-review-service.test.ts docs/RepoReview.md
git commit -m "refactor: tighten repo review exploration contract"
```

### Task 6: Verify the New Pipeline Against the Actual Failure Mode

**Files:**
- Modify: `src/repo-review-service.test.ts`
- Modify: `docs/RepoReview.md`

- [ ] **Step 1: Add a regression case for the reported failure shape**

Model a review resembling:
- around 15 changed files
- Java service + DTO + mapper XML + test mix
- split review enabled
- full-file review enabled

Assert the executor:
- uses split mode when the configured threshold says it should
- stays under the byte budget for in-flight full-file work
- does not persist unbounded progress snapshots
- keeps direct follow-up reads available for correctness-sensitive cases

- [ ] **Step 2: Run the targeted regression suite**

Run: `npx vitest run src/repo-review-service.test.ts`

Expected: PASS with explicit coverage for split + full-file review interaction.

- [ ] **Step 3: Run the relevant build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/repo-review-service.test.ts docs/RepoReview.md
git commit -m "test: cover repo review split memory regression"
```

## Execution Order

Implement in this order:

1. Task 1 - instrumentation
2. Task 2 - single diff index
3. Task 3 - streaming full-file execution
4. Task 4 - compact progress persistence
5. Task 5 - prompt contract tightening
6. Task 6 - regression verification and docs

This order matters. Without instrumentation first, the team will keep arguing from symptoms. Without lazy diff slicing before streaming full-file work, memory reductions will be partial. Without compact persistence, split mode will still pay a hidden heap cost even after prompt payloads are reduced.

## Expected Outcome

After this plan is implemented, the repo-review pipeline should behave as follows:

- medium and large reviews remain `diff-first`, not retrieval-first
- split review stays configurable, but no longer multiplies memory simply by duplicating diff strings
- full-file review becomes bounded by an explicit byte budget instead of the total size of all changed files
- the model can still inspect directly related files when correctness requires it, but the default prompt no longer encourages open-ended repository exploration
- progress persistence stops inflating callback context during long-running reviews
- tool-iteration failures become exception paths rather than the common outcome for Java/XML/test mixed changes
