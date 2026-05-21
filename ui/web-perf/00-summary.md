# NanoClaw Web UI / Perf / URL Audit Summary

扫描日期：2026-05-21

范围：`web/src/**` 前端设计、控件样式、性能风险、后端 API 挂载、详情页二级 URL。12 个模块使用子代理分批只读扫描，主线程补充了路由、CSS、API 静态对照。

## 总体结论

未发现大面积“按钮调用未注册 API”的硬 404。主要风险集中在：

- 详情状态仍大量停留在本地 state，刷新、分享、浏览器返回不能恢复。
- 部分后端能力已经存在，但前端没有入口或入口语义不清。
- 大页面和图形/消息/工具输出区域存在前端全量渲染、重复请求、未节流渲染风险。
- 全局控件样式有兜底，但裸 button、文件按钮、`div role="button"`、内联 SVG、原生 select 混用仍会造成样式和可访问性分叉。

## P1 优先项

1. 补齐二级 URL：
   - CodeMap 独立入口或 `/repos/:id/codemap?branch=...`
   - `/repos/:repoId/runs/:runId`、`/repos/:repoId/digest/:id`
   - `/tasks/:taskId`
   - Knowledge `?doc=` / `?wiki=`
   - `/workteam/:workflowId/runs/:runId?node=&edge=`
   - `/im/chats/:jid`
   - `/stock-analysis/reports/:reportId`
   - `/tavern/:personaId`

2. 修复高风险功能语义：
   - Chat realtime snapshot 不推进 watermark，可能接收旧事件。
   - IM E2EE room key 重新开启会覆盖旧 key。
   - Soul `memory-documents` 后端未按用户隔离。
   - Tavern provider/model 绑定缺少后端校验。
   - Approval DirectoryAccess scope UI 与后端强制 scope 不一致。

3. 控制重负载渲染：
   - ToolResultCard 折叠态延迟渲染正文。
   - Workteam 拖拽使用 RAF/ref 暂存，避免 mousemove 全页 state 更新。
   - IM 消息列表窗口化。
   - Knowledge 文档切服务端分页。
   - CodeMap 图布局缓存或 worker 化。

## P2 优先项

1. API 入口补齐或明确废弃：
   - Browser 后端支持 back/forward/reload/select/scroll/evaluate，前端未完整暴露。
   - Workflow run cancel/evaluate/workflow delete 后端存在，前端入口不足。
   - IM 群资料、成员管理、公开群申请、好友删除、pin、typing/read cursor 未充分接入。
   - 多用户渠道实例 `/api/user/channels` 已注册，前端仍主要使用全局 channel config。
   - Memory identity 和 retrieval search 有后端 API，前端没有明显入口。

2. 网络与轮询优化：
   - StockAnalysis SSE connected 时暂停或降频轮询。
   - Settings 按 tab 懒加载 subagent/runtime/extensions/diagnostics。
   - Apps V2 store 数据延迟到进入 store tab 或 idle prefetch。
   - RepoReview runs-summary 使用 limit/page/cursor，搜索加 debounce。

3. 样式/控件统一：
   - 裸 button 全局样式或明确禁用裸 button。
   - `input[type=file]::file-selector-button` 样式补齐。
   - `NcButton`、Pagination 默认 `type="button"`。
   - `div role="button"` 改成真实 button。
   - 原生 select 和 `NcSelect/AppSelect` 统一策略。

## 模块报告

- [01 App Shell / Routing / Common](01-app-shell-routing-common.md)
- [02 Chat / Conversation / Realtime](02-chat-conversation-realtime.md)
- [03 Settings](03-settings.md)
- [04 Apps / MCP / Skills / Extensions](04-apps-mcp-skills-extensions.md)
- [05 Assistants / Users / Tasks](05-assistants-users-tasks.md)
- [06 Knowledge / Memory / CodeMap](06-knowledge-memory-codemap.md)
- [07 Repository / Repo Review](07-repository-repo-review.md)
- [08 Workflow / Workteam](08-workflow-workteam.md)
- [09 IM / E2EE](09-im-e2ee.md)
- [10 Stock / Soul / Tavern / Companion / Live2D](10-stock-soul-tavern-live2d.md)
- [11 Terminal / Browser / Share / Approval / Subagent](11-terminal-browser-share-approval-subagent.md)
- [12 Global API / URL Audit](12-global-api-url-audit.md)

