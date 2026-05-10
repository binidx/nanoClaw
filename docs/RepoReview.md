# Repo Review

## 模块定位

Repo Review 是面向 Git 仓库的审查流水线，不只是"把 diff 发给模型看一下"。

## 当前能力

- 仓库发现与接入
- profile 配置
- hooks 安装与卸载
- 本地触发 commit/push 审查
- 远端仓库同步审查
- 指定分支同步审查
- webhook 接入与验签
- 运行记录与详情
- 分支状态缓存
- 远端分支缓存
- 人工决策与取消运行
- digest 调度与文档渲染
- digest 运行记录与详情
- 会话绑定（review conversation bindings）
- 仓库成员管理
- Git 远程 URL 解析与 provider 推断（GitHub / GitLab / Gitea）

## 模块拆分

当前 Repo Review 已拆分为 12 个子模块：

- `repo-review-service.ts`：barrel 入口
- `repo-review-budget.ts`：payload 估算、字节预算与分组基础能力
- `repo-review-diff-index.ts`：统一 diff 单次索引与按文件 lazy slice
- `repo-review-model.ts`：数据模型与常量
- `repo-review-git.ts`：Git 远程操作、URL 解析、provider 推断、clone/compare
- `repo-review-prompt-templates.ts`：审查 prompt 模板管理
- `repo-review-messages.ts`：消息格式化
- `repo-review-run-executor.ts`：review run 执行编排
- `repo-review-read-service.ts`：只读查询服务
- `repo-review-sync-service.ts`：远端同步队列
- `repo-review-webhook.ts`：webhook 处理
- `repo-review-doc-render.ts`：文档渲染
- `repo-review-digest-service.ts`：digest 调度

数据层：`src/db/review.ts`（CRUD）。
路由层：`src/routes/repo-review-routes.ts`。

## 涉及的表

- `review_repositories`：仓库注册
- `review_profiles`：审查 profile 配置
- `review_runs`：审查运行记录
- `review_digest_runs`：digest 运行记录
  现在显式记录 `scheduled_for`、`period_start/end`、`started_at`、`completed_at`、`duration_ms`、`timezone`、`delivery_status/error`，用于排查“配置时间正确但实际晚跑”或“已生成但未发出”这类问题。
- `review_branch_states`：分支状态
- `review_remote_branch_cache`：远端分支缓存
- `review_conversation_bindings`：会话绑定
- `review_repository_members`：仓库成员

## 典型工作流

1. 在 Repo Review 页面接入仓库
2. 创建或调整 review profile
3. 选择本地 hooks、手动触发、远端同步或 webhook 模式
4. 查看 runs、detail 和 branches status
5. 需要时做人工决策或取消运行
6. 查看 digest 和文档渲染结果

## Digest 调度语义

- digest 调度使用统一的服务端 `TIMEZONE` 计算下一次执行时间，不再直接依赖宿主机隐式本地时区。
- digest 的统计窗口按计划槽位边界计算，而不是按实际开始时间简单回退 24 小时或 7 天。
- 修改日报/周报时间、星期或开关后，会重新计算 `next_digest_*_at`；关闭后会清空对应 next run。
- digest 运行记录与普通 review run 分开查询和展示，前端可直接查看计划执行时间、实际开始/完成时间和投递状态。

## 当前执行模型

- 审查现在是 `main-agent plan -> executor subagents -> main-agent summary -> extractor` 的 agentic 流程，主代理先制定计划，再决定是否委派；主计划会尽早发起，diff index 在后续阶段按需构建，减少“看起来还没开始调用 AI”的等待感。
- `diffSubagentThreshold` 现在只作为“建议委派阈值”，不再强制拆分；全文读取仍受 profile 预算控制。
- Repo Review 的主审查计划 prompt、子代理 prompt、最终 Markdown prompt、结构化 extractor prompt 和 digest prompt 已进入统一 Prompt 配置中心，可按功能域查看、编辑与追踪。
- 第一轮 prompt 只产出 `review_plan`；最终的人类可读报告由主代理生成，结构化 JSON 由独立 extractor 转换，`raw_report_markdown` 固定保留主报告正文。
- 进度时间线现在会透出 agent 运行中的状态事件和持续时间，避免“卡在计划阶段但看不到 AI 已开始请求”的错觉。
- 旧的 `JSON + ---REVIEW_BODY--- + Markdown` 结果仍兼容解析，但不再作为默认输出协议。
- executor 会在需要子代理/补充取证时构建统一 diff index，后续主计划、子代理和 extractor 都从同一份原始 diff 做按文件切片，不再反复重建大字符串。
- 子代理默认超时已放宽到 5 分钟，超时补救会复用同一工作区并透出更明确的状态进度。
- 最终 Markdown 报告现在严格遵循固定模板，`markdown_body` 作为最终展示正文，不再被主报告正文覆盖回去。
- executor 已开始记录字节级预算统计：包含 diff 文件数、diff 字节数、额外 `read_file` 次数、子代理数、模型调用数、读取预算和提取尝试次数。
- review 运行中的中间持久化不再反复写入完整 `reviewTurns` 数组，而是写入紧凑的 `reviewProgress` 快照；完整 turns 只在最终完成时落库。
- 工具调用失败和上下文不足现在都应被视为恢复边界：优先写入 `scope_limitations`，而不是把开放式仓库探索当作默认控制流。
- 若模型输出无法解析成合法 JSON，系统会把原始输出保存在 `review_runs.raw_model_output`，并尽量回退展示，不再把整次审查结果直接吞掉。
- Prompt Trace 会额外记录 Repo Review 在真实运行时发给模型的 prompt 文本，便于核对自定义 prompt 是否真正生效。
- 这些统计当前主要用于验证和后续优化，不改变审查结论本身。

## 最小前提

- 本地可访问的 Git 仓库
- 正确的仓库路径与默认分支配置
- 可用的 Assistant / Provider
- 若走远端同步或 webhook，需要额外的平台配置

## 高风险点

- hooks 安装会修改 `.git/hooks`
- 远端同步会依赖远程仓库和分支状态
- webhook 验签失败会直接阻断入站事件
- 审查运行会消耗本地运行时与模型额度
- 多用户模式下，hooks 安装/卸载、手动远端同步以及 SSH key 管理属于本机写操作，应纳入 `local.install` 门禁；团队场景优先 webhook 或远端平台触发，而不是默认开放本地 hooks。

## 适合写进运维手册的事实

- 这是重运维模块
- 本地和远端模式都存在
- 分支状态与 run 记录需要一起看，不能只盯某一次运行结果
- digest 调度是后台循环，不依赖手动触发
- auto sync 在启动时自动开始
