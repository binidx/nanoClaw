# 08 Workflow / Workteam

## 结论

Workflow 主链路已迁到 `/api/workflows`，工作流、节点、边、运行、transfer、artifact 主要按钮都有后端路由承接。页面仍是单页内部状态工作台，运行/节点/边没有深链；画布拖拽和列表摘要存在明显性能优化空间。

## 关键问题

- P1：只有 `/workteam/:workflowId`，run/node/edge 详情都是本地 state。位置：`WorkteamPage.tsx:1004`、`:1019`、`:2955`、`:2775`、`:2682`。
- P1：选择工作流、创建后选择、返回列表只改 state，不 `navigate`。位置：`WorkteamPage.tsx:2435`、`:1783`、`:2486`。
- P2：mousemove 拖拽中对每个节点调用 `setSnapshotNode`，导致整页和派生 memo 高频重算。位置：`WorkteamPage.tsx:1622`、`:1557`。
- P2：边渲染每条边在节点数组中 `find` 两次，O(E*N)。位置：`WorkteamPage.tsx:2669`。
- P2：TS 几何常量与 CSS 覆盖不一致，连线端点和框选命中可能偏差。位置：`WorkteamPage.tsx:417`、`:642`、`WorkteamPage.css:2808`。
- P2：列表页摘要为 N+1 API：请求 `/api/workflows` 后对每个 workflow 拉 snapshot 和 runs。位置：`WorkteamPage.tsx:1185`、`workflow-routes.ts:154`。
- P2：后端存在 run cancel、evaluate、workflow delete，前端未看到完整入口。位置：`workflow-routes.ts:965`、`:694`、`:248`。
- P2：`WorkflowRepositoryPanel` 实现了仓库绑定和 runner profile，但未接入 `WorkteamPage`。位置：`WorkflowRepositoryPanel.tsx:68`、`WorkteamPage.test.ts:34`。
- P3：节点 `<button>` 内嵌 `span role="button"` 作为连接入口，键盘行为不完整。位置：`WorkteamPage.tsx:2714`、`:2792`。

## 优化建议

1. 定义 `/workteam/:workflowId/runs/:runId`、`?node=`、`?edge=`，所有选择动作同步 URL。
2. 拖拽中用 ref + CSS transform + RAF 临时渲染，mouseup 后一次性提交 snapshot。
3. 建 `nodeById` map，边渲染避免 O(E*N)。
4. 用 CSS 变量或统一常量生成节点尺寸和连线几何。
5. 后端增加 summary/list endpoint，或 `/workflows?includeSummary=1` 返回 workerCount/edgeCount/latestRun。
6. 接入或移除 `WorkflowRepositoryPanel`，避免死组件和测试 mock 误导。

