# Feishu Cloud Doc Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable Feishu cloud-document capability, integrate it into repo review so reviews publish summary-plus-doc output, and expose the same capability for Feishu chat conversations.

**Architecture:** Keep direct Feishu SDK calls in `src/channels/feishu.ts`, add a new orchestration layer in `src/feishu-doc-service.ts`, render repo-review detail into deterministic doc sections, persist one cloud-doc identity per review run for idempotency, and add a conversation action path that can create a Feishu doc from chat context. Repo review remains the first integration surface; chat support reuses the same service contract.

**Tech Stack:** Node.js, TypeScript, Express, better-sqlite3, Vitest, `@larksuiteoapi/node-sdk`

---

## File Structure

**Create:**

- `src/feishu-doc-service.ts`
  Orchestrates Feishu doc creation, content population, URL resolution, authorization strategy, and result normalization.
- `src/feishu-doc-service.test.ts`
  Unit tests for create/populate/url/auth behavior, group fallback, DM target resolution, and retry-safe result handling.
- `src/repo-review-doc-render.ts`
  Converts repo review runs into deterministic cloud-doc sections and concise summary-message payloads.
- `src/repo-review-doc-render.test.ts`
  Covers section ordering, finding formatting, snippet rendering, and summary extraction.
- `agent/runner/src/ipc-mcp-stdio.test.ts`
  Covers MCP tool registration and internal API dispatch for Feishu cloud-doc actions.

**Modify:**

- `src/channels/feishu.ts`
  Add Feishu instance-scoped helpers for docx creation, doc block writes, Drive meta URL lookup, chat metadata lookup, DM counterpart resolution, and permission grant APIs.
- `src/db.ts`
  Add repo-review run persistence for Feishu cloud-doc token, URL, status, and retry-safe bookkeeping.
- `src/db.test.ts`
  Add persistence tests for the new repo-review run fields.
- `src/repo-review-service.ts`
  Build the review doc model, call `feishu-doc-service`, persist doc identity, and send summary messages with doc links or fallback summaries.
- `src/repo-review-service.test.ts`
  Add integration-style tests for success, partial authorization, content population failure, and retry reuse.
- `src/routes/conversation-admin-routes.ts`
  Add a conversation-scoped backend action endpoint for Feishu cloud-doc creation using current conversation context.
- `src/conversation-admin-routes.test.ts`
  Test the new conversation doc action route and failure cases.
- `src/web-server.ts`
  Wire the new conversation doc action route dependency and keep route registration explicit.
- `agent/runner/src/ipc-mcp-stdio.ts`
  Add a model-facing MCP tool that invokes the new backend conversation doc action with either raw text or structured sections.

**Reference:**

- `docs/superpowers/specs/2026-03-27-feishu-cloud-doc-review-design.md`

---

### Task 1: Add Feishu SDK Helper Primitives

**Files:**
- Modify: `src/channels/feishu.ts`
- Test: `src/feishu-doc-service.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Add tests that expect helper-level behavior for:

```ts
await createFeishuDocByJid('feishu:review-chat', {
  title: 'feature/login 2026-03-27 10:00',
});

await populateFeishuDocByJid('feishu:review-chat', {
  documentId: 'doccn123',
  sections: [
    { kind: 'heading', level: 1, text: 'Overview' },
    { kind: 'paragraph', text: 'Summary' },
  ],
});

await resolveFeishuDocUrlByJid('feishu:review-chat', {
  documentId: 'doccn123',
});

await grantFeishuDocToChatByJid('feishu:review-chat', {
  documentId: 'doccn123',
  chatId: 'oc_review_chat',
  perm: 'edit',
});

await grantFeishuDocToUsersByJid('feishu:review-chat', {
  documentId: 'doccn123',
  batches: [['ou_1', 'ou_2'], ['ou_3']],
});
```

- [ ] **Step 2: Run the new helper tests and confirm they fail**

Run: `npx vitest run src/feishu-doc-service.test.ts`

Expected: FAIL because the helper functions and service test harness do not exist yet.

- [ ] **Step 3: Add Feishu doc helper functions in `src/channels/feishu.ts`**

Implement instance-resolved helpers with signatures like:

```ts
export async function createFeishuDocByJid(
  chatJid: string,
  input: { title: string; folderToken?: string },
): Promise<{ documentId: string; title: string }>;

export async function populateFeishuDocByJid(
  chatJid: string,
  input: { documentId: string; sections: FeishuDocSection[] },
): Promise<void>;

export async function resolveFeishuDocUrlByJid(
  chatJid: string,
  input: { documentId: string },
): Promise<string>;

export async function getFeishuChatContextByJid(
  chatJid: string,
): Promise<{ chatId: string; isGroup: boolean; participantOpenIds: string[] }>;
```

- [ ] **Step 4: Prefer authoritative Feishu chat metadata for conversation type and DM peer resolution**

Add helper logic that:

```ts
const chat = await client.im.chat.get({ path: { chat_id } });
const isGroup = chat.data?.chat_mode === 'group' || chat.data?.chat_type === 'group';
```

and only falls back to persisted participant metadata when live Feishu metadata is insufficient.
If live metadata is incomplete, fall back in this order:

```ts
1. authoritative Feishu chat/member metadata
2. recent Feishu sender metadata already captured from inbound events
3. persisted participant metadata
```

- [ ] **Step 5: Add batch permission helper support**

Implement helper wrappers around:

```ts
await client.drive.permissionMember.batchCreate({
  path: { token: documentId },
  params: { type: 'docx', need_notification: false },
  data: {
    members: openIds.map((memberId) => ({
      member_type: 'openid',
      member_id: memberId,
      perm: 'edit',
      type: 'user',
    })),
  },
});
```

and return structured batch results such as:

```ts
{
  authorizationStatus: 'partial',
  batches: [
    { batchIndex: 0, status: 'success', memberIds: ['ou_1', 'ou_2'] },
    { batchIndex: 1, status: 'failed', memberIds: ['ou_3'], error: 'rate limited' },
  ],
}
```

Also add explicit bounded batching and retry/backoff behavior, for example:

```ts
const FEISHU_PERMISSION_BATCH_SIZE = 20;
const FEISHU_PERMISSION_RETRY_LIMIT = 3;
const FEISHU_PERMISSION_RETRY_BACKOFF_MS = 500;
```

with tests that assert large member lists are split into bounded batches and retried on transient failures.

- [ ] **Step 6: Re-run the helper tests**

Run: `npx vitest run src/feishu-doc-service.test.ts`

Expected: helper-focused cases now pass or fail only on still-missing service orchestration assertions.

- [ ] **Step 7: Commit the helper layer**

```bash
git add src/channels/feishu.ts src/feishu-doc-service.test.ts
git commit -m "feat: add feishu cloud doc sdk helpers"
```

### Task 2: Add the Feishu Cloud-Doc Service

**Files:**
- Create: `src/feishu-doc-service.ts`
- Modify: `src/feishu-doc-service.test.ts`

- [ ] **Step 1: Write the failing orchestration tests**

Add service tests for:

```ts
expect(result.resultStatus).toBe('success');
expect(result.url).toBe('https://tenant.feishu.cn/docx/doccn123');
expect(result.conversationType).toBe('group');
expect(result.creationStatus).toBe('created');
expect(result.populationStatus).toBe('completed');
expect(result.authorizationStrategy).toBe('chat');
expect(result.authorizationStatus).toBe('complete');

expect(partial.resultStatus).toBe('success_with_authorization_warnings');
expect(partial.authorizationWarnings).toContain('chat grant failed; user fallback partially failed');
expect(partial.targetResults[0]?.status).toBe('failed');

expect(failed.resultStatus).toBe('content_population_failed');
```

- [ ] **Step 2: Run the service tests and confirm they fail**

Run: `npx vitest run src/feishu-doc-service.test.ts`

Expected: FAIL because `src/feishu-doc-service.ts` does not exist yet.

- [ ] **Step 3: Implement normalized request and result types**

Add types like:

```ts
export interface FeishuDocCreateRequest {
  chatJid: string;
  title: string;
  conversationType: 'group' | 'dm';
  sections: FeishuDocSection[];
  idempotencyKey?: string;
}

export interface FeishuDocCreateResult {
  documentId: string;
  url: string;
  title: string;
  conversationType: 'group' | 'dm';
  creationStatus: 'created' | 'failed';
  populationStatus: 'pending' | 'completed' | 'failed';
  resultStatus:
    | 'success'
    | 'success_with_authorization_warnings'
    | 'content_population_failed'
    | 'creation_failed'
    | 'url_resolution_failed';
  authorizationStrategy: 'chat' | 'users';
  authorizationStatus: 'complete' | 'partial' | 'failed' | 'skipped';
  authorizationWarnings: string[];
  targetResults: Array<{
    targetType: 'chat' | 'user';
    targetId: string;
    status: 'success' | 'failed';
    error?: string;
  }>;
}
```

- [ ] **Step 4: Implement the orchestration pipeline**

Sequence the service as:

```ts
const created = await createFeishuDocByJid(chatJid, { title });
await populateFeishuDocByJid(chatJid, {
  documentId: created.documentId,
  sections,
});
const url = await resolveFeishuDocUrlByJid(chatJid, {
  documentId: created.documentId,
});
const auth = await applyFeishuDocAuthorization(...);
return buildFeishuDocCreateResult(created, url, auth);
```

- [ ] **Step 5: Implement group-first authorization with batch fallback**

Use:

```ts
if (!conversationType) {
  throw new Error('Feishu conversation type is required');
}

try {
  await grantFeishuDocToChatByJid(...);
  return { authorizationStrategy: 'chat', authorizationStatus: 'complete' };
} catch (err) {
  const members = await getFeishuChatContextByJid(chatJid);
  return await grantFeishuDocToUsersByJid(chatJid, {
    documentId,
    openIds: members.participantOpenIds,
  });
}
```

- [ ] **Step 6: Add fail-closed and partial-grant coverage**

Add service tests for:

```ts
await expect(createFeishuCloudDoc({ conversationType: undefined as never, ... }))
  .rejects.toThrow('Feishu conversation type is required');

expect(partial.authorizationStatus).toBe('partial');
expect(partial.targetResults.some((entry) => entry.status === 'failed')).toBe(true);
```

- [ ] **Step 7: Re-run the service tests**

Run: `npx vitest run src/feishu-doc-service.test.ts`

Expected: PASS

- [ ] **Step 8: Commit the service**

```bash
git add src/feishu-doc-service.ts src/feishu-doc-service.test.ts
git commit -m "feat: add feishu cloud doc service"
```

### Task 3: Persist Repo-Review Cloud-Doc State

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

- [ ] **Step 1: Write the failing persistence tests**

Add tests proving repo-review runs can persist and reload:

```ts
cloud_doc_token: 'doccn123',
cloud_doc_url: 'https://tenant.feishu.cn/docx/doccn123',
cloud_doc_status: 'success',
cloud_doc_title: 'feature/login 2026-03-27 10:00',
```

- [ ] **Step 2: Run the DB tests and confirm they fail**

Run: `npx vitest run src/db.test.ts`

Expected: FAIL because the schema and record parsers do not include the new fields.

- [ ] **Step 3: Add schema migration and DAO fields**

Extend the repo-review run schema and parsers with fields such as:

```ts
cloud_doc_token TEXT,
cloud_doc_url TEXT,
cloud_doc_title TEXT,
cloud_doc_status TEXT,
cloud_doc_last_error TEXT,
```

- [ ] **Step 4: Update read/write helpers**

Update the corresponding insert/update/select helpers so:

```ts
updateReviewRun(runId, {
  cloud_doc_token: documentId,
  cloud_doc_url: url,
  cloud_doc_status: resultStatus,
});
```

round-trips correctly.

- [ ] **Step 5: Re-run the DB tests**

Run: `npx vitest run src/db.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the persistence changes**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: persist repo review feishu cloud doc state"
```

### Task 4: Render Repo-Review Detail Into Doc Sections

**Files:**
- Create: `src/repo-review-doc-render.ts`
- Create: `src/repo-review-doc-render.test.ts`
- Modify: `src/repo-review-service.ts`

- [ ] **Step 1: Write the failing renderer tests**

Add tests for a renderer API like:

```ts
const rendered = buildRepoReviewCloudDoc({
  repository,
  run,
  commitDetails,
});

expect(rendered.title).toBe('feature/login 2026-03-27 10:00');
expect(rendered.sections[0]).toEqual({
  kind: 'heading',
  level: 1,
  text: 'feature/login 2026-03-27 10:00',
});
expect(rendered.summaryLines).toContain('总体结论：fail');
expect(rendered.sections.some((section) => section.text?.includes('base sha'))).toBe(true);
expect(rendered.sections.some((section) => section.text?.includes('scope limitations'))).toBe(true);
expect(rendered.sections.some((section) => section.text?.includes('Suggested Next Actions'))).toBe(true);
```

- [ ] **Step 2: Run the renderer tests and confirm they fail**

Run: `npx vitest run src/repo-review-doc-render.test.ts`

Expected: FAIL because the renderer file does not exist.

- [ ] **Step 3: Implement the renderer**

Build deterministic sections such as:

```ts
[
  heading(1, title),
  paragraph(`仓库：${repository.name}`),
  paragraph(`分支：${run.branch}`),
  paragraph(`base sha：${run.baseSha}`),
  paragraph(`head sha：${run.headSha}`),
  paragraph(`触发来源：${run.source}`),
  paragraph(`审查时间：${run.completedAt || run.updatedAt}`),
  heading(2, 'Overview'),
  paragraph(run.summary),
  paragraph(`风险统计：高 ${highCount} / 中 ${mediumCount} / 低 ${lowCount}`),
  heading(2, 'Scope Limitations'),
  ...scopeLimitations,
  heading(2, 'Commits'),
  ...commitSections,
  heading(2, 'Findings'),
  ...findingSections,
  heading(2, 'Suggested Next Actions'),
  ...suggestionSections,
]
```

- [ ] **Step 4: Separate summary-message content from full-doc content**

Expose both:

```ts
export function buildRepoReviewSummaryMessage(...)
export function buildRepoReviewCloudDoc(...)
```

so summary delivery stays short.

- [ ] **Step 5: Re-run the renderer tests**

Run: `npx vitest run src/repo-review-doc-render.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the renderer**

```bash
git add src/repo-review-doc-render.ts src/repo-review-doc-render.test.ts src/repo-review-service.ts
git commit -m "feat: render repo review feishu cloud docs"
```

### Task 5: Integrate Repo Review With Cloud-Doc Creation

**Files:**
- Modify: `src/repo-review-service.ts`
- Modify: `src/repo-review-service.test.ts`

- [ ] **Step 1: Write the failing repo-review integration tests**

Add tests covering:

```ts
expect(run.cloudDocUrl).toContain('/docx/');
expect(sentMessage.text).toContain('完整 CR 云文档');
expect(sentMessage.text).not.toContain(longFindingDetail);
expect(run.cloudDocToken).toBe('doccn123');

expect(fallbackRun.cloudDocStatus).toBe('content_population_failed');
expect(fallbackMessage.text).not.toContain('完整 CR 云文档');
```

- [ ] **Step 2: Run the repo-review tests and confirm they fail**

Run: `npx vitest run src/repo-review-service.test.ts`

Expected: FAIL because repo review does not yet create or persist cloud docs.

- [ ] **Step 3: Insert the cloud-doc path into the review completion flow**

Integrate roughly as:

```ts
if (reviewChatJid.startsWith('feishu:')) {
  const created = await prepareFeishuCloudDoc({
    chatJid: reviewChatJid,
    title: rendered.title,
    conversationType,
  });
  await updateReviewRun(run.id, {
    cloud_doc_token: created.documentId,
    cloud_doc_title: rendered.title,
    cloud_doc_status: 'created',
  });

  const rendered = buildRepoReviewCloudDoc(...);
  const docResult = await continueFeishuCloudDocProvision({
    chatJid: reviewChatJid,
    documentId: created.documentId,
    conversationType,
    sections: rendered.sections,
    idempotencyKey: run.id,
  });
  await updateReviewRun(run.id, mapDocResultToRunFields(docResult));
}
```

- [ ] **Step 4: Use persisted doc state for retry-safe delivery**

Before creating a new document, check whether the current run already has a saved token:

```ts
if (run.cloud_doc_token) {
  return continueFeishuCloudDocProvision({
    chatJid: reviewChatJid,
    documentId: run.cloud_doc_token,
    conversationType,
    sections: rendered.sections,
    idempotencyKey: run.id,
  });
}
```

- [ ] **Step 5: Send summary messages with doc links only when appropriate**

Use the renderer summary helper and gate link inclusion by:

```ts
const canLinkDoc =
  docResult.resultStatus === 'success' ||
  docResult.resultStatus === 'success_with_authorization_warnings';
```

When `docResult.resultStatus === 'success_with_authorization_warnings'`, append an explicit summary note such as:

```ts
'云文档已生成，但飞书授权可能不完整，请检查访问权限。'
```

- [ ] **Step 6: Re-run the repo-review tests**

Run: `npx vitest run src/repo-review-service.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the repo-review integration**

```bash
git add src/repo-review-service.ts src/repo-review-service.test.ts
git commit -m "feat: publish repo review results to feishu cloud docs"
```

### Task 6: Add Model-Facing Conversation Feishu Cloud-Doc Actions

**Files:**
- Modify: `src/routes/conversation-admin-routes.ts`
- Modify: `src/conversation-admin-routes.test.ts`
- Modify: `src/web-server.ts`
- Modify: `agent/runner/src/ipc-mcp-stdio.ts`
- Create: `agent/runner/src/ipc-mcp-stdio.test.ts`

- [ ] **Step 1: Write the failing conversation route tests**

Add a route test for:

```ts
POST /api/conversations/:jid/feishu-docs
{
  "title": "排查记录",
  "contentMode": "recent_transcript",
  "text": "请整理成云文档",
  "sections": [
    { "kind": "heading", "level": 1, "text": "排查记录" },
    { "kind": "paragraph", "text": "结论..." }
  ]
}
```

Expected response shape:

```ts
{
  ok: true,
  documentId: 'doccn123',
  url: 'https://tenant.feishu.cn/docx/doccn123',
  resultStatus: 'success'
}
```

- [ ] **Step 2: Run the route tests and confirm they fail**

Run: `npx vitest run src/conversation-admin-routes.test.ts`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Add a backend conversation action route**

Implement a route that:

```ts
app.post('/api/conversations/:jid/feishu-docs', async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const sections =
    req.body?.sections?.length > 0
      ? normalizeConversationDocSections(req.body.sections)
      : await buildConversationDocSectionsFromRecentTranscript(jid, 200, req.body?.text);
  const result = await createFeishuCloudDoc({
    chatJid: jid,
    title: req.body?.title || defaultConversationDocTitle(...),
    conversationType: await resolveConversationType(jid),
    sections,
  });
  res.json({ ok: true, ...result });
});
```

Add an explicit rejection path and test for non-Feishu conversations:

```ts
expect(response.status).toBe(400);
expect(await response.json()).toEqual({
  error: 'Feishu cloud docs are only supported for feishu conversations',
});
```

- [ ] **Step 4: Wire the route in `src/web-server.ts`**

Pass any required route dependencies explicitly through the existing `registerConversationAdminRoutes(...)` call site in `src/web-server.ts`.

- [ ] **Step 5: Write the failing MCP tool tests**

Add tests that expect an MCP tool like:

```ts
create_feishu_cloud_doc({
  title: '排查记录',
  text: '把今天的讨论整理成云文档',
});

create_feishu_cloud_doc({
  title: 'CR 明细',
  sections: [
    { kind: 'heading', level: 1, text: 'Overview' },
    { kind: 'paragraph', text: 'Summary' },
  ],
});
```

to call the internal API route for the current `chatJid`.

- [ ] **Step 6: Run the MCP tool tests and confirm they fail**

Run: `npx vitest run agent/runner/src/ipc-mcp-stdio.test.ts`

Expected: FAIL because the tool does not exist yet.

- [ ] **Step 7: Add a model-facing MCP tool in `agent/runner/src/ipc-mcp-stdio.ts`**

Register a tool like:

```ts
server.tool(
  'create_feishu_cloud_doc',
  'Create a Feishu cloud doc for the current Feishu conversation using either plain text or structured sections.',
  {
    title: z.string().optional(),
    text: z.string().optional(),
    sections: z.array(z.object({
      kind: z.enum(['heading', 'paragraph', 'code']),
      level: z.number().int().min(1).max(3).optional(),
      text: z.string(),
    })).optional(),
  },
  async (args) => {
    return textResult(await callInternalApi('/api/conversations/.../feishu-docs', ...));
  },
);
```

- [ ] **Step 8: Re-run the route and MCP tool tests**

Run:

```bash
npx vitest run src/conversation-admin-routes.test.ts agent/runner/src/ipc-mcp-stdio.test.ts
```

Expected: PASS

- [ ] **Step 9: Commit the conversation integration**

```bash
git add src/routes/conversation-admin-routes.ts src/conversation-admin-routes.test.ts src/web-server.ts agent/runner/src/ipc-mcp-stdio.ts agent/runner/src/ipc-mcp-stdio.test.ts
git commit -m "feat: add model-facing feishu cloud doc actions"
```

### Task 7: Run Verification and Real Validation

**Files:**
- Verify only

- [ ] **Step 1: Run targeted unit and integration tests**

Run:

```bash
npx vitest run src/feishu-doc-service.test.ts src/repo-review-doc-render.test.ts src/repo-review-service.test.ts src/conversation-admin-routes.test.ts agent/runner/src/ipc-mcp-stdio.test.ts src/db.test.ts
```

Expected: PASS

- [ ] **Step 2: Run the backend build**

Run: `npm run build`

Expected: PASS

- [ ] **Step 3: Exercise the configured Git-Review / repo-review instance**

Validate end-to-end:

```text
1. Trigger a real repo review against a Feishu review chat.
2. Confirm the summary message is short and includes the cloud-doc link.
3. Open the cloud doc and confirm it contains the full CR detail.
4. Verify group-chat users can open and edit.
```

- [ ] **Step 4: Exercise Feishu DM chat creation**

Validate:

```text
1. Ask for a cloud doc explicitly in a Feishu DM.
2. Confirm the document is created from recent conversation transcript.
3. Confirm only the DM counterpart gets edit access.
```

- [ ] **Step 5: Summarize any remaining gaps**

Document exactly:

```text
- any Feishu tenant permission constraints
- any docx block-formatting limitations
- any model-facing tool contract constraints intentionally supported in V1
```

- [ ] **Step 6: Commit verification-related fixes if needed**

```bash
git add <targeted files>
git commit -m "fix: address feishu cloud doc verification gaps"
```
