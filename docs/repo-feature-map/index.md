# NanoClaw 仓库功能 Map

这份文件是 NanoClaw 仓库的 **LLM Wiki 式功能索引**：先把仓库能力编译成稳定 Markdown，再让后续 Agent 按功能入口定向阅读，避免每次从全仓 `rg` 开始。

## 使用规则（给 Agent）

1. 先读 `AGENTS.md`、当前工具入口和 `docs/agent-harness.md`。
2. 需要定位代码时，先读本文件的功能表；不要直接全仓搜索。
3. 只打开表里列出的起点文件、路由、DB 模块、前端页面或关联文档。
4. 如果仍需搜索，把范围限制在本文件建议的目录或文件集合内，例如 `rtk rg "keyword" src/routes src/db web/src/pages/CodeMapPage.tsx`。
5. 如果发现功能入口变化、文件迁移或新增稳定模块，同步更新本文件和 `docs/repo-feature-map/log.md`。

## 索引来源

- 数据源：`.env` 中的 PostgreSQL 连接，读取现有 `repo-nanoclaw` / `main` 代码索引。
- Snapshot：`cis_repo-nanoclaw_main`。
- 代码源：`remote_worktree`，`source_branch=main`，`source_head_sha=48a0f1a20d37104a273cbf425e55e4212f6749b3`。
- 明细索引：`code_index_files=845`、`code_index_chunks=20062`、`code_index_functions=15079`、`code_index_function_edges=14579`。
- 语言分布：TypeScript 760 files / 264300 lines，Python 26 / 6397，JavaScript 25 / 4526，JSON 21 / 13531，YAML 10 / 483，Shell 3 / 317。
- 注意：当前 `code_index_snapshots.stats_json` 显示 0，但明细表已填充；做统计时以明细表 `COUNT(*)` 为准，或重建/修复 snapshot meta。

## 功能总表

| 功能 | 先读这些文件 | 后端/数据入口 | 前端入口 | 相关文档/测试 |
|---|---|---|---|---|
| 运行时启动与进程编排 | `src/index.ts`, `src/web/web-server.ts`, `src/runtime/runtime-state.ts`, `src/runtime/runtime-dispatch.ts` | `src/config.ts`, `src/env.ts`, `src/logger.ts`, `src/runtime/runtime-persistence.ts` | `web/src/App.tsx` | `docs/系统概览.md`, `docs/运行与运维.md`, `src/runtime/runtime-dispatch-web-failure.test.ts` |
| HTTP API、WebSocket、上传、认证组合层 | `src/web/web-server.ts` | `src/auth/auth-middleware.ts`, `src/auth/web-auth.ts`, `src/auth/web-auth-runtime.ts`, `src/auth/audit-middleware.ts` | `web/src/App.tsx`, `web/src/conversation-realtime.ts`, `web/src/hooks/useConversationRealtime.ts` | `src/auth/web-auth-runtime.test.ts`, `src/web-server-auth-guards.test.ts` |
| 数据库引擎与跨库 SQL | `src/database/engine.ts`, `src/database/factory.ts`, `src/db/engine-access.ts`, `src/db/sql-adapters.ts` | `src/database/sqlite-engine.ts`, `src/database/mysql-engine.ts`, `src/database/postgres-engine.ts`, `src/db/schema-sqlite.ts`, `src/db/schema-mysql.ts`, `src/db/schema-postgres.ts` | 无直接 UI | `src/db.test.ts`, `docs/系统概览.md` |
| 通用持久化模块 | `src/db.ts`, `src/db/index.ts` | `src/db/users.ts`, `src/db/assistants.ts`, `src/db/conversations.ts`, `src/db/tasks.ts`, `src/db/memory.ts`, `src/db/review.ts`, `src/db/repositories.ts` | 按功能进入页面 | `src/db.test.ts` |
| 登录、用户、RBAC、审计 | `src/routes/auth-routes.ts`, `src/routes/user-routes.ts`, `src/routes/admin-audit-routes.ts`, `src/routes/resource-access-routes.ts`, `src/auth/resource-access-policy.ts`, `src/auth/local-capability-policy.ts` | `src/user/user-service.ts`, `src/db/users.ts`, `src/db/audit-log.ts`, `src/db/resource-bindings.ts`, `src/auth/web-auth.ts`, `src/auth/ldap-auth.ts` | `web/src/pages/UsersPage.tsx`, `web/src/hooks/useAuth.ts`, `web/src/pages/settings/SettingsSecurityTab.tsx`, `web/src/pages/settings/SettingsAuditLogTab.tsx` | `docs/安全模型.md`, `src/user/user-service.test.ts`, `src/auth/web-auth.test.ts` |
| 助手、Provider、模型与运行配置 | `src/routes/assistant-routes.ts`, `src/routes/available-provider-routes.ts`, `src/routes/user-provider-routes.ts`, `src/routes/runtime-customization-routes.ts` | `src/assistant/assistant-config.ts`, `src/assistant/assistant-runtime.ts`, `src/provider/provider-api.ts`, `src/provider/provider-registry.ts`, `src/provider/provider-adapters.ts`, `src/provider/provider-http-config.ts`, `src/runtime/runtime-customization.ts`, `src/agent/agent-runner-spawn.ts`, `src/db/assistants.ts`, `src/db/config.ts`, `src/db/schema-*.ts` | `web/src/pages/AssistantsPage.tsx`, `web/src/pages/settings/SettingsProvidersTab.tsx`, `web/src/pages/settings/useSettingsPageModel.tsx` | `src/provider/provider-api.test.ts`, `src/provider/provider-adapters.test.ts`, `src/runtime/runtime-customization.test.ts`, `src/db.test.ts` |
| 会话、聊天、实时流与文件上传 | `src/routes/conversation-message-routes.ts`, `src/routes/conversation-admin-routes.ts`, `src/channels/web.ts` | `src/db/conversations.ts`, `src/db/tavern.ts`, `src/runtime/runtime-dispatch.ts`, `src/tavern/tavern-service.ts`, `src/types/messaging.ts`, `src/types/agent.ts`, `src/agent/agent-runner.ts` | `web/src/App.tsx`, `web/src/pages/ChatPage.tsx`, `web/src/stores/ChatStateStore.ts`, `web/src/components/chat/*`, `web/src/components/ConversationSidebar.tsx`, `web/src/hooks/useConversationRealtime.ts` | `src/conversation-message-routes.test.ts`, `src/conversation-admin-routes.test.ts`, `src/runtime/runtime-dispatch-web-failure.test.ts`, `.codex/skills/nanoclaw-conversation-flow/SKILL.md` |
| IM、好友、群聊与 E2EE | `src/routes/im-routes.ts`, `src/routes/im-file-routes.ts`, `src/routes/im-friend-routes.ts`, `src/routes/im-group-routes.ts`, `src/im/im-service.ts`, `src/im/im-social-service.ts`, `src/im/im-ai-service.ts` | `src/im/im-membership-service.ts`, `src/im/im-file-storage.ts`, `src/db/schema-*.ts` 的 `im_*` 表 | `web/src/pages/im/ImPage.tsx`, `web/src/pages/im/im-api.ts`, `web/src/pages/im/im-e2ee.ts`, `web/src/pages/im/components/*` | `docs/IM与端到端加密.md`, `src/im/im-service.test.ts`, `src/im/im-ai-service.test.ts`, `src/websocket-im-access.test.ts` |
| 多渠道接入 | `src/channels/index.ts`, `src/channels/registry.ts`, `src/routes/channel-instance-routes.ts`, `src/routes/whatsapp-webhook-routes.ts` | `src/channels/feishu.ts`, `src/channels/telegram.ts`, `src/channels/discord.ts`, `src/channels/slack.ts`, `src/channels/gmail.ts`, `src/channels/whatsapp.ts`, `src/config-store-channel-instances.ts`, `src/conversation/channel-connection-manager.ts`（兼容 facade） | `web/src/pages/settings/SettingsChannelsTab.tsx` | `docs/渠道与接入.md`, `src/channels/*.test.ts` |
| Agent Runner、Codex 工具、子代理 | `agent/runner/src/index.ts`, `agent/runner/src/codex-tools.ts`, `src/subagent/subagent-runtime-registry.ts`, `src/subagent/subagent-runtime-control.ts` | `agent/runner/src/ipc-mcp-stdio.ts`, `agent/runner/src/codex-mcp-tools.ts`, `agent/runner/src/codex-provider-concurrency.ts`, `agent/runner/src/bash-output-filter.ts`, `agent/runner/src/mutation-approval.ts`, `src/routes/system-read-routes.ts`, `src/routes/conversation-admin-routes.ts`, `src/conversation/conversation-admin-support.ts`, `src/subagent/subagent-runtime-fs.ts`, `src/subagent/subagent-runtime-recovery.ts` | `web/src/pages/settings/SettingsSubagentTab.tsx`, `web/src/components/ApprovalOverlay.tsx` | `agent/runner/src/codex-tools.test.ts`, `src/subagent/subagent-runtime-registry.test.ts`, `docs/agent-harness.md` |
| MCP、Skills、扩展市场 | `src/routes/user-mcp-routes.ts`, `src/routes/user-skill-routes.ts`, `src/routes/admin-marketplace-routes.ts`, `src/routes/registry-routes.ts`, `src/routes/public-library-routes.ts` | `src/mcp/mcp-client.ts`, `src/assistant/assistant-mcp.ts`, `src/user/user-mcp-service.ts`, `src/user/user-skill-service.ts`, `src/extension/registry-service.ts`, `src/extension/extension-marketplace-service.ts`, `src/extension/marketplaces/*`, `skills-engine/apply.ts`, `skills-engine/state.ts` | `web/src/pages/AppsPageV2.tsx`, `web/src/pages/settings/SettingsMcpTab.tsx`, `web/src/pages/settings/SettingsSkillsTab.tsx`, `web/src/pages/settings/SettingsExtensionsTab.tsx`, `web/src/components/apps/McpCreateDrawer.tsx`, `web/src/components/apps/SkillCreateDrawer.tsx` | `docs/MCP-Skills-扩展.md`, `src/extension/extension-marketplace-service.test.ts`, `src/codex-mcp-tools.test.ts` |
| 记忆系统与上下文装配 | `src/memory/document-indexing.ts`, `src/memory/context-assembly.ts`, `src/memory/hybrid-search.ts`, `src/routes/internal-memory-routes.ts`, `src/routes/memory-identity-routes.ts` | `src/retrieval/service.ts`, `src/memory/search-index.ts`, `src/memory/promotion.ts`, `src/memory/identity-service.ts`, `src/memory/compaction-scheduler.ts`, `src/memory/observability.ts`, `src/db/memory.ts` | `web/src/pages/settings/SettingsKnowledgeTab.tsx`, `web/src/components/KnowledgeGraph.tsx` | `docs/记忆-实现与架构.md`, `docs/助手-权限-记忆.md`, `src/memory-*.test.ts`, `src/retrieval-query-fusion.test.ts` |
| 知识库、文档索引、Wiki 页面 | `src/routes/knowledge-routes.ts`, `src/routes/retrieval-routes.ts`, `src/routes/internal-retrieval-routes.ts`, `src/knowledge/pipeline.ts`, `src/knowledge/wiki-maintainer.ts`, `src/knowledge/overview-maintainer.ts` | `src/retrieval/service.ts`, `src/retrieval/query-planner.ts`, `src/retrieval/fusion.ts`, `src/knowledge/chunker.ts`, `src/knowledge/file-extractors.ts`, `src/knowledge/retrieval.ts`, `src/knowledge/query-backfill.ts`, `src/knowledge/wiki-claims.ts`, `src/knowledge/event-log.ts`, `src/embedding/*` | `web/src/pages/KnowledgePage.tsx`, `web/src/components/KnowledgeGraph.tsx`, `web/src/styles/knowledge.css` | `docs/知识库架构.md`, `docs/knowledge-wiki-maintainer.md`, `src/knowledge-*.test.ts`, `src/internal-retrieval-routes.test.ts`, `src/rag-eval-metrics.test.ts` |
| Repo Review、分支同步、digest、V3 coordinated review | `src/routes/repo-review-routes.ts`, `src/repo-review/repo-review-service.ts`, `src/repo-review/repo-review-run-executor.ts`, `src/repo-review/repo-review-coordinator.ts` | `src/repo-review/repo-review-read-service.ts`, `src/repo-review/repo-review-digest-service.ts`, `src/repo-review/repo-review-sync-service.ts`, `src/repo-review/repo-review-diff-index.ts`, `src/repo-review/repo-review-git.ts`, `src/db/review.ts`, `src/db/code-index-db.ts`, `src/code-intelligence/code-map-persist.ts` | `web/src/components/RepoReviewSettingsPanel.tsx`, `web/src/components/repo-review/*`, `web/src/pages/RepositoryPage.tsx` | `docs/RepoReview.md`, `src/repo-review-*.test.ts`, `docs/superpowers/plans/2026-04-23-repo-review-tool-budget-optimization-plan.md`；注意 `runs-summary` 主要返回 `reviewProgress`，完整 `reviewTurns` 需看 detail 接口 |
| Code Index 与 CodeMap | `src/routes/code-index-routes.ts`, `src/code-intelligence/code-index-builder.ts`, `src/code-intelligence/project-graph.ts`, `src/code-intelligence/project-graph-context.ts`, `src/code-intelligence/project-graph-query-store.ts`, `src/db/code-index-db.ts`, `src/routes/code-map-routes.ts` | `src/code-intelligence/code-map-builder.ts`, `src/code-intelligence/code-map-render.ts`, `src/code-intelligence/code-map-persist.ts`, `src/code-intelligence/code-map-description.ts`, `src/db/code-map-analysis-db.ts` | `web/src/pages/CodeMapPage.tsx`, `web/src/components/code-map/*`（含 Project QA tab，调用 `/api/code-index/:repositoryId/ask`） | `src/code-intelligence/code-index-builder.test.ts`, `src/code-intelligence/project-graph.test.ts`, `src/code-index-routes.test.ts`, `src/code-map-*.test.ts`, `docs/系统概览.md`, `docs/代码智能图谱优化文档.md` |
| 项目索引图谱 | `src/routes/repository-routes.ts`, `src/project-graph/project-graph-service.ts`, `src/db/project-graph.ts` | `src/db/repositories.ts` 的 `repo_features(feature_type='project_graph')`, `src/db/schema-*.ts` 的 `project_graph_*` 表, `src/db/code-index-db.ts` | `web/src/components/repository/ProjectGraphPanel.tsx`, `web/src/components/RepoReviewSettingsPanel.tsx`, `web/src/pages/RepositoryPage.tsx` | `src/project-graph/project-graph-service.test.ts`；当前 MVP 生成项目画像、服务名/配置关系、服务依赖候选、库表候选和文档草稿，后续深度扫描通过 Skills/MCP 扩展 |
| 仓库注册与功能开关 | `src/routes/repository-routes.ts`, `src/routes/assistant-repo-routes.ts` | `src/db/repositories.ts`, `src/assistant/assistant-repo.ts`, `src/tenant/resource-binding-service.ts`, `src/db/resource-bindings.ts` | `web/src/pages/RepositoryPage.tsx`, `web/src/components/RepoReviewSettingsPanel.tsx` | `src/repository-routes.test.ts` |
| 定时任务与 AI 任务草稿 | `src/routes/task-session-routes.ts`, `src/scheduler/task-scheduler.ts`, `src/scheduler/task-schedule.ts`, `src/scheduler/task-draft.ts` | `src/db/tasks.ts`, `src/runtime/runtime-state.ts`, `src/index.ts` | `web/src/pages/TasksPage.tsx`, `web/src/pages/TasksPageContainer.tsx`, `web/src/styles/tasks.css` | `docs/任务调度.md`, `src/scheduler/task-schedule.test.ts`, `src/scheduler/task-draft.test.ts` |
| Workflow Workbench / 图形多智能体编排 | `src/routes/workflow-routes.ts`, `src/workflow/orchestrator.ts`, `src/workflow/contracts.ts`, `src/workflow/event-bus.ts`, `src/workflow/agent-adapter.ts`, `src/workflow/artifacts.ts`, `src/workflow/config.ts`, `src/workflow/metrics.ts`, `src/workflow/evaluation.ts`, `src/workflow/runner-profiles.ts` | `src/workflow/types.ts`, `src/db/workflows.ts`, `src/db/schema-*.ts` | `web/src/pages/WorkteamPage.tsx`, `web/src/components/repository/WorkflowRepositoryPanel.tsx` | `docs/workflow-workbench.md`, `docs/sdlc-runner-profiles.md`；新建工作流默认进入 `fixed_pipeline_v1` 画布，节点可编辑目标/验收/输出 schema/失败打回，边支持严格 verdict 条件路由与上下文策略，workflow 仓库绑定可注入 runner profile env |
| 股票分析 | `src/routes/stock-analysis-routes.ts`, `src/stock-analysis/stock-analysis-service.ts`, `src/stock-analysis/stock-analysis-config.ts` | `src/stock-analysis/stock-analysis-types.ts`, `src/stock-analysis/stock-analysis-records.ts`, `src/stock-analysis/stock-analysis-market-data.ts`, `src/stock-analysis/stock-analysis-news-source.ts`, `src/stock-analysis/stock-analysis-backtest.ts`, `src/db/stock-analysis.ts` | `web/src/pages/StockAnalysisPage.tsx`, `web/src/pages/stock-analysis/*` | `docs/股票分析.md`, `src/stock-analysis-*.test.ts` |
| 浏览器自动化与 Web 抓取 | `src/routes/browser-routes.ts`, `src/browser/service.ts`, `src/browser/cdp.ts`, `src/auth/local-capability-policy.ts` | `src/browser/chrome.ts`, `src/browser/cdp-client.ts`, `src/browser/cdp-actions.ts`, `src/browser/cdp-snapshot.ts`, `src/browser/config.ts`, `src/config/web-search-config.ts` | `web/src/components/BrowserControlPanel.tsx`, `web/src/pages/settings/SettingsBrowserTab.tsx`, `web/src/pages/settings/SettingsWebSearchTab.tsx` | `docs/浏览器自动化与Web能力.md`, `src/browser-*.test.ts`, `src/web-search-config.test.ts` |
| Soul、Tavern 与 Live2D | `src/routes/soul-routes.ts`, `src/routes/tavern-routes.ts`, `src/routes/live2d-routes.ts`, `src/soul/soul-service.ts`, `src/tavern/tavern-config.ts` | `src/soul/soul-consolidation.ts`, `src/soul/soul-presets.ts`, `src/tavern/tavern-service.ts`, `src/db/soul.ts`, `src/db/tavern.ts`, `src/db/live2d.ts` | `web/src/pages/SoulPage.tsx`, `web/src/pages/TavernPage.tsx`, `web/src/components/live2d/*`, `web/src/pages/settings/SettingsLive2DTab.tsx` | `src/soul-*.test.ts`, `src/runtime/runtime-dispatch-web-failure.test.ts`, `src/assistant/assistant-runtime.test.ts` |
| 分享、终端、系统读接口 | `src/routes/share-routes.ts`, `src/routes/system-read-routes.ts`, `src/web/terminal-shell.ts`, `src/auth/local-capability-policy.ts` | `src/db/shares.ts`, `src/routes/admin-trash-routes.ts`, `src/db/trash.ts` | `web/src/pages/ShareViewPage.tsx`, `web/src/components/ShareHistoryPanel.tsx`, `web/src/pages/TerminalPage.tsx`, `web/src/pages/settings/SettingsTrashTab.tsx`, `web/src/pages/settings/SettingsDiagnosticsTab.tsx` | `src/system-read-routes.test.ts`, `src/terminal-shell.test.ts` |

## 后端路由速查

| 路由文件 | 负责功能 | 优先搜索范围 |
|---|---|---|
| `src/routes/auth-routes.ts` | 登录、登出、会话状态 | `src/web-auth*`, `src/auth/auth-middleware.ts`, `src/db/users.ts` |
| `src/routes/user-routes.ts` | 用户管理 API | `src/user/user-service.ts`, `src/db/users.ts` |
| `src/routes/admin-audit-routes.ts` | 管理员审计日志 | `src/db/audit-log.ts`, `src/auth/audit-middleware.ts` |
| `src/routes/admin-settings-routes.ts` | 全局配置、诊断、设置项 | `src/config-store.ts`, `src/config-store-*.ts` |
| `src/routes/assistant-routes.ts` | Assistant CRUD 与绑定 | `src/db/assistants.ts`, `src/assistant/assistant-runtime.ts` |
| `src/routes/available-provider-routes.ts` | 可用 Provider 列表 | `src/provider/provider-registry.ts`, `src/provider/provider-api.ts` |
| `src/routes/user-provider-routes.ts` | 用户级 Provider 配置 | `src/provider/provider-http-config.ts`, `src/db/config.ts` |
| `src/routes/conversation-admin-routes.ts` | 会话列表、权限、回放、管理、Web 新建酒馆会话绑定 | `src/db/conversations.ts`, `src/db/tavern.ts`, `src/runtime/runtime-dispatch.ts`, `src/tavern/tavern-service.ts` |
| `src/routes/conversation-message-routes.ts` | 发送消息、上传文件、slash command | `src/channels/web.ts`, `src/types/messaging.ts` |
| `src/routes/internal-memory-routes.ts` | Agent 内部记忆检索/读写 API | `src/memory/*`, `agent/runner/src/memory-tools.ts` |
| `src/routes/knowledge-routes.ts` | 知识库、文档、wiki、lint、search | `src/knowledge/*`, `src/embedding/*` |
| `src/routes/retrieval-routes.ts` / `src/routes/internal-retrieval-routes.ts` | 统一 RAG 检索调试与 loopback API，融合 knowledge / memory 候选、query variants、trace、MMR、本地 rerank | `src/retrieval/*`, `src/knowledge/retrieval.ts`, `src/db/memory.ts` |
| `src/routes/repo-review-routes.ts` | 仓库审查、同步、digest、远端分支 | `src/repo-review-*`, `src/db/review.ts` |
| `src/routes/repository-routes.ts` | 通用仓库注册与 feature 开关 | `src/db/repositories.ts`, `src/tenant/resource-binding-service.ts` |
| `src/routes/code-index-routes.ts` | 分支级 code index 构建、搜索、函数图、project graph query/path/explain、query artifact、项目问答 | `src/code-intelligence/code-index-builder.ts`, `src/code-intelligence/project-graph.ts`, `src/code-intelligence/project-graph-context.ts`, `src/code-intelligence/project-graph-query-store.ts`, `src/db/code-index-db.ts` |
| `src/routes/code-map-routes.ts` | CodeMap 快照、文本渲染、AI 分析 | `src/code-map-*`, `src/db/code-map-analysis-db.ts` |
| `src/routes/task-session-routes.ts` | 任务 CRUD、执行、暂停恢复 | `src/scheduler/task-scheduler.ts`, `src/db/tasks.ts` |
| `src/routes/workflow-routes.ts` | Workflow Workbench、workflow/node/edge CRUD、run graph、延迟 transfer、条件打回、runner profile、产物交付、运行态干预 | `src/workflow/*`, `src/db/workflows.ts` |
| `src/routes/stock-analysis-routes.ts` | 股票配置、任务、报告、数据源 | `src/stock-analysis-*`, `src/db/stock-analysis.ts` |
| `src/routes/browser-routes.ts` | 浏览器连接、tab、CDP 操作 | `src/browser/*`, `src/config/web-search-config.ts` |
| `src/routes/user-mcp-routes.ts` | 用户 MCP 管理 | `src/user/user-mcp-service.ts`, `src/mcp/mcp-client.ts` |
| `src/routes/user-skill-routes.ts` | 用户 Skills 管理 | `src/user/user-skill-service.ts`, `skills-engine/*` |
| `src/routes/admin-marketplace-routes.ts` | 扩展市场 | `src/extension-marketplace-*` |
| `src/routes/channel-instance-routes.ts` | 渠道实例配置 | `src/config-store-channel-instances.ts`, `src/channels/*` |
| `src/routes/whatsapp-webhook-routes.ts` | WhatsApp webhook | `src/channels/whatsapp.ts` |
| `src/routes/soul-routes.ts` | Soul 配置、记忆洞察 | `src/soul-*`, `src/db/soul.ts` |
| `src/routes/tavern-routes.ts` | 酒馆人格模板 CRUD、全局底层能力配置、头像上传与预览文件读取 | `src/tavern/tavern-service.ts`, `src/tavern/tavern-config.ts`, `src/db/tavern.ts`, `src/db/schema-*.ts` |
| `src/routes/live2d-routes.ts` | Live2D 模型与配置 | `src/extension/live2d-service.ts`, `src/db/live2d.ts` |
| `src/routes/share-routes.ts` | 分享页面与历史 | `src/db/shares.ts` |
| `src/routes/system-read-routes.ts` | 只读系统信息 | `src/system-read-routes.test.ts` |

## 前端页面速查

| 页面/组件 | 负责功能 | API 或状态入口 |
|---|---|---|
| `web/src/App.tsx` | 全局状态、WebSocket、页面路由、聊天主装配 | `web/src/conversation-realtime.ts`, `web/src/stores/ChatStateStore.ts` |
| `web/src/pages/ChatPage.tsx` | 聊天页布局 | `web/src/components/chat/*`, `web/src/components/ConversationSidebar.tsx` |
| `web/src/pages/AssistantsPage.tsx` | Assistant 管理 | `src/routes/assistant-routes.ts` |
| `web/src/pages/TasksPage.tsx` / `web/src/pages/TasksPageContainer.tsx` | 任务页面 | `src/routes/task-session-routes.ts` |
| `web/src/pages/KnowledgePage.tsx` | 知识库、文档、wiki、检索 | `src/routes/knowledge-routes.ts` |
| `web/src/pages/CodeMapPage.tsx` | CodeMap、Code Index 搜索、函数依赖 | `web/src/components/code-map/code-map-api.ts`, `src/routes/code-map-routes.ts`, `src/routes/code-index-routes.ts` |
| `web/src/pages/RepositoryPage.tsx` | 仓库工作台基础页 | `web/src/components/RepoReviewSettingsPanel.tsx`, `src/routes/repository-routes.ts` |
| `web/src/components/repo-review/*` | Repo Review profile、run 列表、digest、进度 | `web/src/components/repo-review/api.ts`, `src/routes/repo-review-routes.ts` |
| `web/src/pages/StockAnalysisPage.tsx` | 股票分析工作台 | `web/src/pages/stock-analysis/*`, `src/routes/stock-analysis-routes.ts` |
| `web/src/pages/WorkteamPage.tsx` | Workflow 列表卡片、可编辑画布、节点/连线属性面板、运行记录、旧 workflow 只读兼容 | `src/routes/workflow-routes.ts` |
| `web/src/pages/SoulPage.tsx` | Soul 配置、记忆洞察 | `src/routes/soul-routes.ts` |
| `web/src/pages/TavernPage.tsx` | 酒馆人格卡片库、历史对话入口、全局底层能力配置 | `src/routes/tavern-routes.ts` |
| `web/src/components/live2d/*` | Live2D 面板、模型、情感配置 | `src/routes/live2d-routes.ts` |
| `web/src/components/BrowserControlPanel.tsx` | 浏览器控制面板 | `src/routes/browser-routes.ts` |
| `web/src/pages/settings/SettingsPage.tsx` | 设置页壳 | `web/src/pages/settings/useSettingsPageModel.tsx` |
| `web/src/pages/settings/SettingsProvidersTab.tsx` | Provider 设置 | `src/routes/user-provider-routes.ts`, `src/routes/available-provider-routes.ts` |
| `web/src/pages/settings/SettingsMcpTab.tsx` / `SettingsSkillsTab.tsx` / `SettingsExtensionsTab.tsx` | MCP、Skills、扩展市场 | `src/routes/user-mcp-routes.ts`, `src/routes/user-skill-routes.ts`, `src/routes/admin-marketplace-routes.ts` |
| `web/src/pages/settings/SettingsSecurityTab.tsx` | 登录、安全、权限 | `src/routes/auth-routes.ts`, `src/routes/user-routes.ts` |
| `web/src/pages/settings/SettingsChannelsTab.tsx` | 渠道实例配置 | `src/routes/channel-instance-routes.ts` |
| `web/src/pages/settings/SettingsBrowserTab.tsx` / `SettingsWebSearchTab.tsx` | 浏览器与 Web 搜索 | `src/routes/browser-routes.ts`, `src/config/web-search-config.ts` |
| `web/src/pages/TerminalPage.tsx` | Web 终端 | `src/web/terminal-shell.ts` |
| `web/src/pages/ShareViewPage.tsx` | 分享访问页 | `src/routes/share-routes.ts` |

## DB 与 Schema 速查

| 数据域 | DB 模块 | Schema 定义 | 注意点 |
|---|---|---|---|
| 通用引擎 | `src/database/*`, `src/db/engine-access.ts`, `src/db/sql-adapters.ts` | 无表 | MySQL/TiDB、PostgreSQL、SQLite 兼容逻辑都在这里先查。 |
| 用户/认证/RBAC | `src/db/users.ts`, `src/db/audit-log.ts`, `src/db/resource-bindings.ts` | `src/db/schema-*.ts` | 新增字段必须同步三套 schema。 |
| Assistant/Provider/MCP | `src/db/assistants.ts`, `src/db/config.ts` | `src/db/schema-*.ts` | `key`、`role` 等保留字走 `adaptSql`。 |
| 会话/消息 | `src/db/conversations.ts`, `src/db/files.ts` | `src/db/schema-*.ts` | Chat flow 要同时验证持久化、realtime、前端 optimistic state。 |
| 记忆 | `src/db/memory.ts` | `src/db/schema-*.ts` | 搜索/索引机制变更要同步 `docs/记忆-实现与架构.md`。 |
| 知识库 | `src/db/memory.ts`, `src/knowledge/*` | `src/db/schema-*.ts` | wiki、event log、overview 维护由知识库服务负责。 |
| Repo Review | `src/db/review.ts`, `src/db/repositories.ts` | `src/db/schema-*.ts` | 兼容旧 `review_repositories` 与新 `repositories`/`repo_features`。 |
| Code Index | `src/db/code-index-db.ts` | `src/db/schema-*.ts` 的 `code_index_*` 表 | 明细表是功能 Map 的主要原始数据；当前 snapshot meta 统计可能滞后。 |
| CodeMap AI 分析 | `src/db/code-map-analysis-db.ts` | `src/db/schema-*.ts` | 保存 repo description 与 AI analysis 缓存。 |
| 任务/Workflow | `src/db/tasks.ts`, `src/db/workflows.ts` | `src/db/schema-*.ts` | 图形工作流在 `src/workflow/*`；runner profile 已归属 Workflow。 |
| 股票/Soul/Live2D/分享 | `src/db/stock-analysis.ts`, `src/db/soul.ts`, `src/db/live2d.ts`, `src/db/shares.ts` | `src/db/schema-*.ts` | 各自路由和前端页面一一对应。 |

## 针对常见问题的定向入口

| 用户问题关键词 | 先查哪里 | 不要先查哪里 |
|---|---|---|
| “消息没显示/重复/处理中不清除/上传文件没进 prompt” | `.codex/skills/nanoclaw-conversation-flow/SKILL.md`, `src/routes/conversation-message-routes.ts`, `src/channels/web.ts`, `web/src/hooks/useConversationRealtime.ts`, `web/src/App.tsx` | 不要全仓搜 `message`；范围太大。 |
| “某个 API 404/权限不对” | 对应 `src/routes/*-routes.ts`，再查 `src/web/web-server.ts` 注册点和 guard | 不要直接扫所有 `register*Routes`。 |
| “数据库字段/索引/迁移” | `src/db/schema-sqlite.ts`, `src/db/schema-mysql.ts`, `src/db/schema-postgres.ts`, 相关 `src/db/*.ts` | 不要只改一种方言。 |
| “CodeMap/代码索引/函数调用图/项目实现问答” | `src/routes/code-index-routes.ts`, `src/code-intelligence/project-graph.ts`, `src/code-intelligence/project-graph-context.ts`, `src/code-intelligence/project-graph-query-store.ts`, `src/code-intelligence/code-index-builder.ts`, `src/db/code-index-db.ts`, `web/src/pages/CodeMapPage.tsx` | 不要先读 `web/src/App.tsx`。 |
| “Repo Review 超预算/分支同步/digest/evidence/代码图谱上下文” | `docs/RepoReview.md`, `src/repo-review/repo-review-run-executor.ts`, `src/repo-review/repo-review-digest-service.ts`, `src/repo-review/repo-review-sync-service.ts`, `web/src/components/repo-review/*`；如果问题是“列表里为什么没看到 tool-call / turn 流”，同时查 `src/repo-review/repo-review-read-service.ts` 和 detail 接口；如果问题是 review 上下文质量，同时查 CodeMap/Code Index 行 | 不要从 `web/src/App.tsx` 或全仓 `rg review` 开始。 |
| “知识库 wiki/文档索引/检索质量” | `docs/知识库架构.md`, `docs/knowledge-wiki-maintainer.md`, `src/routes/knowledge-routes.ts`, `src/knowledge/*` | 不要从 memory 目录开始，除非是长期记忆问题。 |
| “长期记忆/identity/上下文预算” | `docs/记忆-实现与架构.md`, `src/memory/*`, `src/routes/internal-memory-routes.ts`, `agent/runner/src/memory-tools.ts` | 不要先看知识库 pipeline。 |
| “Provider/模型/请求头/兼容模式” | `src/provider-*`, `src/routes/user-provider-routes.ts`, `agent/runner/src/codex-mode.ts`, `agent/runner/src/codex-request-headers.ts` | 不要先改前端表单。 |
| “MCP/Skill 安装或隔离” | `docs/MCP-Skills-扩展.md`, `src/user/user-mcp-service.ts`, `src/user/user-skill-service.ts`, `skills-engine/*`, `agent/runner/src/ipc-mcp-stdio.ts` | 不要只看设置页 tab。 |
| “浏览器抓取/CDP/网页搜索” | `docs/浏览器自动化与Web能力.md`, `src/browser/*`, `src/routes/browser-routes.ts`, `src/config/web-search-config.ts` | 不要先查 knowledge importer，除非是 URL 导入。 |
| “Workflow/SDLC/Runner Profile” | `docs/workflow-workbench.md`, `docs/sdlc-runner-profiles.md`, `src/workflow/*` | 不要从普通 task scheduler 开始。 |

## 维护约定

- 本文件只放稳定入口，不追踪每个 helper。
- 每个功能最多保留 4-8 个最值得先打开的文件；长尾文件靠定向 `rg`。
- 新增架构级能力时，同步更新本文件、`docs/文档索引.md`、必要的主题文档和 `README.md` 能力描述。
- 维护细则见 `docs/repo-feature-map/schema.md`，变更记录见 `docs/repo-feature-map/log.md`。
