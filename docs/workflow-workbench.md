# Workflow Workbench

## 概述

Workflow Workbench 是 Workteam 的图形化替代层。它把原先“智能体表单 + 任务表单 + 依赖多选”的编排方式重构为一个可视化工作台：

- 角色节点：定义 AI 身份、目标、背景和助手绑定
- 任务节点：定义具体任务、Prompt、预期输出、超时与人工批准策略
- 消息流边：定义节点间的单向 / 双向交互关系
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
- `workflow_run_interventions`
  用户在运行态对输入 / 输出进行修改时的审计记录。

## 执行语义

- 自动调度只基于任务节点之间的单向边。
- 双向边会被持久化、显示并参与消息流可视化；运行时会在当前批次执行结束后，按最新消息方向驱动下一位发言节点继续执行。
- 双向边支持 `discussionTurns` 轮次预算；达到预算后，不再继续自动轮转。
- 用户可以在边级面板插入 `feedback frame`，作为下一轮节点交互的显式反馈载荷。
- 当边上插入 `feedback frame` 后，目标节点会重新进入下一轮执行，并在输入构建时优先读取这些 feedback frame。
- 运行中的任务节点支持选择某个 message frame 作为下一轮输入基线，并可切换 `反馈优先` / `纯时间顺序` 两种输入优先级规则。
- 任务节点支持节点级执行覆盖：`providerOverrideId`、`modelOverride`、`instructionsAppend`、`allowedDirectories`，并优先于 assistant 默认执行配置生效。
- 节点 execution 事件在运行台中会按 turn/tool/approval/ask/reasoning 语义解析为可读 timeline，而不再只显示原始 JSON。
- 任务节点必须绑定角色节点。
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

## 前端工作台

`web/src/pages/WorkteamPage.tsx` 现在承载 Workflow Workbench：

- 左栏：工作流列表与新建入口
- 中央：可拖拽节点画布、框选多节点、批量拖动、自动排版、消息流连线与连线重连
- 右栏：节点 / 连线属性面板
- 底部：运行列表、整图输入、整图输出、基于 dialogue session / message frame 的讨论边摘要与边级消息面板、支持一键回填为节点输入的节点讨论历史，以及节点独立 execution / event 时间线

## 已知限制

- 双向边目前是“可见消息链路 + 手动续跑友好”的实现，不做自动多轮对话循环。
- 角色与任务采用双层模型，而不是统一通用节点系统。
- 旧 Workteam 表和旧 API 仍在仓库中保留，但新页面和新运行流程已经切到 `/api/workflows/**`。
- 旧 Workteam 现已提供 `POST /api/workteam/:id/migrate-to-workflow` 迁移入口，可将 team/agent/task 结构转换为 workflow 定义并复制仓库绑定。
- `web-server` 不再注册旧 Workteam 主 CRUD / run 路由；旧模块仅保留迁移与 runner-profile 辅助接口。
- 仓库绑定面板和仓库关系展示已经 workflow 化，主仓库绑定与 runner-profile 配置以 workflow 作为 owner 进行展示和编辑。
- 左侧模板库已支持一键插入角色节点、任务节点和标准图模板（如 SDLC Lite、Analysis -> Execute -> Summarize、Debate + Arbiter）。
