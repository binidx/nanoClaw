# 12 Global API / URL Audit

## 结论

静态核对未发现明确的前端按钮调用未注册 API 的硬 404。`src/web/web-server.ts` 已注册主要 route：用户、IM、知识库、Provider、Channel、Assistant、RepoReview、Workflow、Conversation 等在 `src/web/web-server.ts:782-1003` 挂载；`/api/client-error` 在 `src/web/web-server.ts:349` 注册。

主要问题是：

- 后端已有关键能力，但前端没有显式入口或只接旧入口。
- 多个详情页/详情弹窗仍是本地 state，缺少可分享二级 URL。

## 二级 URL 缺口

- P1：CodeMap 独立页面逻辑存在但未挂全局路由。位置：`CodeMapPage.tsx:102`、`paths.ts:4`、`RepoReviewSettingsPanel.tsx:5393`。
- P1：Repo 详情 tab 和 CodeMap overlay 不可分享。位置：`RepositoryPage.tsx:21`、`RepoReviewSettingsPanel.tsx:1154`、`:1156`。
- P1：Tasks 详情抽屉不可分享。位置：`TasksPage.tsx:411`、`:735`、`:1241`。
- P1：Knowledge 文档/Wiki 详情没有 URL。位置：`KnowledgePage.tsx:594`、`:630`、`:2246`、`:1120`。
- P1：Workteam run/node/edge 详情不可分享。位置：`WorkteamPage.tsx:1005`、`:1019`、`:2955`。
- P2：StockAnalysis 报告详情不可分享。位置：`StockAnalysisPage.tsx:1786`、`useStockAnalysisRemoteData.ts:233`、`StockAnalysisPage.tsx:2482`。
- P2：Tavern persona 详情建议增加 shareable URL。

## 后端能力未明显接入前端

- 多用户渠道实例：`/api/user/channels` CRUD 已注册，但前端仍主要走 `/api/channel-config`。位置：`channel-instance-routes.ts:158`、`web-server.ts:805`、`useAppBootstrap.ts:492`、`useSettingsActions.ts:167`。
- Memory identity：`/api/memory/identities` 有 profile/detail/create/bind，前端无明显入口。位置：`memory-identity-routes.ts:32`。
- Unified retrieval：`/api/retrieval/search` 有统一检索，前端无明显调试入口。位置：`retrieval-routes.ts:41`。
- `/api/code-search/*` stub 或旧入口需要文档化或清理，避免误判为可用功能。

## 优化建议

1. P1：CodeMap 与 Repo 详情 URL 先做，避免“页面代码存在但无法直达”。
2. P1：Tasks、Knowledge 文档/Wiki、Workteam run 加 URL hydration。
3. P2：多用户渠道实例 API 接入 Channels/Settings，或标记为暂未启用能力。
4. P2：Stock 报告详情、Tavern persona 详情增加 URL。
5. P3：对旧 stub、隐藏能力、内部 API 做文档标注，降低后续误维护概率。

