# 仓库功能 Map 操作日志

按时间记录功能 Map 的摄入、查询、健康检查和重要修正。格式保持短小，便于 Agent 快速回溯。

## [2026-05-21] update | 项目索引图谱 MVP

- 新增项目级索引图谱入口，复用仓库工作台与 `repo_features(feature_type='project_graph')` 保存扫描器、Skills/MCP、服务名、负责人和外部绑定配置。
- 新增 `src/project-graph/project-graph-service.ts` 与 `src/db/project-graph.ts`，落库 `project_graph_runs/facts/edges/documents`，初版扫描消费仓库配置与 Code Index 摘要生成项目画像、关系和文档草稿。
- 仓库页新增 `Project Graph` tab，入口为 `web/src/components/repository/ProjectGraphPanel.tsx`，支持保存配置和触发扫描。
- 扫描器补充 Feign/Dubbo/HTTP 服务依赖候选和 SQL/MyBatis/JPA 表资产候选，均以 `code_index` 来源、置信度和文件证据入图，供后续工单诊断人工确认。
- Assistant 资源层开始消费仓库项目图谱：仓库绑定返回项目图谱摘要、推荐 Skill/MCP、服务/配置/表线索，并在运行时把启用的项目图谱作为通用上下文注入，供任意助手能力组合使用。
- Assistant 资源页新增项目图谱推荐资源同步：把仓库图谱配置的 Skills/MCP 按可用性状态同步为助手底层能力绑定，未知或停用资源只提示不自动创建，保持通用积木式组合。

## [2026-05-21] update | Workflow 条件路由与 runner profile 迁移入口

- Workflow Workbench 稳定边界新增 `src/workflow/runner-profiles.ts` / `src/workflow/runner-profile-registry.ts`，Workflow 仓库绑定节点执行可复用 runner profile env 注入能力。
- `src/workflow/orchestrator.ts` 支持 verdict 条件边：`always`、`on_pass`、`on_fail`、`on_blocked`、`manual_only`，可构建 developer -> tester -> developer 自动打回闭环并受 maxAttempts 限制。
- `web/src/pages/WorkteamPage.tsx` 节点属性面板新增任务目标、验收标准、输出 schema、失败打回策略、交接契约；连线属性面板新增触发条件。
- `web/src/components/repository/WorkflowRepositoryPanel.tsx` runner profile API 切到 `/api/workflows/**`。

## [2026-05-21] cleanup | 移除旧 Workteam 编排

- 删除旧 `src/workteam/**`、`src/routes/workteam-routes.ts`、`src/db/workteam.ts` 和旧桥接测试，Workflow Workbench 成为唯一多智能体编排主线。
- Runner profile、project detector 和 profile registry 已迁入 `src/workflow/**`，Workflow 节点执行直接注入仓库绑定 profile env。
- Schema、trash、WebSocket、resource binding 和仓库关系展示移除旧 Workteam owner / table / event 入口。

## [2026-05-21] update | Workflow 输出契约与上下文策略

- 新增 `src/workflow/contracts.ts`，集中处理结构化 verdict、输出契约校验、条件边 verdict 要求和 handoff 上下文裁剪。
- 条件边缺失 verdict 时不再默认 pass，可通过 `outputContract` / `requireVerdict` 进入 blocked 路由或失败。
- `web/src/pages/WorkteamPage.tsx` 节点/边属性面板新增输出契约和上下文策略配置。

## [2026-05-21] update | 知识库 RAG 检索链路优化

- 将知识库检索从“FTS 候选内向量重排”升级为“FTS + 授权 KB 范围直接向量召回 + RRF 辅助融合”。
- 记录 Qwen3-Embedding-8B 维度默认与实际向量长度校验，避免 1536/4096 混用静默降级。
- Wiki claim evidence 选择新增 embedding 相似度辅助，保留词面匹配兜底。

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
- 当时仍保留旧 Workteam / SDLC / Runner Profile 相关实现；后续已在 2026-05-21 清理并迁入 Workflow。

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

## [2026-05-10] update | Repo Review V3 coordinated review

- 将 Repo Review 的稳定执行边界更新为 `repo-review-coordinator.ts` 负责的 evidence bundle / worker / reducer 流水线。
- 新增 `repo_review.worker` 与 `repo_review.reducer` prompt 定义，旧 agentic prompt 保留历史兼容但不再是新 run 默认路径。
- 前端 Repo Review 时间线补充 worker / reducer 语义，兼容旧 step id 的同时展示 V3 进度。

## [2026-05-11] update | Repo Review 主代理直审与可观测性边界

- 将 Repo Review 当前稳定行为补充为“主代理直审”与“worker 后主代理补审”双主路径；`reducer` 调整为结构化解析失败时的兜底整理器，而非每次 run 的必经阶段。
- 明确 `runs-summary` 与 `runs/:id/detail` 的可观测性边界：前者主要返回 `reviewProgress`，后者才返回完整 `reviewTurns` 和 tool-call 流。
- 更新 `docs/RepoReview.md` 与 feature map 入口描述，避免把“列表里只看到主代理卡片”误判成“后端没有工具调用流”。

## [2026-05-13] update | Workflow 延迟 transfer 与产物闭环

- Workflow Workbench 稳定边界新增 `src/workflow/config.ts` 与 `src/workflow/artifacts.ts`。
- `src/db/workflows.ts` / `schema-*` 新增 `workflow_pending_transfers` 和 `workflow_artifacts`，用于 agent 间延迟消息干预、导出、发布与仓库提交推送。
- `web/src/pages/WorkteamPage.tsx` 入口改为本页工作流卡片库，运行台展示 pending transfer 队列和交付产物操作。
- 将 feature map 元数据同步到当前已提交代码 `source_head_sha=0e32466c00f38407e135d4ba6d06a33e7c39ca7f`；本次 Workflow 重构仍包含未提交实现变更，freshness 检查会继续列出相关脏文件作为提示。

## [2026-05-13] update | Workflow 生产护栏与评估可见性

- Workflow Workbench 稳定边界新增 `src/workflow/metrics.ts` 与 `src/workflow/evaluation.ts`。
- `src/db/workflows.ts` / `schema-*` 新增 `workflow_run_evaluations`，保存 deterministic run evaluation。
- `web/src/pages/WorkteamPage.tsx` 运行详情展示 metrics/evaluation，配置页展示生产护栏与工具策略。

## [2026-05-13] update | Repo Review diff-aware evidence bundle 与代码图谱上下文

- Repo Review executor 在模型调用前构建 typed Review Evidence Bundle，合并 diff hunk、CodeMap 状态、Code Index 函数定位和 1-hop 函数调用邻域。
- agentic 子代理默认只读取预构建 evidence，不使用工具；主代理保留只读补证能力。
- Repo Review 时间线开始使用 `parentToolCallId` 将子代理 turn 内嵌到对应 Agent 工具卡片，并展示 evidence / 工具调用统计。
- 完成通知与详情视图补充系统生成的 `branch + short(base..head)` 审查范围；工具统计语义收敛为只读补证调用数。

## [2026-05-13] update | Workflow fixed pipeline workbench

- Workflow Workbench 新建默认入口改为 `fixed_pipeline_v1`，后端创建时自动生成 `输入 -> 资料检索 -> 分析 -> 总结` 四节点模板与隐藏共享 role。
- `src/workflow/config.ts` / `types.ts` 新增 workflow editor mode 与 pipeline node kind 稳定字段；`src/workflow/orchestrator.ts` 为 `input` 节点新增整图输入直通语义。
- `web/src/pages/WorkteamPage.tsx` 主界面改为效果图式固定四节点工作台，Provider 选择对齐可见 Provider 分组，旧 `role/task` workflow 在新页面只读兼容。

## [2026-05-13] update | Workflow editor returns to editable whiteboard semantics

- `src/routes/workflow-routes.ts` 继续使用现有 workflow/node/edge CRUD，但 task 节点创建与保存不再要求显式 role 绑定，后端用隐藏 runtime role 兼容当前执行结构。
- `src/workflow/orchestrator.ts` / `agent-adapter.ts` 将 assistant 缺失收敛为运行时错误“该节点缺少执行主体”，不再把 assistant 绑定作为建图阶段前提。

## [2026-05-18] update | Code Index project graph retrieval 与项目问答入口

- 新增 `src/code-intelligence/project-graph.ts`，把 Code Index / CodeMap 统一成可缓存的 project graph，包含 directory/file/chunk/function 节点、contains/imports/calls/references 边、社区聚合和 graph-aware retrieval。
- `src/routes/code-index-routes.ts` 新增 `graph/stats`、`graph/query`、`graph/path`、`graph/explain`、`ask` 入口，供项目实现问答、关系追踪和最小上下文检索复用。
- CodeMap 的 AI summary / repo description 已开始复用更丰富的 Code Index 上下文；Repo Review 继续消费 diff-aware evidence bundle，后续可进一步接到统一 project graph。
- `web/src/pages/WorkteamPage.tsx` 列表页收敛为 workflow 卡片网格，详情页恢复新增节点、拖拽、连线、删边、删节点、返回工作流、删除 workflow、简化配置与只读运行查看。
- 将 feature map 元数据同步到当前已提交代码 `source_head_sha=becad113d7dc577b4424663ddf46b6aa06340707`。

## [2026-05-20] update | 统一 RAG 检索入口

- 新增 `src/retrieval/*` 作为 knowledge / memory 共用检索编排层，提供 query variants、候选融合、trace、本地 rerank 与文本 MMR。
- 新增 `/api/retrieval/search` 与 `/internal/retrieval/search`，保留旧 `knowledge/search` 兼容路径；内部路由复用 agent 可访问 KB 解析。
- 新增 `src/rag-eval/*` 的 Ragas-style 本地指标工具和对应测试，作为后续评测集 / run 持久化的基础。

## [2026-05-21] optimize | 知识库体验与性能可观测性

- 新增 `GET /api/knowledge/bases/:id/health`，向前端暴露文档/chunk、向量覆盖率、缺失向量、维度不匹配、Wiki 页和关系边统计。
- 知识库概览页展示向量覆盖率、缺失/维度不符、Wiki 页和关系边，并支持对当前知识库单独执行向量补录，完成后自动刷新健康状态。
- 直接向量召回增加应用层扫描上限，超大知识库会有限扫描并保留 FTS 候选向量补分，降低普通查询长时间等待风险。

## [2026-05-21] optimize | 知识库 RAG 第二轮结构化 chunk 上下文

- `knowledge_chunks` 增加 `heading_path`、`context_label`、`prev_chunk_id`、`next_chunk_id`、`parent_chunk_id`、`chunk_type`，三套数据库 schema 与启动迁移同步补齐。
- `src/knowledge/chunker.ts` 开始识别 Markdown 标题、列表、表格和代码块，索引管线写入标题路径和相邻 chunk 指针，embedding 文本也带上文档与 chunk 结构上下文。
- `searchKnowledge()` 返回命中 chunk 的结构元数据和同文档前后相邻片段；统一 retrieval 与 Agent 知识库工具会把这些上下文交给 LLM，作为不引入额外 rerank 模型的上下文增强。

## [2026-05-18] update | 代码智能图谱优化文档

- 新增 `docs/代码智能图谱优化文档.md`，系统说明 CodeMap / CodeIndex / CodeLLM 的重新分工、ProjectGraph 检索层设计、当前效果与 graphify 的差距，以及面向项目问答 / Repo Review / 工作流复用的后续演进路线。
- 将该文档加入 `docs/文档索引.md` 与 Code Index / CodeMap 功能行，方便后续 agent 和开发者统一查阅。

## [2026-05-18] update | 代码智能图谱后续优化总路线

- 扩展 `docs/代码智能图谱优化文档.md` 的后续路线章节，明确下一阶段的统一目标是让 Repo Review 主审查链路和 Workflow / Workteam 节点直接复用 graph retrieval，而不是继续各自拼上下文。
- 补充 community / hotspot / god node、confidence / path ranking / context filter、持久化 query artifact 与统一 planner 的目标形态和阶段完成标准，作为后续追平 graphify 的设计基线。

## [2026-05-19] update | Tavern 独立页与全局底层能力配置

- `web/src/pages/TavernPage.tsx` 成为酒馆独立入口；`web/src/pages/SoulPage.tsx` 不再承载酒馆人格编辑区。
- `src/routes/tavern-routes.ts` / `src/db/tavern.ts` 新增 tavern 全局底层能力配置读写，供酒馆会话统一复用 skill / MCP / provider / model。
- `src/runtime/runtime-dispatch.ts` 与 `src/assistant/assistant-runtime.ts` 现在会把 tavern 全局能力配置注入普通 Web tavern 会话，避免只绑定 persona 文案却没有底层工具能力。

## [2026-05-18] update | Repo Review / Workflow 接入统一 graph retrieval

- 新增 `src/code-intelligence/project-graph-context.ts`，把 project graph 的问题组装、强制 seed、模式化 query 参数和上下文 block 渲染统一为可复用层。
- `src/repo-review/repo-review-run-executor.ts` 的准备阶段现在会生成 `repo_review` 图检索上下文，并将其写入 evidence bundle，主审查与子任务切片都会优先消费这层最小子图结果。
- `src/workflow/agent-adapter.ts` 在 workflow 绑定仓库时会基于 repository binding 自动生成 `workflow` 图检索上下文，并在节点 prompt 中显式注入项目子图，减少节点自行盲搜仓库的需要。

## [2026-05-18] update | Project Graph community / ranking / artifact persistence

- `src/code-intelligence/project-graph.ts` 新增图结构社区发现、路径加权排序、上下文筛选、query confidence 和 context filter 统计，不再只是简单路径前缀社区和 BFS/DFS 子图展开。
- 新增 `src/code-intelligence/project-graph-query-store.ts`，把 graph query / ask / prepared context 持久化到 query artifact，支持后续审计、回放和效果调优。
- `src/routes/code-index-routes.ts` 新增 `graph/queries` 列表与详情入口，并让 `graph/query`、`ask` 返回 artifact summary；Repo Review / Workflow 的 graph retrieval 也会留下持久化 query 轨迹。

## [2026-05-17] update | 酒馆人格与新会话绑定入口

- 会话功能行补充 `src/db/tavern.ts`、`src/tavern/tavern-service.ts` 和 `src/runtime/runtime-dispatch-web-failure.test.ts`，标明 tavern persona 绑定、快照与 prompt 注入入口。
- Soul 功能行补充 `src/routes/tavern-routes.ts`、`web/src/components/soul/TavernPersonasPanel.tsx`，明确 SoulPage 现在同时承载主灵魂与酒馆人格管理。
- 后端路由速查新增 `src/routes/tavern-routes.ts`，会话管理路由补充“Web 新建酒馆会话绑定”语义，避免后续 agent 只查 `soul-routes` 而漏掉 tavern API。

## [2026-05-20] audit | 全功能实现/文档一致性审查

- IM 功能行补充 `src/routes/im-friend-routes.ts` 与 `src/routes/im-group-routes.ts`，明确好友和群管理已经从主 IM 路由拆分为稳定入口。
- 多渠道功能行标注 `src/conversation/channel-connection-manager.ts` 尚未接入主运行时；当前生效路径仍是全局 `CHANNEL_INSTANCES` 与 `/api/channel-config`。
- Agent Runner 功能行补齐 Codex MCP bridge、审批 route、system-read 和 conversation access support 入口。
- MCP/Skills 功能行补齐 registry/public-library 路由和 `src/extension/registry-service.ts`，并把 AppsPageV2 作为 v2 前端入口。
- CodeMap/Code Index 功能行补充 Project QA tab 与 `/api/code-index/:repositoryId/ask` 入口。
- 将 feature map 元数据同步到当前已提交代码 `source_head_sha=ce638379e3cc4da8873c07070d8d42e90cd55630`；当前工作区仍有未提交前端改动，freshness 检查会继续提示相关脏文件。

## [2026-05-20] fix | 全功能审查后并行修复同步

- 同步记录本轮 Provider、Workflow、Share/Soul/Tavern/Live2D、IM/E2EE、多渠道、Agent Runner、记忆/知识库、启动恢复和审计落库相关修复后的当前代码基线。
- 将 feature map 元数据同步到当前已提交代码 `source_head_sha=d5eb7924b9725bf740de921301b1a3fd96e32648`；当前工作区仍包含本轮未提交实现和文档改动，freshness 检查会继续列出脏文件作为提示。

## [2026-05-20] fix | Channels 双路径收敛

- 用户级 `/api/user/channels` 写入的启用实例开始由 `getConfiguredChannelInstances()` 合并进主运行时 channel instance 列表，启动连接与配置重载统一走 `connectRegisteredChannels()` / `reloadChannels()`。
- `src/conversation/channel-connection-manager.ts` 收敛为兼容 facade，不再维护独立用户级连接池。

## [2026-05-20] optimize | 全模块优化批次

- 增加通用后台 job 状态模型 `job_statuses` / `job_events`，并先接入 task scheduler 的 started/succeeded/failed 记录。
- 补充 Security/RBAC/Audit 权限矩阵，修正 `review.repo.edit` 被 `includes('view')` 误判为 public view 的权限漏洞。
- Provider/Assistant 增加密钥更新动作、连接探测诊断字段和会话级 model override；IM/E2EE、上传清理、Subagent nested runtime、Memory/Knowledge loopback、MCP/Skills marketplace、RepoReview/CodeMap observability 和前端 realtime watermark 均完成第一轮优化。
- 将 feature map 元数据同步到当前已提交代码 `source_head_sha=7e96127385cb6c44ecfc845a1d195157ae448936`；当前工作区包含本轮未提交优化改动，freshness 检查会继续列出脏文件提示。
- 优化批次提交后，将 feature map 元数据同步到最新代码提交 `source_head_sha=03b68503450e5c4110fb4f79978b45bcb5930fde`。
