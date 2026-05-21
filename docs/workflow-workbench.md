# Workflow Workbench

## 概述

Workflow Workbench 是 Workteam 的图形化替代层。它把原先“智能体表单 + 任务表单 + 依赖多选”的编排方式重构为一个可视化工作台：

- 角色节点：定义 AI 身份、目标、背景和助手绑定
- 任务节点：定义目标、验收标准、Prompt、输出格式、失败打回策略、超时与人工批准策略
- 消息流边：定义节点间的单向 / 双向交互关系，以及 `always` / `on_pass` / `on_fail` / `on_blocked` / `manual_only` 条件
- 运行台：展示每个任务节点的输入快照、输出快照、节点消息流和人工干预记录

## 后端结构

- `src/routes/workflow-routes.ts`
  暴露 `/api/workflows/**` 的 CRUD、校验、运行与运行态干预 API。
- `src/db/workflows.ts`
  管理 workflow 持久化与 run graph 读取。
- `src/workflow/orchestrator.ts`
  负责任务节点调度、消息传播、整图暂停恢复、节点级暂停恢复、输入输出覆写与重试。
- `src/workflow/event-bus.ts`
  将 workflow run 事件通过 WebSocket 推送到 `workflow:<runId>` 订阅通道。
- `src/workflow/config.ts`
  规范化 `workflow_config`，包括工作流类型、可见性、消息延迟、仓库策略和产物策略。
- `src/workflow/runner-profiles.ts` / `src/workflow/runner-profile-registry.ts`
  Workflow 侧复用旧 Workteam runner profile 能力，为绑定仓库的节点执行注入语言工具链 env。
- `src/workflow/artifacts.ts`
  生成运行摘要 / bundle，并支持导出、发布和仓库分支提交推送。

## 数据模型

- `workflows`
  顶层工作流对象。
- `workflow_nodes`
  图节点；当前支持 `role` 和 `task`。
- `workflow_edges`
  图边；当前支持 `one_way` 和 `two_way` 消息流方向。
- `workflow_runs`
  一次整图运行。
- `workflow_run_nodes`
  运行中每个任务节点的状态、输入快照、输出快照和错误信息。
- `workflow_run_messages`
  节点间真实消息流。
- `workflow_pending_transfers`
  agent 间延迟 handoff 队列；到期自动发送，发送前可人工批准、编辑、取消或立即放行。
- `workflow_run_interventions`
  用户在运行态对输入 / 输出进行修改时的审计记录。
- `workflow_artifacts`
  运行结束后的摘要、bundle、提交推送和发布记录。

## 执行语义

- 自动调度只基于任务节点之间的单向边。
- 条件边会读取节点输出中的结构化 verdict。测试 / 评审节点可返回 JSON：
  `{ "verdict": "pass" | "fail" | "blocked", "reason": "...", "suggestedFix": "...", "rollbackNodeId": "..." }`。
- `always` 边总是发送；`on_pass` 只在 verdict 通过时进入下游；`on_fail` / `on_blocked` 会把目标节点重新置为 `pending`，用于 `developer -> tester -> developer` 闭环；`manual_only` 只保留给人工反馈 / 手动 transfer。
- 条件打回受目标节点 `failurePolicy.maxAttempts` / `retryPolicy.maxAttempts` 限制，达到上限后运行失败，避免无限返工。
- 双向边会被持久化、显示并参与消息流可视化；运行时会在当前批次执行结束后，按最新消息方向驱动下一位发言节点继续执行。
- 双向边支持 `discussionTurns` 轮次预算；达到预算后，不再继续自动轮转。
- 用户可以在边级面板插入 `feedback frame`，作为下一轮节点交互的显式反馈载荷。
- 当边上插入 `feedback frame` 后，目标节点会重新进入下一轮执行，并在输入构建时优先读取这些 feedback frame。
- 运行中的任务节点支持选择某个 message frame 作为下一轮输入基线，并可切换 `反馈优先` / `纯时间顺序` 两种输入优先级规则。
- 任务节点支持节点级执行覆盖：`providerOverrideId`、`modelOverride`、`instructionsAppend`、`allowedDirectories`，并优先于 assistant 默认执行配置生效。
- 任务节点可直接绑定助手；执行时 worker 节点助手优先于角色节点助手，节点覆写继续优先于助手默认运行配置。
- 节点级 `allowedDirectories` 优先；未设置时，Workflow 仓库绑定目录会作为 agent 可访问目录；再退回 assistant 绑定目录。
- Workflow 仓库绑定的 runner profile 会在节点执行前注册到 agent spawn registry，使 Java / Go / Python / Node 等 profile env 能注入 Bash 工具运行环境。
- 跨节点消息默认进入延迟 transfer 队列；默认延迟为 15 秒，可通过工作流配置调整为 0 以兼容即时运行。
- 节点 execution 事件在运行台中会按 turn/tool/approval/ask/reasoning 语义解析为可读 timeline，而不再只显示原始 JSON。
- 任务节点可显式绑定角色节点；未绑定时后端使用隐藏 runtime role 兼容执行模型。
- 任务输入由两部分组成：
  - 整图输入 `workflow_runs.input`
  - 上游节点或历史消息为该节点累积的消息上下文

## 运行态干预

当前支持：

- 暂停整图
- 继续整图
- 取消整图
- 暂停单节点
- 继续单节点
- 修改节点输入快照并保持暂停态
- 修改节点输出快照并将该输出继续向下游传播
- 重试节点
- 查看 / 批准 / 编辑 / 取消 / 立即放行 pending transfer
- 查看 artifacts、导出 bundle、提交推送、发布能力

## 前端工作台

`web/src/pages/WorkteamPage.tsx` 现在承载 Workflow Workbench：

- 入口：工作流卡片库；点击卡片后在同一页面进入详情画布，不做页面跳转
- 左栏：新建入口和画布工具；当前页面支持添加 worker、连线、拖拽、重连和自动排版
- 中央：可拖拽节点画布、框选多节点、批量拖动、自动排版、消息流连线与连线重连
- 右栏：节点 / 连线属性面板
- 底部：运行列表、整图输入、整图输出、pending transfer 队列、产物交付、基于 dialogue session / message frame 的讨论边摘要与边级消息面板、支持一键回填为节点输入的节点讨论历史，以及节点独立 execution / event 时间线

## 已知限制

- 双向边会按预算自动继续对话；并发起始节点可能导致最后发言方不对称，预算限制的是边上自动 handoff 消息数。
- 角色与任务采用双层模型，而不是统一通用节点系统。
- 旧 Workteam 表和旧 API 仍在仓库中保留，但新页面和新运行流程已经切到 `/api/workflows/**`。
- 旧 Workteam 现已提供 `POST /api/workteam/:id/migrate-to-workflow` 迁移入口，可将 team/agent/task 结构转换为 workflow 定义并复制仓库绑定。
- `web-server` 不再注册旧 Workteam 主 CRUD / run 路由；旧模块仅保留迁移与 runner-profile 辅助接口。
- 仓库绑定面板和仓库关系展示已经 workflow 化，主仓库绑定与 runner-profile 配置以 workflow 作为 owner 进行展示和编辑。
- 新建 workflow 默认 seed 固定四节点 pipeline；左侧标准图模板库（如 SDLC Lite、Analysis -> Execute -> Summarize、Debate + Arbiter）不属于当前已落地入口。
