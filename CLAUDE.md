# NanoClaw

Quick repo context for collaborators working inside this codebase.

## Agent Workflow

For shared harness rules, read [docs/agent-harness.md](docs/agent-harness.md).

For Claude-specific repo entry guidance, read [.claude/README.md](.claude/README.md).

## Product Shape

NanoClaw is currently a local AI control console with:

- a Node.js backend in `src/` (362 files)
- a React frontend in `web/src/` (18+ pages)
- a bundled local agent runner in `agent/runner/` (35 files)
- built-in channel adapters in `src/channels/` (9 modules)
- 46 HTTP route modules in `src/routes/`
- Database persistence (SQLite / MySQL / PostgreSQL) via `src/database/`

The current product is managed mainly through the web UI, not through a docs-described "skills-only shell".

## Entry Points

- `src/index.ts`: runtime bootstrap and orchestration
- `src/web/web-server.ts`: API, auth, WebSocket, uploads, tasks, settings, terminal, extensions
- `web/src/App.tsx`: frontend state and event wiring
- `src/db.ts`: persistence contracts
- `src/agent/agent-runner.ts`: local agent execution

## Current Feature Areas

- Multi-channel conversations (Web, Feishu, Telegram, Discord, Slack, Gmail, WhatsApp)
- Internal IM messaging (friend/group conversations, messages)
- Web chat and real-time updates
- Scheduled tasks (once, interval, cron)
- Provider management
- Managed MCP servers
- Managed skills and custom skill creation
- Knowledge bases with FTS-first hybrid search (FTS + optional vector), multi-tenant isolation, and jieba/zhparser CJK tokenization
- Optional login and optional browser terminal
- Per-conversation allowed directory access
- Code index and CodeMap
- Repo Review with digest generation
- Stock analysis
- Workflow Workbench (multi-agent orchestration)
- Long-term memory with hybrid retrieval
- Soul system (AI personality and memory)
- Live2D companion
- Browser CDP automation

## Docs To Trust

- `README.md` (English)
- `README_zh.md` (Chinese)
- `docs/文档索引.md`
- `docs/系统概览.md`
- `docs/快速开始.md`
- `docs/后端运行时与服务架构.md`
- `docs/运行与运维.md`
- `docs/安全模型.md`
- `docs/排障清单.md`

If code and docs disagree, update the docs in the same change.
