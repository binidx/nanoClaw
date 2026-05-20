# IM 与端到端加密

NanoClaw 的 IM 是独立于 AI 主聊天页的内部消息系统，覆盖好友私聊、群聊、附件、实时事件、AI 成员和端到端加密。当前 E2EE 只保护 IM 会话，不改变普通 ChatPage 的 Agent 会话链路。

## IM 主链路

- 会话元数据存在 `im_chat_meta`，成员关系存在 `im_memberships`，消息正文复用通用 `messages` 表。
- 私聊 JID 由双方用户 ID 排序后确定，形如 `im_dm_{min}_{max}`，用于保证同一对用户只有一个 DM。
- 群聊 JID 使用随机 UUID，形如 `im_grp_{uuid}`。
- 前端 `web/src/pages/im/ImPage.tsx` 拉取会话、成员和消息快照，再通过 WebSocket 的 `im_event` 做增量合并。
- 后端 `src/routes/im-routes.ts` 校验成员权限、好友/黑名单/额度规则，写入消息后记录 `im_events` 并广播。

## E2EE 开启边界

E2EE 是按会话开关控制的，字段是 `im_chat_meta.e2ee_enabled`。

- 新建私聊当前默认启用 E2EE。
- 已存在的未加密私聊或群聊开启 E2EE 时，历史消息不会回填加密。
- 开启后发送的新文本消息和附件会加密。
- 开启后服务端拒绝明文消息；未开启的会话也拒绝加密 payload，避免状态不一致。
- 关闭 E2EE 后，新消息恢复明文发送，但已经加密的历史消息仍然只保存密文 envelope。

## 密钥模型

每个浏览器设备都有自己的设备密钥对，不是双方共用同一把私钥。

- 设备私钥：由浏览器 Web Crypto 生成 ECDH P-256 私钥，保存在本机 IndexedDB。
- 设备公钥：上传到服务端 `im_device_keys`，供其他成员给这个设备分发 room key。
- Room key：每个加密会话使用一个 AES-256-GCM room key 加密消息和附件。
- Wrapped room key：发送方用 ECDH + HKDF 为每个目标设备派生包装密钥，把 room key 加密后上传到 `im_room_keys`。
- Wrapped room key 上传时，后端会校验目标 `(user_id, device_id)` 必须已经存在于 `im_device_keys`；不能把 room key 写给不属于目标用户的设备。
- 新设备加入后，如果服务端没有这个设备可解的 wrapped room key，需要已有持有 room key 的设备执行“重新分发密钥”。

因此，“我的密钥和对方一样吗”的准确答案是：设备私钥不一样；双方能读同一个加密会话，是因为各自设备都拿到了同一个 room key 的可解密副本。

## 消息与附件加密

- 文本消息和附件元数据先组成明文 payload，再用 room key 通过 AES-GCM 加密。
- 服务端 `messages.content` 只保存 `[encrypted]` 占位符。
- 密文 envelope 独立保存到 `im_message_crypto`，包含版本、算法、IV、AAD 和 ciphertext。
- 附件文件内容在上传前由前端加密，服务端保存的是 `encrypted.bin` 这类密文文件。
- 收件端加载历史或收到 WebSocket 新消息后，在浏览器本地用 room key 解密展示。

服务端仍能看到会话成员、消息时间、发送者、附件密文大小、密文 envelope 和 wrapped room key；服务端不能直接读取加密后的消息正文或附件原文。

当前官方前端会在上传前加密 E2EE 附件，但后端上传接口本身无法证明客户端上传的 bytes 一定是密文。因此这个安全边界不覆盖恶意客户端或绕过官方前端的客户端。

当前官方前端会在 E2EE 房间禁用服务端链接预览，后端 `/api/im/link-preview` 接口也会拒绝加密房间请求，避免把 URL 这类明文派生信息发送给服务端或三方站点。

## AI、搜索与协作限制

E2EE 会话不允许 AI 成员读取或介入。

- 开启 E2EE 时，后端会移除活跃 AI 成员，并把排队或运行中的 AI invocation 标记失败。
- 加密房间内发送消息不会触发 mentions 解析。
- IM 服务端搜索会排除 `e2ee_enabled = 1` 的会话，因为服务端只有 `[encrypted]` 占位符和密文。

非 E2EE 房间允许 IM AI 成员介入；这类调用会把近期房间明文消息拼入模型 prompt，并可能记录 prompt trace。需要把非 E2EE IM AI 视为“明文会话交给模型供应商处理”的能力。

## 当前安全边界

当前实现是房间密钥式客户端加密，不是完整 Signal 双棘轮协议。

- 没有安全码/指纹验证 UI，用户无法在产品内验证对方设备公钥是否被替换。
- 没有 per-message ratchet 或自动前向保密轮换；room key 在同一加密会话内复用。
- 本机 IndexedDB 中的设备私钥和 room key 依赖浏览器与操作系统账户边界保护。
- 服务器可以删除或拒绝分发 wrapped room key，导致新设备无法读取历史加密消息。

这些边界不影响当前目标：让服务端和 AI 无法读取开启 E2EE 后的新 IM 消息内容；但如果要达到更强的端到端安全语义，需要补设备验证、密钥轮换和更严格的多设备信任模型。

## 排障

如果旧浏览器或 WebView 报 `crypto.randomUUID is not a function`，根因是环境缺少 Web Crypto 的 `randomUUID()` 方法。前端 IM 代码应使用 `createImUuid()`，它会优先使用原生 `randomUUID()`，缺失时回退到 `crypto.getRandomValues()` 生成 UUID v4。

如果报 `crypto.subtle` 或 `crypto.subtle.generateKey` 不存在，说明当前浏览器环境不支持 E2EE 需要的 SubtleCrypto。常见原因是通过普通 HTTP/IP 访问页面，而不是 HTTPS 或 localhost；旧 WebView 也可能只提供 `webkitSubtle` 或完全不支持 SubtleCrypto。当前前端会兼容 `webkitSubtle`，但完全缺失 SubtleCrypto 时无法安全创建 ECDH/AES 密钥，必须换用支持 Web Crypto 的浏览器或安全上下文。

如果加密会话显示“密钥缺失”，通常是当前设备没有 room key：

- 在已有持钥设备上打开会话信息面板，点击“重新分发密钥”。
- 确认当前设备已经成功注册设备公钥。
- 如果所有持钥设备都丢失，本实现无法从服务端密文恢复 room key。
