# NanoClaw

> A local-first AI workstation and control console

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)](https://www.typescriptlang.org/)

## Overview

NanoClaw is a **local-first AI workstation** that integrates a Node.js backend, React web console, session-level Agent runtime, multi-database persistence (SQLite / MySQL / PostgreSQL), multi-channel messaging, task scheduling, code review, knowledge base, memory system, user permissions, MCP server management, and browser automation — all in one system.

It's not just a chat shell. It's a control console organized around local directories, Git repositories, browser automation, and multi-class workflow automation.

## ✨ Features

### Communication & Chat
- **Multi-channel support**: Web, Feishu (Lark), Telegram, Discord, Slack, Gmail, WhatsApp
- **Real-time chat**: WebSocket replay, structured turn timelines, approval workflows, interrupt handling, file uploads, Markdown export
- **Session management**: Conversational context with cursor-based replay, pending message handling, and duplicate-consumption protection
- **IM messaging**: Internal messaging system with friend/group conversations, message sending, and caching

### AI Agent Runtime
- **Assistant system**: Assistants, Providers, Models, Skills, MCP Servers, access policies, and rule modes
- **Prompt configuration**: Centralized frontend editing of system prompts with feature-domain separation and user-level overrides
- **Local Agent execution**: Subprocess-based Agent runner with workspace mounts, bash approval allowlists, and snapshot I/O
- **Subagent support**: Parallel subagent execution with protocol-based IPC and recovery

### Knowledge & Memory
- **Knowledge base**: Document upload & chunking, vector retrieval, multi-config Embedding (OpenAI / Zhipu / Ollama), three-level enhancement (metadata/LLM精简/LLM完整), Wiki page generation, and graph browsing
- **Long-term memory**: Identity profiles, session-bound memory, hybrid retrieval (BM25 + vector), temporal decay, bi-temporal slicing, Raw Ledger audit, LLM deduplication, procedural memory, and context compression
- **Soul system**: User Soul profiles, memory observation, personality insights, and memory extraction logging

### Code & Repository
- **Repo Review**: Repository discovery, profile management, hooks, local triggering, remote sync, branch synchronization, webhooks, digest generation with budget-aware orchestration
- **Code Index / CodeMap**: Branch-level code indexing, semantic chunk retrieval, file summaries, function declarations, call dependency queries, and file dependency graph browsing
- **Repository Feature Map**: Agent-friendly index of features, entry files, routes, DB modules, and frontend pages

### Automation & Tools
- **Task scheduling**: `once`, `interval`, `cron` schedules, AI-generated task drafts, manual execution with pause/resume
- **Stock analysis**: Configuration presets, watchlists, task queues, historical reports, market review, backtesting, news sources
- **Browser automation**: CDP-based control panel, rendering capture, MCP integration, extension marketplace with AI-generated MCP support
- **Workflow Workbench**: Graphical multi-agent workbench with draggable canvas, node/edge flows, runtime visualization, and human intervention

### System & Operations
- **Live2D companion**: Virtual character sidebar with model upload, emotion-driven animation, and configurable analysis models
- **User & permissions**: User management, roles, RBAC, authentication sessions, multi-user resource isolation, resource sharing
- **Database**: SQLite (default), MySQL/TiDB, PostgreSQL with automatic SQL dialect adaptation
- **Operations**: Login, origin protection, optional web terminal, diagnostics, orphan workspace cleanup, subagent runtime viewing

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Web Console                          │
│                    React + TypeScript + Vite                 │
│                    (web/src/)                               │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP / WebSocket
┌──────────────────────────▼──────────────────────────────────┐
│                      Backend Runtime                        │
│                   Node.js + TypeScript                      │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────────────────┐   │
│  │ web-server  │ │ index.ts    │ │ Routes (46 modules)  │   │
│  │ (API/WS)    │ │ (Orchestr.) │ │ (REST/WS endpoints)  │   │
│  └──────┬──────┘ └──────┬──────┘ └──────────┬───────────┘   │
│         │               │                    │               │
│  ┌──────▼───────────────▼────────────────────▼───────────┐   │
│  │              Core Services Layer                       │   │
│  │  Agent Runner │ Memory │ Knowledge │ Repo Review │ ... │   │
│  └──────────────┬───────────────────────────────────────┘   │
│                 │                                            │
│  ┌──────────────▼───────────────────────────────────────┐   │
│  │              Persistence Layer                        │   │
│  │  Database Engine (SQLite/MySQL/PostgreSQL)            │   │
│  │  └──→ DB Schema (3 dialects) + 32 CRUD modules       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                    Agent Runner                             │
│                 subprocess (agent/runner/)                   │
│              Local execution with workspace mounts           │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | Location | Description |
|-----------|----------|-------------|
| **Runtime Orchestrator** | `src/index.ts` | Main entry, startup lifecycle, message loop |
| **Web Server** | `src/web-server.ts` | Express, WebSocket, auth, static hosting |
| **Route Modules** | `src/routes/` | 46 HTTP route modules for all API endpoints |
| **Database Layer** | `src/db/` + `src/database/` | 32 CRUD modules, 3 DDL schemas, engine abstraction |
| **Agent Runner** | `src/agent-runner.ts` + `agent/runner/` | Local subprocess bridge + runner implementation |
| **Memory System** | `src/memory/` | Identity, hybrid search, context assembly, compaction |
| **Knowledge Base** | `src/knowledge/` | Chunking, retrieval, LLM enhancement, Wiki |
| **Channels** | `src/channels/` | Web, Feishu, Telegram, Discord, Slack, Gmail, WhatsApp |
| **IM** | `src/routes/im-*.ts` | Internal messaging (friend/group conversations, messages) |
| **Browser** | `src/browser/` | CDP automation, tab management, snapshot capture |
| **Embedding** | `src/embedding/` | OpenAI, Zhipu, Ollama vector providers |
| **Workflow** | `src/workflow/` + `src/workteam/` | Multi-agent orchestration + legacy SDLC |
| **Frontend** | `web/src/` | 16 main pages + sub-components with React + TypeScript |

## Prerequisites

### Required
- **Node.js** 20+
- **npm** (comes with Node.js)
- **Git** (for repository operations)
- At least one working **AI Provider** (OpenAI, Ollama, Zhipu, etc.)

### Recommended (for enhanced Agent capabilities)
| Tool | Purpose | Installation |
|------|---------|--------------|
| **ripgrep (rg)** | Fast search/glob for Agent | macOS: `brew install ripgrep`<br>Linux: `apt-get install ripgrep` or `dnf install ripgrep`<br>Windows: `winget install BurntSushi.ripgrep.MSVC` |
| **ruff** | Python linting | `pip install ruff` |
| **Go** | Go linting | https://go.dev/dl/ |
| **cargo** | Rust linting | https://rustup.rs/ |

### Optional
- **Native directory picker**: `osascript` (macOS), `zenity`/`kdialog`/`yad` (Linux)
- **Browser executable**: Required for rendering capture features

## Installation

### 1. Clone the repository

```bash
git clone <repository-url>
cd nanoclaw
```

### 2. Install dependencies

```bash
# Backend
npm install

# Frontend
cd web && npm install

# Agent Runner
cd ../agent/runner && npm install && npm run build
```

### 3. Build the project

```bash
cd ..
npm run build
```

### 4. Run onboarding (first-time setup)

```bash
npm run onboard
```

This creates local runtime directories, database templates, and security configuration templates.

### 5. Start the application

**macOS / Linux:**
```bash
./start.sh
```

**Windows:**
```bat
start.bat
```

The startup script will:
1. Stop any existing NanoClaw process
2. Clean build artifacts
3. Build backend and frontend
4. Start the runtime and write PID/port marker files

**Access the web console at:** `http://localhost:3000` (or the port shown in output)

## First-Time Configuration

1. **Open the Web Console** in your browser
2. **Add a default AI Provider** in the Configuration page
3. **Enable optional features**: Web login, browser capabilities, terminal access
4. **Configure a channel instance** if you want external messaging (Feishu, Telegram, etc.)
5. **Create your first Assistant** in the Assistants page
6. **Explore features**: Chat, Tasks, Repo Review, Stock Analysis, Knowledge Base

## Project Structure

```
nanoclaw/
├── src/                      # Backend runtime & API (362 files)
│   ├── index.ts              # Main runtime entry
│   ├── web-server.ts         # HTTP API, WebSocket, auth
│   ├── routes/               # 46 HTTP route modules (incl. im-*.ts for internal messaging)
│   ├── db/                   # Persistence (32 modules, 3 DDL schemas)
│   ├── database/             # Database engine abstraction (12 modules)
│   ├── memory/               # Long-term memory system (19 modules)
│   ├── knowledge/            # Knowledge base (19 modules)
│   ├── channels/             # Channel adapters (9 modules)
│   ├── browser/              # Browser CDP automation (14 modules)
│   ├── embedding/            # Vector embedding (4 modules)
│   ├── workflow/             # Workflow workbench (4 modules)
│   ├── workteam/             # Legacy SDLC (17 modules)
│   ├── agent-runner*.ts      # Agent subprocess bridge
│   └── ...                   # Additional services
├── web/                      # Frontend (React + TypeScript + Vite)
│   ├── src/                  # 16 main pages + sub-components (incl. im/ for IM messaging)
│   └── package.json
├── agent/
│   ├── runner/               # Local Agent runtime (35 files)
│   └── skills/               # Built-in skills
├── skills-engine/            # Skills installation & runtime engine
├── setup/                    # Installation & service scripts
├── scripts/                  # Maintenance & migration scripts
├── deploy/                   # Kubernetes deployment manifests
├── docs/                     # Chinese documentation
├── groups/                   # Session workspaces (main/, global/)
├── data/                     # Runtime data, uploads, extensions
└── store/                    # SQLite database (default: messages.db)
```

## Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start in development mode with hot reload |
| `npm run build` | Build backend (TypeScript compilation) |
| `npm run build:all` | Build backend + frontend |
| `npm run build:web` | Build frontend only |
| `npm run onboard` | First-time setup (directories, templates) |
| `npm run doctor` | System diagnostics |
| `npm run test` | Run all tests |
| `npm run test:critical` | Run critical regression tests |
| `npm run test:memory` | Run memory/context regression tests |
| `npm run typecheck` | TypeScript type checking |
| `npm run format:check` | Prettier format check |
| `cd web && npm run build` | Build frontend |
| `cd agent/runner && npm run build` | Build agent runner |

## Database Support

NanoClaw supports three database engines with automatic SQL dialect adaptation:

| Database | Use Case | Notes |
|----------|----------|-------|
| **SQLite** | Default, local development | Zero configuration, single file |
| **MySQL / TiDB** | Production, distributed | Requires utf8mb4, 3072-byte index limit |
| **PostgreSQL** | Production, advanced features | Full-text search, JSONB support |

Schema changes must be applied to all three dialects simultaneously. See `docs/` for detailed database schema rules.

## Security Considerations

- **Local execution**: Agent runs as subprocess with workspace mounts — not an OS-level sandbox
- **Allowed directories**: Per-session directory access control via access policies
- **Bash approval**: Configurable allowlist for shell commands
- **Origin protection**: Web server validates request origins
- **Authentication**: Optional login system with session management
- **Resource isolation**: Multi-user mode with user_id-based isolation for assistants, knowledge bases, repositories, and sessions

## Documentation

### Quick Start
- [English README](README.md) — this file
- [中文快速开始](docs/快速开始.md) — Installation guide
- [系统概览](docs/系统概览.md) — System architecture overview

### Feature Documentation
- [Web Console & Workflows](docs/Web控制台与核心工作流.md)
- [Assistants, Permissions & Memory](docs/助手-权限-记忆.md)
- [Channels & Integrations](docs/渠道与接入.md)
- [Task Scheduling](docs/任务调度.md)
- [Workflow Workbench](docs/workflow-workbench.md)
- [Repo Review](docs/RepoReview.md)
- [Knowledge Base Architecture](docs/知识库架构.md)
- [Browser Automation](docs/浏览器自动化与Web能力.md)
- [MCP & Skills](docs/MCP-Skills-扩展.md)
- [Security Model](docs/安全模型.md)

### Operations
- [Running & Operations](docs/运行与运维.md)
- [Kubernetes Deployment](docs/K8s部署.md)
- [Troubleshooting](docs/排障清单.md)
- [Development & Testing](docs/开发与测试.md)

### Agent-Friendly
- [Repository Feature Map](docs/repo-feature-map/index.md) — Code location index for agents

## Screenshots

See [效果图.md](效果图.md) for UI screenshots covering:
- Chat interface with approval workflows
- Repository review dashboard
- Assistant configuration
- Knowledge base management
- Live2D companion
- Stock analysis workspace
- User management

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

### Before submitting changes
1. Ensure backend compiles: `npm run build`
2. Ensure frontend compiles: `cd web && npm run build`
3. Run critical tests: `npm run test:critical`
4. Update relevant documentation

### Commit conventions
Use conventional commits: `fix:`, `feat:`, `docs:`, `refactor:`, `test:`, `chore:`

## License

This project is licensed under the [MIT License](LICENSE).

## Acknowledgments

Thanks to all [contributors](CONTRIBUTORS.md) who have helped shape NanoClaw!

---

**Note**: NanoClaw is designed for local use. It is not a hosted SaaS product. Many features interact directly with your filesystem, Git repositories, and local scripts. Please review security settings before exposing to networks.
