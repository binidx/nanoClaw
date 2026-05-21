# 09 IM / E2EE

## 结论

IM 核心 API 覆盖较全，消息、文件、好友、群组、通知、E2EE、通话等都有 helper 和后端路由。主要缺口是 URL 状态、列表/消息窗口化、已读重复上报、部分后端能力无 UI，以及 E2EE key 生命周期。

## 关键问题

- P1：`/im/...` 只识别为 `im` 页面，二级路径不解析；activeJid 只存在本地 state。位置：`paths.ts:10`、`App.tsx:3582`、`ImPage.tsx:229`、`:1091`。
- P2：会话列表每次 render filter + sort，未 useMemo；会话/好友全量 map。位置：`ImSidebar.tsx:189`、`:322`、`:515`。
- P2：消息列表全量渲染所有已加载消息，并在 render 中做 URL 提取、mention、reply、reaction。位置：`ImMessageList.tsx:355`。
- P2：link preview 每条消息最多 3 个，缓存是无上限全局 Map。位置：`ImMessageList.tsx:434`、`ImLinkPreview.tsx:5`。
- P2：已读上报 effect 依赖整个 messages 数组，编辑/解密/reaction 可能重复上报同一 last message。位置：`ImPage.tsx:319`。
- P2：IM 局部 `.im-info-panel-input` 用 background shorthand，可能覆盖 select chevron。位置：`pages-misc.css:7700`、`forms.css:49`。
- P1：E2EE 开启时总是创建并覆盖本地 room key；关闭再开启可能导致旧消息无法解密。位置：`im-e2ee.ts:473`、`:281`、`ImInfoPanel.tsx:383`。

## 后端能力未充分暴露

- 群资料编辑：`im-api.ts:306`、`im-routes.ts:1445`
- 邀请/移除成员、角色变更：`im-api.ts:431`、`im-group-routes.ts:57`、`:107`
- 公开群搜索/入群申请/审批：`im-api.ts:444`、`im-group-routes.ts:144`
- 删除好友：`im-api.ts:276`、`ImSidebar.tsx:538`
- 置顶消息 pin/unpin：`im-api.ts:562`、`ImInfoPanel.tsx:442`
- typing 和 read cursor 查询：`im-api.ts:501`、`im-routes.ts:1709`

## 优化建议

1. 定义 `/im/chats/:jid`、`/im/friends/:userId`、`/im/groups/:jid`，ImPage hydrate URL 状态。
2. 会话/好友列表 memo row；消息列表引入窗口化；link preview 做 LRU/TTL 且只对可视区触发。
3. 已读上报记录 `lastMarkedMessageId/Seq`，游标前进才调用。
4. 群管理、公开群、好友删除、pin、typing/read cursor 按优先级补 UI。
5. E2EE 优先复用已有 room key；需要轮换时引入 key id/epoch，多 key 存储和 envelope 标识。

