# 仓库功能 Map 操作日志

按时间记录功能 Map 的摄入、查询、健康检查和重要修正。格式保持短小，便于 Agent 快速回溯。

## [2026-04-24] ingest | 初始功能 Map

- 读取仓库协作入口：`AGENTS.md`、`.codex/README.md`、`docs/agent-harness.md`。
- 通过 `.env` PostgreSQL 连接复用现有 `repo-nanoclaw` Code Index。
- 确认 `cis_repo-nanoclaw_main` 明细表已有索引：845 files、20062 chunks、15079 functions、14579 function edges。
- 发现 `code_index_snapshots.stats_json` 仍为 0，但明细表有数据；功能 Map 以明细表 count 为准。
- 新增 `docs/repo-feature-map/index.md` 和 `docs/repo-feature-map/schema.md`。
- 将后续 Agent 查找策略调整为“先读功能 Map，再定向搜索”。

## [2026-04-24] update | 多用户资源隔离入口

- 将 `src/resource-access-policy.ts` 加入登录/RBAC/资源访问定位入口。
- 记录 Provider 用户授权、MCP 凭证脱敏和助手资源绑定隔离相关文档同步。

## [2026-04-25] update | Provider 分享与默认偏好

- 将 Provider 功能行补充到 schema 文件与 `src/db.test.ts`，覆盖个人分享、用户默认偏好和系统授权表。

## [2026-04-28] update | Workflow Workbench 替换入口

- 新增 `src/routes/workflow-routes.ts`、`src/workflow/*`、`src/db/workflows.ts` 作为图形工作流主入口。
- 将 `web/src/pages/WorkteamPage.tsx` 的功能描述改为 Workflow Workbench 画布、节点编辑和运行态干预。
- 保留 `src/workteam/*` 作为旧 Workteam / SDLC / Runner Profile 相关实现，并在功能 Map 中显式区分新旧入口。

## [2026-05-01] update | 模块化路径刷新与索引说明

- 将 feature map 的稳定入口刷新到当前模块布局：`src/runtime/*`、`src/web/*`、`src/agent/*`、`src/provider/*`、`src/repo-review/*`、`src/code-intelligence/*`、`src/scheduler/*` 等。
- 记录当前索引对应 `source_head_sha=d53bd752bf85dc75b2fcc06d1b43c20da1d52f03`。
- 新增 `docs/agent-index-guide.md`，明确 feature map 是导航索引而不是事实源，使用前需要验证路径存在。

## [2026-05-01] guardrail | feature map freshness 检查

- 新增 `scripts/check-feature-map-freshness.mjs` 和 `npm run check:feature-map:freshness`。
- 将 feature map 元数据同步到最近已提交实现变更 `source_head_sha=dd497df522664c0d88e797eb12f35f95fd257817`。
- 该检查用于重构后显式确认 feature map 是否落后；默认不并入 `npm run check`，避免普通 docs-only 提交被当前代码脏状态阻塞。

## [2026-05-01] update | 知识库 Wiki claim 与图谱入口

- 将 `src/knowledge/wiki-claims.ts` 加入知识库功能行，作为 Wiki 核心事实抽取、证据 chunk 绑定和详情加载入口。
- 将 `web/src/components/KnowledgeGraph.tsx` 加入知识库前端入口，覆盖增强后的图谱布局、聚焦和视图状态逻辑。

## [2026-05-03] update | IM 与 E2EE 入口

- 新增 IM、好友、群聊、AI 协作与 E2EE 功能行，定位 `src/routes/im-routes.ts`、`src/im/*`、`web/src/pages/im/*`。
- 将前端本地 E2EE 模块 `web/src/pages/im/im-e2ee.ts` 记录为密钥、room key 封装和消息/附件加解密入口。

## [2026-05-04] update | IM E2EE 当前设计文档

- 新增 `docs/IM与端到端加密.md`，说明当前 IM E2EE 的开启边界、密钥模型、服务端可见信息、AI/search 限制和排障。
- 将该文档加入 IM、好友、群聊与 E2EE 功能行，作为当前设计说明入口。

## [2026-05-04] update | 本机高风险能力策略入口

- 新增 `src/auth/local-capability-policy.ts` 作为 Web 终端、浏览器控制等本机高风险能力的部署模式与 RBAC 统一入口。
- 将本机能力策略加入登录/RBAC、浏览器自动化、终端/系统读接口功能行。
- 更新 `docs/安全模型.md`，记录多用户模式默认禁用、管理员显式开启和细粒度权限要求。

## [2026-05-07] update | Repo Review agentic 执行模型

- 将 Repo Review 执行边界刷新为“主代理计划 -> executor 受控子代理 -> 主代理汇总 -> 独立结构化提取”。
- `diffSubagentThreshold` 改为委派建议信号，不再由 executor 强制 Diff Worker 拆分；稳定入口仍是 `src/repo-review/repo-review-run-executor.ts`、`src/repo-review/repo-review-prompt-templates.ts` 和 `web/src/components/repo-review/*`。

## [2026-05-07] update | Repo Review 两阶段受控子代理

- 将 Repo Review 执行边界改为“主审查直接基于 diff/evidence 输出 Markdown -> executor 按变更文件分发受控全文子代理 -> 独立结构化整理”。
- 主审查 prompt 不再强制 JSON 或固定取证步骤；全文补充子代理只消费 executor 提供的目标文件、diff、相关发现和文件内容，不挂载自由仓库工作区。
- 前端进度继续复用 assistant turn card / SubagentActivity 风格，并将 `full_file_subagent_*` 识别为子代理阶段。

## [2026-05-08] update | 内置 Agent Reach 扩展源

- 将 `src/extension/marketplaces/*` 记录为 MCP/Skills/扩展市场功能行的一等入口。
- 新增内置 `Agent Reach` marketplace source，用来发布随仓库分发的 skill bundle。
- 明确这类互联网能力优先以 Skill 路由 + 上游工具启用方式接入，而不是强行映射成 NanoClaw managed MCP command。
