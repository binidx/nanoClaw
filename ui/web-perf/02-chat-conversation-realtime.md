# 02 Chat / Conversation / Realtime

## 结论

会话、上传、中断、重试、provider/model override 等主链路均已接到后端。主要风险在 realtime 判重、水位、消息 hash 深链、附件命令语义和侧边栏高频更新性能。

## 关键问题

- P1：消息锚点只在已加载窗口内查找。`#msg-*` 目标不在首屏或当前虚拟数据中时不会继续加载旧消息。位置：`web/src/pages/ChatPage.tsx:1025`。
- P1：snapshot 不推进 realtime watermark，迟到 WebSocket 事件可能回放。位置：`web/src/conversation-realtime.ts:39`、`web/src/hooks/useConversationRealtime.ts:126`。
- P2：normalizer 支持 IM 事件，但 chat realtime hook 不消费 `im_event`。位置：`web/src/conversation-realtime.ts:545`、`web/src/hooks/useConversationRealtime.ts:261`。
- P2：切换会话时清空旧 activeJid 的消息缓存，返回会话需要重新拉首屏。位置：`web/src/App.tsx:2315`。
- P2：reasoning/tool 使用原生 `<details>`，展开状态不持久，虚拟列表重挂会丢状态。位置：`web/src/pages/ChatPage.tsx:1501`、`:1568`。
- P2：选择超大文件时直接 return，无可见错误。位置：`web/src/App.tsx:2467`。
- P2：前端允许 `/command` 携带附件，后端命令分支实际不消费附件，只提示忽略。位置：`web/src/App.tsx:2677`、`src/routes/conversation-message-routes.ts:424`。
- P3：侧边栏 `busyByJid`、`unreadRepliesByJid` 任意变化会重新 map 全部会话，并可能触发 active item 滚动。位置：`web/src/components/ConversationSidebar.tsx:206`、`:256`。

## API 挂载情况

已确认正常：

- Provider/model override：`ChatPage.tsx:1877` -> `conversation-admin-routes.ts:918`。
- 中断/重试：`App.tsx:1700`、`:1732` -> `conversation-admin-routes.ts:758`、`:788`。
- 上传文件预览/下载：`ChatPage.tsx:163` -> `conversation-message-routes.ts:342`。

## 优化建议

1. 为消息深链增加后端定位接口，例如 `messageId -> cursor/index`；hash 未命中时自动加载。
2. 明确 snapshot watermark 语义：快照应推进水位，或 live 判重读取 snapshot seq。
3. Slash command 发送前检测附件，阻止或明确提示“命令不会使用附件”。
4. 会话缓存保留已加载 messages，仅清 transient 状态；需要控内存时做 LRU。
5. 侧边栏 row 派生下沉到 memoized row，active 滚动只依赖 activeJid 和排序/搜索变化。

