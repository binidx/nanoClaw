# 07 Repository / Repo Review

## 结论

RepoReview 的 review/sync/digest/profile API 主链路完整。主要缺口是深链、runs-summary 性能、i18n 重复键、旧组件样式/可访问性分叉。

## 关键问题

- P1：`/repos/:repositoryId` 只支持一级仓库 ID；`repoDetailTab`、`selectedRunId`、digest detail、branch modal 都是本地 state。位置：`RepositoryPage.tsx:21`、`RepoReviewSettingsPanel.tsx:1153`、`:1190`、`:1200`。
- P2：主面板拉 runs-summary 未传 limit，后端支持 limit；前端本地分页。位置：`RepoReviewSettingsPanel.tsx:2331`、`src/routes/repo-review-routes.ts:795`、`RepoReviewSettingsPanel.tsx:1560`。
- P2：搜索输入变化触发请求，缺少 debounce。位置：`RepoReviewSettingsPanel.tsx:2744`。
- P2：i18n 重复键覆盖变量：`profile.count`、`branchStatus.branchCount` 在 zh/en locale 重复，后者缺 `{{count}}`。位置：`web/src/i18n/locales/zh/repoReview.json:228`、`:502`、`:206`、`:574`。
- P3：`RepoReviewBranchStatusModal` 使用 `div role="button"`；`RepositoryReviewTab` 未被主页面引用且硬编码 `/reviews`；`RepositoryBindingPicker` 有内联样式和 `window.confirm`。位置：`RepoReviewBranchStatusModal.tsx:188`、`RepositoryReviewTab.tsx:77`、`:159`、`RepositoryBindingPicker.tsx:130`、`:223`。

## API 挂载情况

已确认主要链路：

- `/sync-branch`：`web/src/components/repo-review/api.ts:273` -> `src/routes/repo-review-routes.ts:638`
- run detail：`api.ts:204` -> `repo-review-routes.ts:910`
- rerun/cancel：`api.ts:326` -> `repo-review-routes.ts:973`
- digest list/detail：`api.ts:243` -> `repo-review-routes.ts:832`
- profile save/delete：`RepoReviewSettingsPanel.tsx:3373` -> `repo-review-routes.ts:683`

## 优化建议

1. 增加 `/repos/:repoId/runs/:runId`、`/branches/:branch`、`/digest/:id`、`/profile/:profileId` 深链。
2. runs-summary 改服务端分页/limit，搜索加 250-400ms debounce。
3. 添加 locale duplicate-key lint，清理旧 `profile.field.*` 与新 `profile.*` 混杂。
4. 替换 `div role="button"`、`window.confirm`、硬编码 `/reviews` 和旧内联样式组件。
5. 判断 `RepositoryReviewTab` 是否废弃；不用则删除或文档标注。

