# 10 Stock / Soul / Tavern / Companion / Live2D

## 结论

Stock、Tavern、Companion、Live2D 主链路基本可用。高优先级风险包括 Stock 报告详情无 URL、Stock 轮询和 SSE 重复刷新、Soul memory documents 用户隔离、Tavern 模型绑定校验、Live2D 大文件上传内存成本。

## 关键问题

- P1：StockAnalysis 报告详情只存在 state，后端已有详情能力。位置：`StockAnalysisPage.tsx:1784`、`:2480`、`:2972`、`stock-analysis-routes.ts:327`、`:387`。
- P2：Stock 同时 30 秒轮询 history/feedback/provider，SSE 任务完成后又刷新同三类数据。位置：`useStockAnalysisRemoteData.ts:573`、`:590`、`stock-analysis-routes.ts:259`。
- P1：Soul `/api/soul/memory-documents` 未按用户隔离；`memory-events` 有 userId 过滤，但 documents route 没传用户。位置：`SoulPage.tsx:485`、`soul-routes.ts:672`、`:715`、`src/db/memory.ts:134`。
- P1：Tavern 保存 providerId/model，后端只校验 provider 可见性，未校验 model 属于 provider。位置：`TavernPage.tsx:339`、`tavern-routes.ts:55`、`:191`、`runtime-dispatch.ts:1354`。
- P1：Live2D ZIP 上传走 `arrayBuffer -> Uint8Array.reduce -> btoa -> JSON`，后端允许 100MB base64，上传后还立即加载模型生成缩略图。位置：`Live2DSettingsTab.tsx:212`、`:236`、`live2d-routes.ts:175`。
- P2：Soul 首屏并发 9 个请求，events/documents 默认 100/200 条。位置：`SoulPage.tsx:499`、`:478`。
- P2：Tavern persona 编辑、历史、config overlay 都是本地 state，没有 `/tavern/:personaId`。位置：`TavernPage.tsx:167`、`:318`、`:652`、`:1077`。
- P2：Live2D 多处硬编码 `/api`，未接 `apiBase`，非同源部署不一致。位置：`Live2DPanel.tsx:27`、`:140`、`Live2DChatConfig.tsx:32`、`Live2DSettingsTab.tsx:135`。
- P2：Live2D mousemove 未节流，collapsed 时仍注册；ticker 未随页面隐藏暂停。位置：`Live2DPanel.tsx:183`、`:234`。
- P3：Companion Live2D ticker 页面隐藏未暂停，打字机每 30ms setState，CSS 动画缺 `prefers-reduced-motion`。位置：`CompanionPage.tsx:361`、`:473`、`companion.css:116`。

## 优化建议

1. Stock 增加 `/stock-analysis/reports/:reportId` 或 `?report=`，同步 detailView/overviewSection。
2. SSE connected 时暂停或降频轮询，刷新函数合并去抖。
3. 修复 Soul memory-documents 用户隔离，route 层传用户，DB 查询增加 user/owner 映射。
4. Tavern 后端校验 provider-model 绑定，前端模型下拉按选中 provider 过滤。
5. Live2D 上传改 multipart/FormData；缩略图后台或闲时生成。
6. Live2D/Companion 动画与 ticker 在 `document.hidden` 暂停，mousemove/typing 用 RAF 或降频。
7. Tavern 增加 persona/config/history URL，抽共享 helper 收敛 `TavernPersonasPanel` 与 `TavernPage` 双实现。

