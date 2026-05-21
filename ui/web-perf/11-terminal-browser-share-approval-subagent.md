# 11 Terminal / Browser / Share / Approval / Subagent

## 结论

终端、浏览器控制、分享、审批、子代理 activity 的前后端绑定基本存在。主要问题是终端并非完整 PTY、浏览器前端动作少于后端能力、大对象渲染未限制、ToolResultCard 折叠仍预渲染正文、审批 scope UI 与后端语义不一致。

## 关键问题

- P2：终端前端发送 resize，但后端忽略；后端用 `spawn(... stdio: 'pipe')`，不是 PTY。位置：`useTerminalSession.ts:181`、`websocket-handlers.ts:741`、`:463`。
- P2：xterm 直接 `term.write(event.data)`，大输出可能阻塞；resize 只监听 window，不监听容器。位置：`useTerminalSession.ts:215`、`:208`。
- P2：Browser 前端动作只有 navigate/click/type/press/hover/scrollIntoView/wait/waitFor；后端还支持 close/back/forward/reload/select/scroll/evaluate。位置：`BrowserControlPanel.tsx:16`、`browser-routes.ts:186`。
- P2：role snapshot 请求不传 `maxChars/maxNodes`，前端默认打开多个重资产 details，全量 `<pre>` 渲染。位置：`BrowserControlPanel.tsx:440`、`:1023`、`:1135`、`browser-routes.ts:369`。
- P2：ToolResultCard 折叠阈值 500 字符，但 body 仍完整高亮/Markdown 渲染，CSS 只是隐藏。位置：`ToolResultCard.tsx:228`、`:240`、`ToolResultCard.css:82`。
- P2：创建分享时前端提交 selected entry keys，后端重新读取最多 100000 条 messages/turns 后过滤。位置：`App.tsx:2217`、`share-routes.ts:85`。
- P1：DirectoryAccess 审批前端显示 scope 选择，但后端强制 `current_tool_call`。位置：`ApprovalOverlay.tsx:164`、`conversation-admin-support.ts:223`。
- P3：审批倒计时进度硬编码 120 秒。位置：`ApprovalOverlay.tsx:109`、`websocket-handlers.ts:108`。
- P2：子代理 runtime detail 后端存在，前端仅 settings inline flat 视图，无 `/settings/subagent/:runtimeId`。位置：`system-read-routes.ts:370`、`useSettingsPageModel.tsx:424`、`SubagentRuntimeExplorer.tsx:312`。

## 优化建议

1. 明确终端定位：若是命令终端，UI 文案说明限制；若要完整终端，接入 PTY 并处理 cols/rows。
2. xterm 输出加 queue + RAF 批量写入；使用 `ResizeObserver` 监听 terminal host。
3. Browser 补齐 back/reload/select/scroll，evaluate 放高级折叠区；role snapshot 默认传 maxChars/maxNodes。
4. ToolResultCard 折叠态只渲染摘要，展开时再渲染高亮/Markdown 正文。
5. DirectoryAccess 隐藏或锁定 scope；倒计时根据 `createdAt/expiresAt` 动态计算。
6. 分享服务端按 entry key 类型定向读取，避免大对话全量重建。
7. 增加 `/settings/subagent/:runtimeId` 或 `/subagents/:runtimeId` 详情 URL。

