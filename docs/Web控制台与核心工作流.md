# Web 控制台与核心工作流

## 页面结构

当前顶层控制台不是一组完全独立的页面，而是一个由 `web/src/App.tsx` 统一编排的单页应用。核心工作区包括：

- 聊天（ChatPage）
- 股票分析（StockAnalysisPage）
- 任务（TasksPageContainer / TasksPage）
- Repo Review（仓库 / Repository 工作台内的审查能力）
- 助手（AssistantsPage）
- 渠道与运行状态（ChannelsPage）
- 终端（TerminalPage）
- 配置（SettingsPage）
- Apps（AppsPageV2）
- Live2D 伴侣（CompanionPage）
- 知识库（KnowledgePage）
- 灵魂（SoulPage）
- 用户管理（UsersPage）
- IM 消息（ImPage）：内部消息系统，支持好友、群聊、消息收发

其中 `Apps` 承载扩展、Skills、MCP 等能力入口，不再只是配置页里的附属页签。

## 前端状态组织

前端主控实际由 `App.tsx` 承担，集中管理以下共享状态：

- 会话列表、`activeJid`、未读计数
- `chatStateByJid`、审批、访问策略、回复中断状态
- Provider、Assistant、渠道元数据、扩展与运行状态
- 创建会话弹窗、终端启用态和部分全局设置

这样设计的原因是聊天、助手、任务、配置、终端都共享同一批 conversation/provider/assistant 实体，把状态放在 App 层能避免各页面重复拉取和重复订阅。

## 核心 hooks

- `useAppBootstrap`
  负责首屏装载 conversations、status、providers、assistants、config、channel metadata 等全局资源。
- `useWebSocket`
  负责建立单连接和自动重连。
- `useConversationRealtime`
  负责把快照和实时事件合并为 per-conversation 状态机。
- `useTerminalSession`
  负责终端页的 WebSocket 和容器挂载时机。

另外，终端和股票分析都支持通过全局配置控制导航入口是否显示。
当前股票分析入口默认关闭，需要先在设置中开启。

页面组件主要消费 App 注入的数据和动作，本地只保留短生命周期展示状态。

## 聊天

聊天页是系统的主入口，但它渲染的不是单一 `messages` 列表，而是一个合成时间线。前端会把以下数据源拼成统一 transcript：

- 已持久化的 `messages`
- 未落库的 pending user messages
- 结构化 `assistant turns`
- 审批请求与审批结果

这样做的原因是 UI 需要同时展示：

- 最终消息
- 流式回复
- tool call / reasoning 中间态
- 审批卡片
- 子代理活动

## 聊天快照与增量事件

当前链路分两段：

- `GET /api/conversations/:jid/messages`
  返回会话快照，包含 messages、turns、approvals 等
- WebSocket
  推送 `message`、`turn_event`、`stream`、`typing`、`approval_request`、`approval_resolved`、`reset`、`interrupted` 等增量事件

前端通过 `last_event_seq` 做事件水位控制，避免旧事件覆盖新状态。会话切换时还会依赖 `epochRef + activeJidRef + seenIds` 隔离旧请求和旧事件。

当前实现不是严格意义上的 WebSocket replay：WebSocket 负责 live push，断线后的主要回补依赖 HTTP snapshot。`GET /api/conversations/:jid/messages` 返回的 `last_event_seq` 主要用于观测和 ack 对齐，前端不会从消息快照推进 websocket watermark；水位推进来自 realtime event 和发送响应。

## 为什么聊天时间线不是"数据库直出"

原因有三个：

1. `assistant_turns` 和 `messages` 是两层持久化，前端必须自己合并
2. 流式事件和审批往往先到，最终消息稍后才落库
3. 会话切换、WebSocket 重连和快照回补都需要保留 transient/live turns，避免"先显示后消失"

因此当前实现会在快照返回后把 persisted turns 和 transient turns 合并，而不是简单覆盖。

## pending 消息消解

用户发送消息后，前端会先乐观插入 pending 状态。后续消解优先级是：

1. `clientId`
2. `runId`
3. 归一化内容 + 时间窗口匹配

最后这一层兜底的目的是避免在跨端、重连或部分字段丢失时，pending 永久不消失；同时又通过时间窗口避免和更早的相同文本误匹配。

## Web 会话为什么要做 mention stripping

Web channel 会把用户输入包装成带 `@AssistantName` 的入站消息，以便复用同一套触发和路由逻辑。前端展示时会再把这层 mention 去掉，否则 Web 用户会看到多余的系统包装痕迹。

## 助手

助手页不是简单 CRUD 页面，而是一个运营工作台，负责：

- Assistant 创建、更新、启停
- Provider / Model 绑定
- Skills / MCP 绑定
- 规则模式与提示词
- 访问策略
- 私有认证与资源抽屉
- 从助手视角发起"开始聊天"

从助手页开始聊天时，前端不是直接跳转到某个现有对话，而是打开创建对话流程并预绑定 `assistantId`。

## 任务

任务页以会话为中心，但实现上拆成两层：

- `TasksPageContainer`
  负责远程 truth，包括任务列表、选中会话、加载与轮询
- `TasksPage`
  负责筛选、排序、通知、编辑器、AI 草稿和交互细节

这样设计可以让任务页内部的高频交互状态不污染 `App.tsx`，同时继续和主会话选择联动。

AI 草稿流程也不是简单补全文本，而是先让后端解析自然语言，再决定直接创建还是进入高级表单微调。

## 渠道与运行状态

ChannelsPage 主要承担运行态观测职责，显示：

- 渠道连接情况
- 活跃 Agent / 子代理
- 排队任务
- 运行时间
- Doctor 诊断摘要

它是只读运行态视图，不负责渠道实例配置（配置在 SettingsPage 中）。

## 终端

终端页本身很薄，真正的生命周期由 `useTerminalSession` 管理。只有在明确开启 Web 终端后才应对外暴露，因为它直接连接宿主机 shell。

## Live2D 伴侣

CompanionPage 提供 Live2D 虚拟角色管理界面，支持：

- 模型上传与管理（公共/私有）
- 情感驱动动画配置
- 辅助情感分析模型选择
- 全局与用户双层开关

聊天界面侧边栏可嵌入 Live2D 角色，根据对话情感实时驱动动画。

## 知识库

KnowledgePage 提供知识库管理界面，支持：

- 知识库创建与管理
- 文档上传与分块
- 向量检索配置
- Embedding 引擎选择（OpenAI / 智谱 / Ollama）

知识库不再自动注入普通会话 prompt；Agent 通过 knowledge MCP 工具按需检索。知识库检索以 FTS 候选为基础，可选向量重排和 Wiki 读写。

## 灵魂

SoulPage 提供用户灵魂与人格洞察管理界面，支持：

- 用户 Soul 记录查看
- 记忆观测与提取日志
- 人格洞察展示
- 记忆合并与清理

灵魂系统是记忆系统的上层抽象，负责对用户画像做长期沉淀与洞察。

## 用户管理

UsersPage 提供用户与权限管理界面，支持：

- 用户列表与管理
- 角色创建与分配
- 权限配置
- 认证会话管理

基于 RBAC 模型实现，与登录认证和 API 鉴权联动。

## 配置与 Apps

当前职责边界是：

- `SettingsPage`
  Provider、渠道实例、基础配置、默认访问策略、发送者信任、浏览器控制、运行态观测入口
- `AppsPage`
  扩展、Skills、MCP 等能力管理

Repo Review 的主要入口在 Repository / Repos 工作台及其审查组件中，不是 SettingsPage 的常规 tab。

这比"把所有高级功能都塞进配置页"更清晰，也更符合当前系统的扩展面。

## 推荐理解顺序

1. 先理解 `App.tsx` 的中心状态编排
2. 再理解聊天快照 + WebSocket 增量合并
3. 然后看助手、任务和配置如何复用同一批 conversation/runtime 实体
4. 最后再看终端、Repo Review、知识库、灵魂、Live2D、用户管理、Apps 等旁路能力
