# 01 App Shell / Routing / Common

## 结论

全局路由和壳层稳定，`/chat/:jid`、`/assistants/:id`、`/repos/:id`、`/workteam/:id`、Knowledge query state 已有不同程度支持。但 CodeMap 代码存在却没有顶层挂载；多个 common 控件和全局表单样式存在浏览器原生样式或默认行为风险。

## 关键问题

- P1：CodeMap 页面没有顶层路由。`VALID_PAGES` 不含 `codemap`/`code-map`，`App.tsx` 也没有 `CodeMapPage` 分支；目前只在 RepoReview overlay 使用。位置：`web/src/router/paths.ts:4`、`web/src/App.tsx:3965`、`web/src/components/RepoReviewSettingsPanel.tsx:5391`。
- P1：Workteam 读取 `/workteam/:id`，但选择工作流、创建后选择、返回列表只改 state，不同步 URL。位置：`web/src/pages/WorkteamPage.tsx:1005`、`:1783`、`:2435`、`:2486`。
- P2：`forms.css` 注释宣称覆盖裸 button，但实际全局 reset 只覆盖 input/textarea/select；新增无 class button 仍可能露出原生按钮。位置：`web/src/styles/forms.css:1`、`:5`、`:193`。
- P2：`input[type=file]` 未覆盖 `::file-selector-button`，文件选择按钮可能显示浏览器原生样式。位置：`web/src/styles/forms.css:66`。
- P2：`NcButton` 和 Pagination button 未默认 `type="button"`，放进 form 时可能触发表单提交。位置：`web/src/components/common/NcButton.tsx:62`、`Pagination.tsx:45`。
- P3：`DataTable` 排序表头使用 `<th onClick>`，缺少 `tabIndex`、键盘处理、`aria-sort`。位置：`web/src/components/common/DataTable.tsx:58`。
- P3：多层 `backdrop-filter` 和 shadow 叠加在滚动容器、Nav、控件上，低端设备有绘制成本。位置：`web/src/styles/layout.css:94`、`web/src/styles/nav.css:4`、`web/src/styles/forms.css:22`。

## 优化建议

1. 明确 CodeMap 路由策略：优先接到 `/repos/:id/codemap?branch=...`，或新增一等 `/codemap/:repositoryId`。
2. Workteam 详情选择统一通过 `navigate` 写入 URL，关闭回到 `/workteam`。
3. 建立 common 控件基线：所有 shared button 默认 `type="button"`；排序表头改真实 button；卡片点击组件避免 `div role="button"`。
4. 补齐全局文件按钮样式，并对裸 button 做明确策略：要么禁用裸 button，要么提供一致基线。
5. 对 frosted glass 做性能预算：大滚动容器用静态半透明背景，固定层和小控件保留 blur。

