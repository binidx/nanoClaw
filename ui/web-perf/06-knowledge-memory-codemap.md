# 06 Knowledge / Memory / CodeMap

## 结论

Knowledge 和 CodeMap 功能丰富，但重数据页面有较明显的分页、取消请求、图布局、二级 URL 和 API helper 统一问题。Memory 前端主要是设置项，未发现独立重负载 UI。

## 关键问题

- P1：CodeMap API 多数 fetch 未带 `credentials: 'include'`，跨源 `apiBase` 下可能丢 cookie。位置：`web/src/components/code-map/code-map-api.ts:282`、`:506`、`:538`、`:568`、`:646`、`:705`。
- P1：`rebuildCodeMap()` 实际调用 `/api/code-index/:repositoryId/rebuild`，没有调用 `/api/code-map/:repositoryId/rebuild`；code-index unchanged 时可能无法补建 CodeMap snapshot。位置：`code-map-api.ts:498`、`src/routes/code-index-routes.ts:1040`。
- P1：Knowledge 只保存 `kb/tab/content/view`；文档/Wiki 详情只写本地 state。位置：`KnowledgePage.tsx:597`、`:1120`、`:2246`。
- P1：CodeMap 读取 `branch/name`，但 tab/file/scope/search/qa 都是本地 state。位置：`CodeMapPage.tsx:107`、`:130`、`:133`、`:793`。
- P2：Knowledge 文档列表拉全量再本地 slice，后端已支持 `page/pageSize/search`。位置：`KnowledgePage.tsx:946`、`:3740`、`knowledge-routes.ts:409`。
- P2：Knowledge 切 KB 和 LLM 轮询没有 AbortController/request token，可能陈旧响应覆盖新状态。位置：`KnowledgePage.tsx:1349`、`:1395`。
- P2：CodeMap 图每次状态变化重做排序、建边、布局，并用 SVG 全量渲染。位置：`CodeMapGraphView.tsx:452`、`:716`、`:763`。
- P2：CodeMap 树没有虚拟化，且存在内联 SidebarTree、`CodeMapTreeView`、`CodeMapPanel` 多套实现。位置：`CodeMapPage.tsx:986`、`:1008`、`CodeMapTreeView.tsx:23`。
- P3：文档替代跳转用 `span role="button"`。位置：`KnowledgePage.tsx:3768`。

## 优化建议

1. 在 `code-map-api.ts` 建统一 request helper，默认 credentials、JSON 错误解析、abort signal。
2. 明确 CodeMap rebuild 语义：需要保证 CodeMap 可用时调用 code-map rebuild，或 code-index unchanged 分支补写 snapshot。
3. Knowledge 增加 `doc=`、`wiki=`、可选 `chunk/heading` 参数；CodeMap 增加 `tab/file/scope/query` URL 状态。
4. Knowledge 文档切服务端分页；轮询加 abort/sequence guard。
5. CodeMap 图布局缓存或 worker 化；树收敛为一个 flatten + windowing 组件。

