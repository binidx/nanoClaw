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

当前 Repo Review 已拆分为 13 个子模块：

- `repo-review-service.ts`：barrel 入口
- `repo-review-budget.ts`：payload 估算、字节预算与分组基础能力
- `repo-review-diff-index.ts`：统一 diff 单次索引与按文件 lazy slice
- `repo-review-model.ts`：数据模型与常量
- `repo-review-git.ts`：Git 远程操作、URL 解析、provider 推断、clone/compare
- `repo-review-prompt-templates.ts`：审查 prompt 模板管理
- `repo-review-messages.ts`：消息格式化
- `repo-review-coordinator.ts`：V3 evidence bundle / worker / reducer 协调器
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

- 审查现在是 `prepare_context -> build_evidence_bundle -> schedule_workers -> worker_chunk_* -> reduce_results -> persist_result -> publish_completion` 的受控流水线，Coordinator 负责切分 evidence 并调度 worker，worker 只消费预构建证据块，reducer 统一收敛最终结论。
- `diffSubagentThreshold` 仅保留兼容字段，不再参与 V3 调度决策。
- Repo Review 的 V3 worker / reducer prompt 已进入统一 Prompt 配置中心；旧 agentic prompt 继续保留读取兼容，但不再作为新 run 默认路径。
- worker 超时只影响对应 chunk，reducer 失败才会让整次审查失败。
- 最终 `markdown_body` 仍是唯一展示正文来源，若 reducer 未返回可用正文则由本地 renderer 回退生成固定模板。
- 进度时间线现在展示 worker chunk / reducer 状态与耗时，旧 agentic 节点仅用于历史 run 兼容。
- coordinator 会记录 evidence bundle、worker 数量和 reducer 调用等统计，便于后续验证与优化。

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
