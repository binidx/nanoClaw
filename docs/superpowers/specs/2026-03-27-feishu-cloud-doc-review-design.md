# Feishu Cloud Doc Review Design

**Goal:** Add a reusable Feishu cloud-document capability that lets NanoClaw create Feishu docx documents, grant access based on the current Feishu conversation, and use that capability first for repo review so review runs publish a short Feishu summary plus a full cloud document with detailed CR results.

**Scope:** This design covers backend capability, repo review integration, chat-triggered document creation, authorization behavior for Feishu group chats and DMs, document structure, failure handling, and verification. It does not redesign the frontend review workspace, auth model, or non-Feishu channels.

## Context

NanoClaw already has a Feishu channel adapter in `src/channels/feishu.ts` and can:

- send Feishu messages
- detect Feishu conversations via `feishu:` JIDs
- query group members with `client.im.chatMembers.get(...)`
- persist conversation participants from message events and API refresh

Repo review already publishes review summaries into a configured review chat and already knows how to resolve review chat members for mention mapping. What is missing is a product-level capability for:

- creating Feishu cloud documents
- granting access from the active conversation context
- publishing detailed code-review results into a document instead of overloading the summary message
- reusing the same capability from repo review and ordinary chat flows

## Requirements

### Functional Requirements

1. NanoClaw must be able to create a Feishu `docx` document through the existing Feishu app instance that owns the target `chatJid`.
2. For Feishu group chats, NanoClaw must try to grant `edit` permission to the whole chat first using the chat identity.
3. If whole-chat authorization fails, NanoClaw must fall back to granting `edit` permission to group members individually.
4. For Feishu DMs, NanoClaw must grant `edit` permission to the current DM counterpart only.
5. Repo review must publish:
   - a short Feishu summary message
   - a link to the generated cloud document
   - the complete detailed review in the cloud document
6. The repo review cloud document title must use `branch + review time`.
7. The detailed review document must include:
   - repository / branch / baseline metadata
   - overall verdict and summary
   - risk counts
   - commit-by-commit sections
   - issue entries with file path, explanation, code snippet, and recommended fix
   - scope limitations
8. Chat flows must be able to invoke the same cloud-document capability when the model decides the user explicitly wants a Feishu cloud document.

### Non-Functional Requirements

- The cloud-document capability must be reusable and not be hard-coded into repo review only.
- Failures in cloud-document creation must not erase the review result; repo review must still publish a fallback summary message.
- The design must preserve existing Feishu message delivery and repo review behavior when the new document flow is disabled or fails.
- The capability must stay instance-scoped so multi-instance Feishu configurations do not cross wires.

## Architecture

The implementation will introduce a dedicated Feishu cloud-document service and keep transport-specific Feishu SDK access in the existing Feishu channel adapter.

### Layering

1. `src/channels/feishu.ts`
   Owns Feishu instance resolution and direct SDK calls. This layer will expose reusable helpers for:
   - creating a `docx` document
   - granting drive permissions to a chat
   - granting drive permissions to users
   - resolving the DM counterpart from a Feishu conversation context
   - listing group members by `chatJid` using the existing logic

2. `src/feishu-doc-service.ts`
   Owns orchestration and business rules. This service will:
   - accept a normalized document creation request
   - generate or accept a document title
   - create the document
   - populate the document content before treating the operation as success
   - resolve the document URL after creation
   - choose the authorization strategy from the conversation type
   - apply group-first authorization with user fallback
   - return a normalized result structure with document IDs, URL, authorization details, and errors

3. `src/repo-review-service.ts`
   Owns review content assembly, not Feishu SDK details. It will:
   - produce a structured review-document model
   - render summary-message content separately from full document content
   - call `feishu-doc-service` when the review chat is a Feishu chat
   - include the cloud-doc link in the final review summary message

4. Chat runtime integration
   A chat-triggered action path will call the same `feishu-doc-service` so the capability behaves like a product feature the model can invoke, not a one-off repo review special case.

## Detailed Behavior

### Feishu Document Creation

NanoClaw will use the official Feishu SDK surfaces already present in `@larksuiteoapi/node-sdk`:

- `client.docx.document.create(...)` for creating the document
- `client.docx.documentBlockChildren.create(...)` and related block APIs for writing structured content into the document
- `client.drive.permissionMember.create(...)` or `batchCreate(...)` for access grants
- `client.drive.meta.batchQuery(...)` with `with_url: true` for resolving the final document URL

The service will treat the created `document_id` as the Drive token for `type: 'docx'`.

### Required Creation Pipeline

The cloud-document operation is only fully successful when all of these stages complete:

1. create the Feishu `docx` document
2. populate the document with the requested content
3. resolve the final URL
4. complete authorization without warnings

This design explicitly forbids treating an empty document as success.

If steps 1 to 3 succeed but authorization is only partial, the operation must return a distinct partial-success result rather than the same success contract as a fully authorized document.

If content population fails after document creation, the operation must return a distinct `content_population_failed` result so callers can:

- avoid publishing a blank-document success message
- fall back to repo review summary-only behavior
- report the failure clearly in chat-triggered flows

### Authorization Rules

#### Group Chat

Authorization strategy must not be inferred from `chatJid` alone. The request into `feishu-doc-service` must include `conversationType` or `isGroup`, resolved from fresh conversation metadata or live Feishu chat lookup. If the conversation type cannot be determined confidently, the service must fail closed instead of defaulting to DM behavior.

Given a `feishu:` group JID with `conversationType = group`:

1. Resolve the owning Feishu instance.
2. Attempt `drive.permissionMember.create` with:
   - `member_type: 'openchat'`
   - `member_id: <chat_id>`
   - `perm: 'edit'`
   - `type: 'chat'`
   - `params.type: 'docx'`
3. If that succeeds, treat authorization as complete.
4. If it fails due to API or tenant restrictions, log the failure and fall back to:
   - list group members with the existing group-member API
   - grant members in batches using `drive.permissionMember.batchCreate(...)`
   - use bounded batch size, retry/backoff, and per-batch failure reporting
5. Record per-member or per-batch failures in the returned result so callers can surface partial authorization clearly.

#### DM

Given a Feishu DM JID with `conversationType = dm`:

1. Resolve the owning Feishu instance.
2. Resolve the DM counterpart user from persisted participant data and/or recent Feishu sender metadata.
   The resolution path must prefer authoritative Feishu chat/member metadata for the DM when available, with persisted participants and recent sender metadata used only as fallback.
3. Grant `edit` to that user with:
   - `member_type: 'openid'`
   - `member_id: <counterpart_open_id>`
   - `perm: 'edit'`
   - `type: 'user'`
   - `params.type: 'docx'`
4. If the counterpart cannot be resolved reliably, fail clearly and do not silently authorize the wrong user.

### Document Population

Repo review and chat-triggered document creation both depend on a required document-population step after `docx` creation.

The first implementation should render a deterministic section model into Feishu `docx` blocks using the official block APIs. The system should not rely on free-form chat text pasted as a best-effort side effect.

The population layer must:

- render headings, paragraphs, and code-snippet sections in a stable order
- write the full review content before the document link is published as success
- return a structured population result with success/failure details

If population fails:

- the service returns `content_population_failed`
- repo review sends only the fallback summary message
- chat-triggered flows report the error instead of claiming the document is ready

### Repo Review Output

Repo review will produce two distinct artifacts:

1. A short Feishu summary message
2. A full Feishu cloud document

The summary message stays optimized for chat scanning:

- repository and branch
- overall verdict
- high / medium / low counts
- 1 to 3 most important findings
- cloud document link

The cloud document becomes the canonical detailed CR record. Its structure will be:

1. Header
   - title: `<branch> <review time>`
   - repository, branch, baseline, head/base SHA, trigger source, review time

2. Overview
   - overall verdict
   - one-paragraph summary
   - risk counts
   - recommended block / pass guidance
   - impacted areas
   - scope limitations

3. Commit Sections
   - one section per commit
   - commit SHA, title, author
   - positives
   - risks
   - links to related issue entries by anchor or numbering

4. Findings
   - severity
   - file path
   - finding title
   - risk explanation
   - code snippet with minimal useful context
   - recommended fix

5. Suggested Next Actions
   - must-fix items
   - follow-up improvements

The review summary message must only be sent with a cloud-doc link when document creation, population, and URL resolution all succeed.

### Chat-Triggered Document Creation

The same capability must be invokable outside repo review when the user explicitly asks to create a Feishu cloud document. This path should:

- only run when the active conversation is a Feishu conversation
- accept either:
  - raw text that will be normalized into paragraphs, or
  - a structured content model assembled from tool results
- create and authorize the document using the same group or DM rules
- reply in chat with:
  - success plus link, or
  - partial authorization warning plus link, or
  - explicit failure reason

This should be implemented as a backend action/tool surface, not as prompt-only behavior.

For V1, chat-triggered creation should not accept arbitrary markdown rendering. It should support:

- plain paragraphs
- explicit section headings from the structured content model
- code blocks only when the caller supplies structured snippet sections

Free-form markdown support can be added later as a separate enhancement.

### Large Document Handling

The user requirement for repo review is to keep the detailed review complete in the cloud document. V1 therefore must not intentionally drop commits, findings, or snippet sections for size reasons.

If Feishu write limits require incremental writes, the implementation should chunk the write process operationally while preserving the full rendered content semantically. That means:

- no deliberate truncation of findings or commit sections
- no summary-only fallback when content is merely large
- retries and chunked block insertion are acceptable as long as the final document remains complete

If a review is too large to render successfully even with chunked writes, the operation should fail clearly as a document-population error rather than silently publishing an incomplete review.

## Error Handling

### Creation Failure

If document creation fails:

- return a hard failure from `feishu-doc-service`
- repo review still sends the fallback summary message without a cloud-doc link
- chat-triggered flows reply with the error and do not claim success

### Content Population Failure

If document creation succeeds but writing the content fails:

- return `content_population_failed`
- repo review still sends the fallback summary message without a cloud-doc link
- chat-triggered flows report that the document was not successfully prepared
- the implementation may optionally include cleanup of the empty document, but callers must not assume cleanup succeeded

### URL Resolution Failure

If the document is created and populated but URL resolution fails:

- use `drive.meta.batchQuery(...)` with `with_url: true` as the required resolution step
- treat the operation as incomplete for user-facing success messaging
- repo review falls back to summary-only delivery
- chat-triggered flows report that the document exists but the share link could not be resolved

### Authorization Failure

If creation succeeds but authorization is incomplete:

- return `success_with_authorization_warnings` with detailed authorization results
- repo review still sends the summary with the document link plus a note that access may be incomplete
- chat-triggered flows explicitly report that the document exists but some grants failed

### Idempotency and Retry Behavior

Document creation must be idempotent at the caller level.

For repo review, the system must use a stable key of one cloud document per review run. Retries of summary delivery, authorization, or URL resolution must reuse the same created document when one already exists for that run instead of creating duplicates.

For chat-triggered flows, the initial V1 behavior may remain per-request, but retries inside a single request execution must reuse the same in-flight or already-created document record.

### Multi-Instance Feishu Safety

All operations must resolve the Feishu instance from the `chatJid`. The system must not:

- create documents with a different Feishu instance than the active conversation
- mix default-instance and explicit-instance JIDs
- infer authorization targets across instances

## Data Model

The first version does not require a large new generic document-history schema, but repo-review idempotency does require durable storage of the created Feishu document identity on the review run or an equivalent persisted record.

For V1, the service result should still expose:

- `documentId`
- `url`
- `title`
- `conversationType`
- `creationStatus`
- `populationStatus`
- `resultStatus`
- `authorizationStrategy`
- `authorizationStatus`
- `authorizationWarnings`
- per-target grant results

Repo review must persist the created document token and resolved URL on the review run or an equivalent durable record before any retryable post-create step can run again. This persistence point is required for repo-review idempotency.

## Testing Strategy

### Unit Tests

- Feishu channel helper tests for document creation and permission payloads
- authorization-strategy tests:
  - group chat uses `openchat` first
  - group fallback grants users in batches on failure
  - DM grants the resolved counterpart only
- conversation-type resolution tests that fail closed when type is unknown
- content-population tests that ensure an empty document is not treated as success
- URL-resolution tests using Drive meta lookup
- title-format tests for `branch + review time`
- renderer tests for repo review document sections and snippet formatting

### Repo Review Integration Tests

- successful review creates cloud doc and summary link
- document content includes commit sections and finding sections
- summary stays concise
- document-creation failure still leaves fallback summary behavior intact
- partial authorization is surfaced as warning, not silent success

### Chat Flow Tests

- explicit cloud-doc request in a Feishu group chat creates and authorizes a document
- explicit cloud-doc request in a Feishu DM grants only the counterpart
- non-Feishu chats reject this capability clearly

### Real Verification

Use the configured Git-Review / repo review instance to validate:

- a real repo review run publishes summary plus cloud-doc link
- the produced cloud doc is accessible from the target Feishu conversation
- group chat authorization works at chat scope when allowed and falls back correctly when not
- DM authorization grants the intended user

## Out of Scope

- redesigning the repo review frontend UI
- generic support for non-Feishu document providers
- changing the core review result schema beyond what is needed to attach a cloud-doc link
- rich bidirectional sync from edited Feishu docs back into NanoClaw

## Open Implementation Notes

- The service should prefer small, deterministic helpers over embedding large document-generation logic directly in `repo-review-service.ts`.
- Code snippets in the document should stay minimal and useful rather than dumping entire diffs.
- The first release should prioritize repo review integration, but the service contract must be reusable from chat flows immediately after.
