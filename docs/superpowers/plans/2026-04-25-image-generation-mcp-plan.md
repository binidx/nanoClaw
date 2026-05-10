# Image Generation MCP Integration Plan

> Goal: add a Node-based stdio MCP server for image generation that works with OpenAI-compatible APIs, keeps credentials in MCP env or assistant-bound secrets, and avoids hard-binding NanoClaw to a single vendor.

**Architecture:** Reuse NanoClaw's existing MCP template, user MCP, assistant binding, and assistant secret plumbing. Implement one shared image-generation MCP template backed by a Node stdio server. The server talks to any OpenAI-compatible Images API through `base_url + api_key + model`, writes PNG outputs into the current workspace, and returns structured file-path results to the agent.

**Tech Stack:** Node.js, TypeScript, `@modelcontextprotocol/sdk`, existing NanoClaw assistant MCP binding system, existing agent runner stdio MCP execution path

---

## Summary

The first version should not add a NanoClaw-native "image provider" abstraction in app code. That is a bigger product surface and is unnecessary for the user's current goal.

Instead, implement a repo-managed MCP template named `image-openai-compatible`:

1. The MCP server runs in `stdio` mode using Node.
2. It exposes a single tool: `generate_image`.
3. It supports exactly three user-facing parameters:
   - `prompt`
   - `n`
   - `size`
4. It reads provider configuration from MCP env:
   - `IMAGE_API_BASE_URL`
   - `IMAGE_API_KEY`
   - `IMAGE_MODEL`
5. It calls an OpenAI-compatible Images API endpoint, decodes `b64_json`, saves PNG files under the active workspace, and returns structured paths plus model metadata.
6. Assistant-bound private secrets override template env, reusing the existing assistant MCP secret flow already present in NanoClaw.

This gives a fast, safe path that is flexible enough for:

- OpenAI official API
- aggregation gateways exposing OpenAI-compatible images endpoints
- local deployments that mimic the same API contract

## Why This Shape

NanoClaw already has most of the required substrate:

- managed MCP templates are loaded and injected into the runner
- user-level MCP servers can be stored and hydrated from DB
- assistant MCP bindings support per-binding secret env
- agent runner already launches external MCP tools over `stdio`

The missing piece is therefore not a new extension framework. The missing piece is one concrete MCP template plus one concrete stdio server implementation.

This plan intentionally avoids using a `skill` as the primary execution layer because:

- skills are prompt-time guidance, not a stable tool contract
- parameter validation is weaker
- credentials are harder to manage safely
- service swapping becomes messy once multiple image backends are involved

## Public Interfaces

### 1. Managed MCP template

Add one managed/shared MCP template:

- `id`: `image-openai-compatible`
- `name`: `Image Generation`
- `command`: Node executable
- `args`: path to the compiled MCP server entrypoint
- `env` keys present in template:
  - `IMAGE_API_BASE_URL`
  - `IMAGE_API_KEY`
  - `IMAGE_MODEL`
  - `IMAGE_OUTPUT_DIR`

Template defaults:

- `IMAGE_API_BASE_URL`: empty in shared template
- `IMAGE_API_KEY`: empty in shared template
- `IMAGE_MODEL`: `gpt-image-1`
- `IMAGE_OUTPUT_DIR`: `.nanoclaw/generated-images`

The template env is only a fallback. Real credentials should normally be provided through assistant binding secrets.

### 2. MCP tool schema

Expose a single tool:

- `generate_image`

Input schema:

```json
{
  "type": "object",
  "properties": {
    "prompt": { "type": "string", "minLength": 1 },
    "n": { "type": "integer", "minimum": 1, "maximum": 4, "default": 1 },
    "size": {
      "type": "string",
      "enum": ["512x512", "1024x1024", "1536x1024", "1024x1536"],
      "default": "1024x1024"
    }
  },
  "required": ["prompt"],
  "additionalProperties": false
}
```

Server-side fixed behavior:

- `quality`: fixed default inside the server, not user-configurable in v1
- `output_format`: always `png`
- response parsing: consume `data[].b64_json`

### 3. MCP tool result shape

Return both human-readable text and structured content. Structured result should include:

```json
{
  "ok": true,
  "provider": {
    "baseUrl": "https://example.com/v1",
    "model": "gpt-image-1"
  },
  "images": [
    {
      "path": "/workspace/group/.nanoclaw/generated-images/2026-04-25/img-001.png",
      "mimeType": "image/png",
      "size": "1024x1024"
    }
  ]
}
```

On failure:

```json
{
  "ok": false,
  "error": {
    "code": "auth_failed | invalid_request | rate_limited | upstream_unavailable | network_error | invalid_response",
    "message": "human-readable summary"
  }
}
```

Do not include `api_key` or raw upstream auth details in tool output or logs.

## File Structure

**Create:**

- `src/mcp/image-openai-compatible-server.ts`
  Node stdio MCP server implementation with one `generate_image` tool.
- `src/mcp/image-openai-compatible-server.test.ts`
  Tool schema, request mapping, output path, error mapping, and response parsing tests.
- `docs/superpowers/plans/2026-04-25-image-generation-mcp-plan.md`
  This plan document.

**Modify:**

- `src/runtime-customization.ts`
  Register the shared managed MCP template metadata for `image-openai-compatible`.
- `src/assistant-mcp.ts`
  Reuse existing assistant binding resolution for the new template and document the expected env keys.
- `src/routes/assistant-routes.ts`
  No new secret API shape. Only ensure the new template appears with correct `templateEnvKeys`.
- `src/agent-runner-spawn.ts`
  Keep current stdio spawn model. Only adjust if the image MCP server needs an explicit safe cwd or additional inherited env handling.
- `src/codex-mcp-tools.test.ts`
  Add regression coverage ensuring the new managed MCP server is surfaced and callable.
- `README.md`
  Add one short capability note for image-generation MCP support and the OpenAI-compatible configuration model.

**Reference:**

- `src/user-mcp-service.ts`
- `src/routes/user-mcp-routes.ts`
- `src/routes/assistant-routes.ts`
- `src/assistant-mcp.ts`
- `src/agent-runner-spawn.ts`
- `agent/runner/src/codex-mcp-tools.ts`

## Implementation Plan

### Task 1: Add the stdio MCP server

**Files:**
- Create: `src/mcp/image-openai-compatible-server.ts`
- Create: `src/mcp/image-openai-compatible-server.test.ts`

- [ ] Implement a Node stdio MCP server using `@modelcontextprotocol/sdk`.
- [ ] Register one tool named `generate_image`.
- [ ] Validate inputs with the exact v1 contract:
  - `prompt` required
  - `n` range `1-4`
  - `size` limited to the approved whitelist
- [ ] Read env at runtime:
  - `IMAGE_API_BASE_URL`
  - `IMAGE_API_KEY`
  - `IMAGE_MODEL`
  - `IMAGE_OUTPUT_DIR`
- [ ] Normalize `base_url` so both `https://host` and `https://host/v1` work.
- [ ] Call the OpenAI-compatible Images API endpoint.
- [ ] Decode `b64_json` into binary PNG output.
- [ ] Save generated files under `path.resolve(process.cwd(), IMAGE_OUTPUT_DIR)` so the output lands inside the active workspace.
- [ ] Use stable filenames such as `YYYYMMDD-HHMMSS-001.png`.
- [ ] Return both text content and structured result payload.

### Task 2: Register it as a managed MCP template

**Files:**
- Modify: `src/runtime-customization.ts`
- Modify: `src/assistant-mcp.ts`

- [ ] Add a shared MCP template `image-openai-compatible`.
- [ ] Point the template command to the Node executable and the built output entrypoint under `dist/`.
- [ ] Set template env keys without embedding real secrets.
- [ ] Ensure assistant binding views expose:
  - `IMAGE_API_BASE_URL`
  - `IMAGE_API_KEY`
  - `IMAGE_MODEL`
  - `IMAGE_OUTPUT_DIR`
- [ ] Keep current precedence unchanged:
  - assistant binding secret env overrides template env
  - template env remains fallback only

### Task 3: Keep credentials in the existing secret flow

**Files:**
- Modify: `src/routes/assistant-routes.ts`
- Test: `src/assistant-routes.test.ts`
- Test: `src/assistant-runtime.test.ts`

- [ ] Reuse the current assistant secret endpoints; do not add a new credentials API.
- [ ] Add regression coverage that `IMAGE_API_KEY` can be stored as an assistant binding secret and overrides template fallback.
- [ ] Add regression coverage that non-secret values such as `IMAGE_MODEL` or `IMAGE_OUTPUT_DIR` can remain in template env when appropriate.
- [ ] Ensure non-manager viewers cannot read configured secret values.

### Task 4: Make the execution path reliable in the runner

**Files:**
- Modify: `src/agent-runner-spawn.ts`
- Modify: `src/codex-mcp-tools.test.ts`

- [ ] Confirm the managed MCP template is serialized into `NANOCLAW_EXTRA_MCP_SERVERS`.
- [ ] Keep stdio transport unchanged unless testing shows the external MCP env needs inherited safe defaults.
- [ ] Ensure the server runs with a workspace cwd so relative output paths land in mounted space visible to the agent.
- [ ] If required, explicitly preserve minimal inherited env needed for Node execution without leaking unrelated secrets.

### Task 5: Document usage and operator workflow

**Files:**
- Modify: `README.md`

- [ ] Document the intended setup flow:
  - enable the `image-openai-compatible` MCP template
  - bind it to an assistant
  - save assistant-specific secrets
  - call `generate_image` from the agent
- [ ] Document supported parameters for v1:
  - `prompt`
  - `n`
  - `size`
- [ ] Document the supported backend shape:
  - any OpenAI-compatible Images API
- [ ] Document output location behavior:
  - files are written under the current workspace
  - result returns local file paths

## Testing and Verification

### Unit and integration coverage

- [ ] `src/mcp/image-openai-compatible-server.test.ts`
  - validates schema rejection for invalid `n`
  - validates schema rejection for invalid `size`
  - verifies request mapping to upstream body
  - verifies `b64_json` decoding and PNG file output
  - verifies stable result payload structure
  - verifies upstream error mapping to internal error codes
- [ ] `src/assistant-runtime.test.ts`
  - verifies assistant private secrets override template env for image MCP bindings
- [ ] `src/assistant-routes.test.ts`
  - verifies secret status and key counts for the new binding
- [ ] `src/codex-mcp-tools.test.ts`
  - verifies the new MCP template is exposed through the runner path

### Manual verification

- [ ] Bind the new MCP template to a test assistant.
- [ ] Save `IMAGE_API_BASE_URL`, `IMAGE_API_KEY`, and `IMAGE_MODEL` through assistant MCP secrets.
- [ ] Ask the assistant to generate one image with default `n` and `size`.
- [ ] Confirm the returned path points to a readable PNG under the workspace.
- [ ] Ask for `n=2` and confirm multiple files are saved.
- [ ] Test one invalid `size` and confirm the tool fails locally before any upstream call.
- [ ] Test one upstream auth failure and confirm the tool returns a sanitized error.

### Build and test commands

- [ ] Run `npm run build`
- [ ] Run targeted tests:
  - `npx vitest run src/mcp/image-openai-compatible-server.test.ts src/assistant-runtime.test.ts src/assistant-routes.test.ts src/codex-mcp-tools.test.ts`

## Explicit Decisions

- The implementation target is a **Node stdio MCP server**, not a skill-only wrapper.
- The first backend contract is **OpenAI-compatible Images API**, not an OpenAI-only SDK abstraction.
- The first version supports only:
  - `prompt`
  - `n`
  - `size`
- `quality` is intentionally fixed server-side in v1.
- Outputs are returned as **workspace file paths**, not uploaded chat attachments in v1.
- Credentials live in **assistant MCP binding secrets** or MCP env, never inside skill text or committed config.
- The new capability is delivered as a **managed MCP template** so it can be rebound per assistant without duplicating code.

## Non-Goals

- Do not build a generic multi-vendor image-provider framework in app code yet.
- Do not add a new frontend image-generation page in this change.
- Do not add negative prompts, masks, edit mode, reference images, or seed controls in v1.
- Do not auto-upload generated images into the conversation attachment pipeline in v1.
- Do not embed real credentials into repo-managed template defaults.
