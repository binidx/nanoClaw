# NanoClaw Web 前端

这是 NanoClaw 的 Web 控制台前端，技术栈为 React + TypeScript + Vite。前端不是单纯聊天页，而是整个工作台的操作面板。

## 当前页面

### 主页面（16 个）

- 聊天（Chat）：会话列表、消息流、审批、文件上传、导出、子代理活动
- 股票分析（Stock Analysis）：配置、watchlist、任务、报告、反馈、市场复盘、回测
- 任务（Tasks）：AI 草稿、调度管理、运行态刷新（TasksPage + TasksPageContainer）
- Repo Review：仓库接入、profile、同步、运行记录、人工决策
- 助手（Assistants）：Assistant、Provider/Model 绑定、访问策略
- 运行状态（Status）：渠道、Agent、诊断、运行时间
- 终端（Terminal）：可选宿主机 shell
- 配置（Settings）：18 个配置标签页（General、Security、Providers、Channels、Browser、MCP、Skills、Knowledge、Prompt、Diagnostics、Live2D、Extensions、WebSearch、Subagent、SshKeys、AuditLog、Trash）
- 知识库（Knowledge）：文档管理、检索、Wiki 页面
- 灵魂（Soul）：AI 人设、记忆观测
- 用户管理（Users）：RBAC、资源隔离
- 渠道管理（Channels）：飞书、Telegram、Discord、Slack、Gmail、WhatsApp 实例配置
- 应用市场（Apps）：扩展安装、MCP 管理、技能市场（AppsPageV2）
- 工作团队（Workteam）：多智能体协作编排（旧版，已迁移到 Workflow）
- 代码地图（CodeMap）：代码依赖图浏览
- 分享视图（ShareView）：会话/资源分享查看

### 子页面组件

- `settings/`：18 个配置标签页组件
- `im/`：IM 消息相关组件
- `stock-analysis/`：股票分析辅助组件

## 关键文件

- `web/src/App.tsx`：导航、全局状态、API 请求、WebSocket 整合
- `web/src/pages/ChatPage.tsx`：聊天主界面
- `web/src/pages/TasksPage.tsx`：任务管理 UI
- `web/src/pages/StockAnalysisPage.tsx`：股票分析工作台
- `web/src/pages/AssistantsPage.tsx`：助手配置
- `web/src/pages/SettingsPage.tsx`：配置与运维入口
- `web/src/components/RepoReviewSettingsPanel.tsx`：Repo Review 控制台
- `web/src/hooks/*`：实时连接、终端连接、设置动作和数据装配
- `web/src/app-types.ts`：前端核心类型定义

## 构建

```bash
npm run build
```

构建产物位于 `web/dist`，由后端启动后统一托管。
