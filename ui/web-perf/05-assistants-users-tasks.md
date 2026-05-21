# 05 Assistants / Users / Tasks

## 结论

CRUD/执行 API 大体已绑定。主要风险是 Tasks 操作不检查失败、Users 部分请求绕过统一层、详情 URL 不完整，以及全量轮询/前端过滤造成性能边界。

## 关键问题

- P1：Tasks pause/resume/delete 不检查 `res.ok`，删除失败也会关闭详情。位置：`TasksPageContainer.tsx:108`、`TasksPage.tsx:1323`。
- P2：Tasks 卡片快捷按钮在 paused 状态变成 resume，否则 run；详情里 paused 任务同时有执行和恢复，语义不清。位置：`TasksPage.tsx:892`、`:1277`。
- P2：Users 新建角色直接 `fetch('/api/roles')`，未用 `apiBase`、`requestJsonT`、统一 credentials。位置：`UsersPage.tsx:1955`。
- P2：Users 权限覆盖新增/删除不检查失败，catch 静默。位置：`UsersPage.tsx:2415`、`:2436`。
- P1：Tasks 详情只靠 `selectedTaskId`，无 `/tasks/:taskId`。位置：`TasksPage.tsx:411`、`:735`。
- P1：Assistants 支持 `/assistants/:id` 打开，但处理后 replace 回 `/assistants`，详情 URL 不持久。位置：`App.tsx:3691`、`:3703`。
- P2：Users 只有 tab URL，用户/角色/仓库/权限目标都是本地 state。位置：`UsersPage.tsx:636`、`:647`。
- P2：Tasks 每 1.5 秒轮询全量 `/api/tasks`，并前端搜索/排序。位置：`TasksPageContainer.tsx:216`、`TasksPage.tsx:459`。
- P3：Assistants 资源卡 checkbox 样式弱，建议补 `accent-color` 与 focus-visible。位置：`assistants.css:4112`。

## 优化建议

1. Tasks pause/resume/delete 返回 boolean，失败保留详情并展示 notice。
2. 拆清“立即执行”和“恢复计划”的按钮语义。
3. Users 全部 mutation 统一 `requestJsonT`，保证 `apiBase`、credentials、错误提示一致。
4. 二级 URL：`/tasks/:taskId`、`/tasks/:taskId/edit`、`/users/users/:userId`、`/users/roles/:roleId`、`/assistants/:id` 保持到关闭详情。
5. Tasks 改运行态增量刷新或服务端分页/筛选；Users 大表预计算 searchable 字段或后端查询。

