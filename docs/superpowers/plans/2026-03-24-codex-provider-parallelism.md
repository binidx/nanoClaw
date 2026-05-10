# Codex Provider Parallelism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow main agents, subagents, and separate web conversations to issue Codex requests in parallel by default, without a shared global provider mutex and without regressing repo review or long-running streaming turns.

**Architecture:** Remove provider-wide serialization from the child runner and replace it with two narrower mechanisms: local state isolation keyed by runtime/session ownership, and an optional provider concurrency limiter that controls fan-out without forcing a single-file global lock. In parallel, add explicit child-to-parent progress heartbeats so the outer runner no longer mistakes “waiting on provider / still streaming” for a dead process.

**Tech Stack:** Node.js, TypeScript, Vitest, NanoClaw child runner under `agent/runner/src`, outer agent process bridge under `src/**`

---

## File Structure

**Primary runtime files**
- Modify: `agent/runner/src/index.ts`
  Responsibility: Codex request execution, current provider lock behavior, turn streaming, tool call loop.
- Modify: `agent/runner/src/codex-tools.ts`
  Responsibility: subagent spawn metadata, runtime/session identifiers, subagent IPC lifecycle.
- Modify: `src/agent-runner.ts`
  Responsibility: parent process supervision, timeout handling, stdout marker parsing, kill semantics.
- Modify: `src/repo-review-service.ts`
  Responsibility: review-agent lifecycle, streamed turn handling, early close behavior after final useful output.
- Modify: `src/config.ts`
  Responsibility: top-level runtime config defaults for timeout and any new provider concurrency settings.

**New support files**
- Create: `agent/runner/src/codex-provider-concurrency.ts`
  Responsibility: parse provider concurrency mode, optional limiter, scoped local guards for shared state, and focused tests.
- Create: `agent/runner/src/codex-provider-concurrency.test.ts`
  Responsibility: concurrency policy tests, default mode tests, limiter behavior tests, and regression coverage for “no global serialization”.

**Existing tests to extend**
- Modify: `agent/runner/src/codex-tools.test.ts`
  Responsibility: verify subagent runtime metadata remains stable after concurrency changes.
- Modify: `src/agent-runner.test.ts`
  Responsibility: verify timeout/heartbeat behavior and no false failure while a child is still alive.
- Modify: `src/repo-review-service.test.ts`
  Responsibility: verify streamed repo review completes cleanly when child remains active briefly after final useful output.

**Docs/config surface**
- Modify: `AGENTS.md`
  Responsibility: describe actual provider concurrency behavior and rollback knobs only after implementation is proven.

## Non-Goals

- Do not change frontend code.
- Do not redesign the subagent registry/UI in this plan.
- Do not add a broad “disable all timeouts” escape hatch.
- Do not reintroduce a hidden global provider lock as the default behavior.

## Success Criteria

- Two independent Codex-backed turns can run concurrently without waiting on a shared provider lock.
- A main agent and one subagent can both make provider requests concurrently.
- Same-runtime local state remains safe; no duplicate IPC consumption or session file corruption is introduced.
- Repo review and other long-running streaming flows do not fail with `Agent exited with code 1` just because a child is still waiting or draining output.
- Default configuration favors parallelism. Any emergency serialization mode is explicit and opt-in.

### Task 1: Freeze Current Failure Modes in Tests

**Files:**
- Create: `agent/runner/src/codex-provider-concurrency.test.ts`
- Modify: `src/agent-runner.test.ts`
- Modify: `src/repo-review-service.test.ts`

- [ ] **Step 1: Add a failing child-runner concurrency regression test**

```ts
it('does not serialize unrelated Codex requests by default', async () => {
  const events: string[] = [];
  const first = runThroughPolicy('conv-a', async () => {
    events.push('start-a');
    await delay(100);
    events.push('end-a');
  });
  await delay(10);
  const second = runThroughPolicy('conv-b', async () => {
    events.push('start-b');
    events.push('end-b');
  });
  await Promise.all([first, second]);
  expect(events.indexOf('start-b')).toBeLessThan(events.indexOf('end-a'));
});
```

- [ ] **Step 2: Run the new test to verify it fails under the current global lock**

Run: `npx vitest run agent/runner/src/codex-provider-concurrency.test.ts`
Expected: FAIL because unrelated requests still serialize or the helper is not implemented yet.

- [ ] **Step 3: Add a failing parent-runner timeout regression test**

```ts
it('does not SIGTERM a child that is still sending structured keepalive events', async () => {
  // Simulate a child that emits a progress marker before final result.
  // Assert the parent timeout is reset and no kill happens.
});
```

- [ ] **Step 4: Run the timeout test to verify it fails before implementation**

Run: `npx vitest run src/agent-runner.test.ts`
Expected: FAIL because only final output resets the hard timeout today.

- [ ] **Step 5: Add a failing repo-review regression test**

```ts
it('does not mark review failed when the child remains alive after final useful turn output', async () => {
  // Stream a completed review turn, delay child close, assert triggerLocalRepoReview still passes.
});
```

- [ ] **Step 6: Run the review test to verify the current failure mode is captured**

Run: `npx vitest run src/repo-review-service.test.ts`
Expected: FAIL or require fixture updates because the current lifecycle is too eager to interpret late close as failure.

- [ ] **Step 7: Commit the failing-test baseline**

```bash
git add agent/runner/src/codex-provider-concurrency.test.ts src/agent-runner.test.ts src/repo-review-service.test.ts
git commit -m "test: capture provider parallelism regressions"
```

### Task 2: Extract Provider Concurrency Policy Out of `index.ts`

**Files:**
- Create: `agent/runner/src/codex-provider-concurrency.ts`
- Modify: `agent/runner/src/index.ts`
- Test: `agent/runner/src/codex-provider-concurrency.test.ts`

- [ ] **Step 1: Create a focused policy module**

```ts
export type CodexProviderConcurrencyMode =
  | { mode: 'parallel' }
  | { mode: 'limit'; maxConcurrent: number }
  | { mode: 'global'; reason?: string };

export function resolveCodexProviderConcurrency(env: NodeJS.ProcessEnv) {
  const raw = String(env.NANOCLAW_CODEX_PROVIDER_CONCURRENCY || 'parallel').trim().toLowerCase();
  if (raw === 'global') return { mode: 'global' } as const;
  const max = Number.parseInt(String(env.NANOCLAW_CODEX_PROVIDER_MAX_CONCURRENT || '0'), 10);
  if (Number.isFinite(max) && max > 0) return { mode: 'limit', maxConcurrent: max } as const;
  return { mode: 'parallel' } as const;
}
```

- [ ] **Step 2: Add a small in-process semaphore, not a filesystem mutex**

```ts
class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  async acquire(): Promise<() => void> { /* minimal FIFO implementation */ }
}
```

- [ ] **Step 3: Keep any local guard keyed to actual shared state, not provider-wide**

```ts
export function buildSharedStateKey(input: {
  sessionId?: string;
  runtimeId?: string;
  requestKind: 'transcript' | 'ipc' | 'provider';
}) {
  return input.requestKind === 'provider' ? null : `${input.requestKind}:${input.runtimeId || input.sessionId || 'ephemeral'}`;
}
```

- [ ] **Step 4: Replace direct provider lock usage in `agent/runner/src/index.ts`**

```ts
const policy = resolveCodexProviderConcurrency(process.env);
await withCodexProviderConcurrency(policy, async () => {
  return fetchCodexApiWithRetry(...);
});
```

- [ ] **Step 5: Delete filesystem-lock-only assumptions from the request path**

Expected code effect:
- no `CODEX_PROVIDER_LOCK_DIR_NAME`
- no lock heartbeat file for provider requests
- no `Timed out waiting for Codex provider lock` path in default mode

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run agent/runner/src/codex-provider-concurrency.test.ts`
Expected: PASS with unrelated requests concurrent by default, optional limit mode serialized only when configured.

- [ ] **Step 7: Commit the extraction**

```bash
git add agent/runner/src/index.ts agent/runner/src/codex-provider-concurrency.ts agent/runner/src/codex-provider-concurrency.test.ts
git commit -m "refactor: replace global provider lock with concurrency policy"
```

### Task 3: Make Subagent Metadata Parallel-Safe Without Reintroducing Serialization

**Files:**
- Modify: `agent/runner/src/codex-tools.ts`
- Modify: `agent/runner/src/codex-tools.test.ts`
- Reference: `agent/runner/src/subagents/protocol.ts`

- [ ] **Step 1: Separate metadata identity from provider scheduling**

```ts
const providerSessionId = `codex:${childId}`; // telemetry only
// Do not use this as a lock key by itself.
```

- [ ] **Step 2: Keep runtime/session lineage in metadata for observability**

```ts
metadata: {
  providerSessionId,
  parentRuntimeId,
  controllerSessionKey,
  requesterSessionKey,
}
```

- [ ] **Step 3: Ensure spawned subagents inherit only the context they need**

```ts
env: {
  ...process.env,
  NANOCLAW_CURRENT_SUBAGENT_RUNTIME_ID: childId,
  NANOCLAW_SUBAGENT_DEPTH: String(depth),
}
```

Expected:
- subagent identity remains queryable in the registry/UI
- no env var exists solely to force provider serialization

- [ ] **Step 4: Add/update tests around spawn env and metadata**

```ts
expect(runtimeMetadata).toMatchObject({
  topologyRole: 'orchestrator',
  workProfile: 'explorer',
});
expect(firstSpawnEnv?.NANOCLAW_CURRENT_SUBAGENT_RUNTIME_ID).toBeTruthy();
```

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run agent/runner/src/codex-tools.test.ts`
Expected: PASS, including TeamCreate/SendMessage/TeamDelete flow and surfaced subagent failures.

- [ ] **Step 6: Commit the metadata cleanup**

```bash
git add agent/runner/src/codex-tools.ts agent/runner/src/codex-tools.test.ts
git commit -m "refactor: decouple subagent metadata from provider serialization"
```

### Task 4: Add Explicit Progress Heartbeats So Parent Timeouts Stop Killing Healthy Children

**Files:**
- Modify: `agent/runner/src/index.ts`
- Modify: `src/agent-runner.ts`
- Modify: `src/agent-runner.test.ts`

- [ ] **Step 1: Define a lightweight structured progress marker from child to parent**

```ts
emitOutput({
  status: 'success',
  result: null,
  event: {
    id: 'provider-wait',
    kind: 'status',
    status: 'in_progress',
    title: 'Waiting for Codex provider response',
    timestamp: new Date().toISOString(),
  },
});
```

- [ ] **Step 2: Emit progress before and during long provider phases**

Expected emission points:
- right before sending provider request
- periodically while streaming is active
- while waiting behind an optional concurrency limiter

- [ ] **Step 3: Treat structured progress events as timeout-resetting activity in `src/agent-runner.ts`**

```ts
if (parsed.event || parsed.turnEvent || parsed.streamChunk || parsed.result) {
  resetTimeout();
}
```

- [ ] **Step 4: Keep stderr ignored for timeout resets**

Reason:
- stderr is noisy and not a reliable signal of useful work
- the keepalive channel must stay explicit and structured

- [ ] **Step 5: Add tests for “alive but no final result yet”**

```ts
expect(proc.kill).not.toHaveBeenCalledWith('SIGTERM');
```

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run src/agent-runner.test.ts`
Expected: PASS with keepalive-driven timeout extension and unchanged cleanup after true hangs.

- [ ] **Step 7: Commit the timeout fix**

```bash
git add agent/runner/src/index.ts src/agent-runner.ts src/agent-runner.test.ts
git commit -m "fix: keep healthy codex child runs alive during provider waits"
```

### Task 5: Harden Repo Review and Other Single-Turn Flows Against Late Child Shutdown

**Files:**
- Modify: `src/repo-review-service.ts`
- Modify: `src/repo-review-service.test.ts`
- Optional reference: `src/index.ts`

- [ ] **Step 1: Define repo-review completion based on semantic completion, not just process exit**

```ts
function hasFinalReviewPayload(output: AgentRunOutput): boolean {
  return Boolean(output.result) || shouldCloseReviewAgentForTurnEvent(output.turnEvent);
}
```

- [ ] **Step 2: After final useful output, close stdin/IPC and mark the run draining instead of failed**

```ts
if (hasFinalReviewPayload(output)) {
  closeAgentInput();
  reviewState = 'draining';
}
```

- [ ] **Step 3: Ignore a late non-zero child exit when a valid final review payload was already accepted**

```ts
if (reviewState === 'draining' && hasAcceptedFinalReview) {
  return promoteToSuccess(existingResult);
}
```

- [ ] **Step 4: Add regression coverage for streamed review completion followed by delayed close**

Run fixture:
- stream one or more `turnEvent`s
- emit final JSON review payload
- close child late
- assert overall review stays `pass`

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run src/repo-review-service.test.ts`
Expected: PASS for streamed completion, fallback completion, and delayed-close cases.

- [ ] **Step 6: Commit the review hardening**

```bash
git add src/repo-review-service.ts src/repo-review-service.test.ts
git commit -m "fix: avoid false repo review failures after final streamed output"
```

### Task 6: Document, Verify, and Add Safe Rollback Knobs

**Files:**
- Modify: `src/config.ts`
- Modify: `AGENTS.md`
- Modify: `docs/agent-harness.md` if behavior documentation is duplicated there

- [ ] **Step 1: Add explicit config parsing for provider concurrency**

```ts
// Examples:
// NANOCLAW_CODEX_PROVIDER_CONCURRENCY=parallel
// NANOCLAW_CODEX_PROVIDER_CONCURRENCY=limit
// NANOCLAW_CODEX_PROVIDER_MAX_CONCURRENT=4
// NANOCLAW_CODEX_PROVIDER_CONCURRENCY=global   // emergency rollback only
```

- [ ] **Step 2: Set defaults that match the product requirement**

Expected defaults:
- parallel by default
- optional bounded concurrency when operators want backpressure
- global serialization available only as emergency rollback

- [ ] **Step 3: Update docs to reflect actual behavior**

Required doc points:
- main agents, subagents, and independent web chats no longer serialize by default
- local state safety is handled separately from provider concurrency
- global mode is rollback-only

- [ ] **Step 4: Run the full verification set**

Run:
- `npx vitest run agent/runner/src/codex-provider-concurrency.test.ts`
- `npx vitest run agent/runner/src/codex-tools.test.ts`
- `npx vitest run src/agent-runner.test.ts`
- `npx vitest run src/repo-review-service.test.ts`
- `npm run build`

Expected:
- all targeted tests pass
- TypeScript build passes

- [ ] **Step 5: Run one manual parallel smoke test**

Manual check:
1. Start one Codex-backed web conversation.
2. Spawn at least one subagent from that conversation.
3. Start a second independent web conversation.
4. Confirm provider requests overlap in timestamps/logs and no `Timed out waiting for Codex provider lock` error appears.

- [ ] **Step 6: Commit docs and config**

```bash
git add src/config.ts AGENTS.md docs/agent-harness.md
git commit -m "docs: document parallel codex provider behavior"
```

## Verification Checklist

- [ ] `npx vitest run agent/runner/src/codex-provider-concurrency.test.ts`
- [ ] `npx vitest run agent/runner/src/codex-tools.test.ts`
- [ ] `npx vitest run src/agent-runner.test.ts`
- [ ] `npx vitest run src/repo-review-service.test.ts`
- [ ] `npm run build`
- [ ] Manual smoke test with 2 web chats + 1 subagent in parallel

## Rollback Plan

- If provider parallelism causes remote rate-limit instability, switch to:
  `NANOCLAW_CODEX_PROVIDER_CONCURRENCY=limit`
- If a severe production regression appears, temporary rollback mode is:
  `NANOCLAW_CODEX_PROVIDER_CONCURRENCY=global`
- Do not rollback by deleting heartbeat/progress events only; timeout and concurrency changes are coupled and must be reverted together if necessary.

## Notes for the Implementer

- The earlier failed attempt changed locking without simultaneously fixing parent timeout semantics. Do not split those changes again.
- `providerSessionId` is useful telemetry. Keep it for traceability, but do not let it silently become a new provider lock key.
- Prefer explicit structured activity events over abusing stderr or ad hoc logs to keep children alive.
- If repo review still fails after these changes, stop and inspect whether a valid final payload was already accepted before trying more lifecycle patches.
