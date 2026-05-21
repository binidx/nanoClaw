# 04 Apps / MCP / Skills / Extensions

## 结论

MCP/Skill 创建、导入、编辑、删除、可见性切换已通过 `useUserMcp/useUserSkills` 接到 `/api/user/*`。Registry install 和 Public Library install 路由存在。主要问题是市场源管理接错能力面、失败后抽屉关闭、详情 URL 缺失，以及首屏加载过多。

## 关键问题

- P1：Store 的“源管理”打开 `MarketSourceAdmin`，调用 `/api/admin/marketplace-sources`，但当前 registry 商品源来自 env 或本地目录，该按钮对 StorePanel 当前 registry 列表可能无影响。位置：`StorePanel.tsx:149`、`MarketSourceAdmin.tsx:26`、`src/extension/registry-service.ts:62`。
- P2：创建/导入/AI 生成失败时 drawer 无条件关闭。hooks 返回 `null/false` 并设置 error，但 `MyAppsPanel` await 后关闭。位置：`MyAppsPanel.tsx:304`、`:319`、`:329`、`:340`。
- P2：Store 分区切换只清 search，不清 `typeFilter`，也不同步到新 section hook。位置：`StorePanel.tsx:76`。
- P2：Public Library install/delete 失败不设置 error，StorePanel 只显示 registry error。位置：`usePublicLibrary.ts:69`、`StorePanel.tsx:122`。
- P2：Apps 只有 `/apps/my-apps` 和 `/apps/store` tab URL；AppCard `id` 未用于详情/链接。位置：`AppsPageV2.tsx:28`、`AppCard.tsx:9`、`:34`。
- P3：`McpCreateDrawer` 已导入 `NcSelect`，但 Transport 仍用裸 `<select>`。位置：`McpCreateDrawer.tsx:5`、`:160`。
- P3：`AppsPageV2` 首屏无论 tab 都加载 MCP、Skills、Public Library、Registry。位置：`AppsPageV2.tsx:34`、`:66`。

## 优化建议

1. 将“源管理”接到实际 registry catalog source 配置；或只在 public library marketplace 区域显示。
2. 创建/导入回调返回成功状态，只有成功时关闭 drawer，失败保留表单。
3. 增加 `/apps/my-apps/:type/:id`、`/apps/store/:source/:id` 或 query detail URL，用 drawer 承载详情。
4. Store 数据延迟到进入 store tab；搜索 fetch 加 AbortController 或 stale response guard。
5. 统一 Transport 等低基数字段控件，减少裸 select 分叉。

