# 知识库时序与关联增强设计

## 概述

当前知识库将文档视为扁平、无时间维度的 chunk 集合。本设计引入三层可选增强模式，解决两个核心缺陷：

1. **时序数据**：文档有发布时间和时效性，新文档可能补充或完全覆盖旧文档
2. **关联数据**：文档之间有层级结构（如帮助文档的目录树）和语义关联

灵感来源：Andrej Karpathy 的 LLM Wiki 模式——LLM 不仅检索原始文档，还主动构建和维护结构化知识。

### 设计约定

- HTTP JSON 使用 snake_case 命名；TypeScript 内部使用 camelCase
- `入库时间` 统一指 `knowledge_documents.created_at`
- 覆盖关系的唯一权威来源是 `knowledge_documents.superseded_by` 字段；`knowledge_doc_relations.supersedes` 是 LLM 生成的建议，高置信度时自动同步到 `superseded_by`
- `published_at` 为 NULL 时，时序加权使用 `created_at` 作为回退

## 三层增强模式

每个知识库通过 `enhancement_level` 字段选择模式，高层包含低层全部能力：

| 模式 | 字段值 | 入库成本 | LLM 参与 | 能力 |
|------|--------|---------|---------|------|
| L1 元数据增强 | `metadata` | 零额外成本 | 否 | 时间提取、层级构建、规则式覆盖检测、时序加权检索 |
| L2 LLM Wiki 精简 | `wiki_lite` | LLM 调用 | 异步 | L1 + 摘要生成、实体提取、语义关联检测、矛盾标记 |
| L3 LLM Wiki 完整 | `wiki_full` | 更多 LLM 调用 | 异步 | L2 + wiki 页面生成/维护、交叉引用、综合页面、健康检查 |

L2/L3 模式支持知识库级别独立配置 LLM 模型，允许使用廉价小模型降低成本。

---

## 数据模型

### knowledge_bases 扩展字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enhancement_level` | TEXT | `'metadata'` | 增强模式：`metadata` / `wiki_lite` / `wiki_full` |
| `llm_provider_id` | TEXT | NULL | L2/L3 入库 LLM 的 `ai_providers.id`。解析时走 `getProvider(id)` + 权限校验 |
| `llm_model_override` | TEXT | NULL | 覆盖 provider 默认模型（可选，允许用廉价小模型） |
| `temporal_half_life_days` | INTEGER | 365 | 时序衰减半衰期（天），越短则越倾向新文档 |

### knowledge_documents 扩展字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `published_at` | TEXT | NULL | 文档发布时间（ISO 8601），自动提取或手动填写 |
| `superseded_by` | TEXT | NULL | 替代此文档的新版文档 ID，非 NULL 表示已被覆盖 |
| `parent_doc_id` | TEXT | NULL | 父文档 ID，构建文档层级树 |
| `doc_path` | TEXT | NULL | 层级路径，如 `产品指南/用户管理/权限设置` |
| `depth` | INTEGER | 0 | 层级树深度，0 = 根 |
| `llm_status` | TEXT | NULL | LLM 处理状态：`pending` / `processing` / `done` / `failed`（L2+ 用） |

### knowledge_doc_relations 新表（L2+）

文档间的语义关联关系，由 LLM 检测生成。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PK | |
| `source_doc_id` | TEXT | NOT NULL | 关系起点文档 |
| `target_doc_id` | TEXT | NOT NULL | 关系终点文档 |
| `relation_type` | TEXT | NOT NULL | `supersedes` / `supplements` / `contradicts` / `references`（层级关系使用 `parent_doc_id`，不重复存储） |
| `confidence` | REAL | NOT NULL DEFAULT 0 | LLM 检测置信度（0-1） |
| `detail` | TEXT | | LLM 生成的关系说明 |
| `created_at` | TEXT | NOT NULL | |

索引：`(source_doc_id, relation_type)`, `(target_doc_id, relation_type)`

### knowledge_doc_summaries 新表（L2+）

LLM 生成的文档摘要和实体提取结果。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PK | |
| `document_id` | TEXT | UNIQUE NOT NULL | |
| `summary` | TEXT | NOT NULL | 200-300 字摘要 |
| `entities` | TEXT | | JSON: `[{name, type, salience}]` |
| `topics` | TEXT | | JSON: `["标签1", "标签2"]` |
| `llm_model` | TEXT | | 生成时使用的模型 |
| `created_at` | TEXT | NOT NULL | |
| `updated_at` | TEXT | NOT NULL | |

### knowledge_wiki_pages 新表（L3）

LLM 自动生成和维护的 wiki 页面。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PK | |
| `kb_id` | TEXT | NOT NULL | 所属知识库 |
| `page_type` | TEXT | NOT NULL | `entity` / `concept` / `overview` / `synthesis` / `comparison` |
| `title` | TEXT | NOT NULL | 页面标题 |
| `content` | TEXT | NOT NULL | Markdown 内容 |
| `source_doc_ids` | TEXT | | JSON: 来源文档 ID 列表 |
| `inbound_links` | TEXT | | JSON: 引用本页的 wiki 页面 ID 列表 `["page_id_1", ...]` |
| `outbound_links` | TEXT | | JSON: 本页引用的 wiki 页面 ID 列表 `["page_id_2", ...]` |
| `llm_model` | TEXT | | 生成模型 |
| `version` | INTEGER | NOT NULL DEFAULT 1 | 版本号 |
| `created_at` | TEXT | NOT NULL | |
| `updated_at` | TEXT | NOT NULL | |

索引：`(kb_id, page_type)`, `(kb_id, title)`

Wiki 页面 FTS（三方言）：
- **PostgreSQL**：`search_vector tsvector` 列 + GIN 索引，复用 `pg-fts-config.ts` 检测到的分词配置
- **SQLite**：新建 `knowledge_wiki_pages_fts` FTS5 虚拟表，与 chunk FTS 模式一致
- **MySQL**：content 列上 `FULLTEXT INDEX`，与 chunk FTS 模式一致

### ER 关系

```
knowledge_bases 1──N knowledge_documents
knowledge_documents 1──N knowledge_chunks
knowledge_documents 1──0..1 knowledge_doc_summaries    (L2+)
knowledge_documents N──M knowledge_doc_relations       (L2+)
knowledge_documents 0..1──0..1 knowledge_documents     (superseded_by, L1)
knowledge_documents 0..1──N knowledge_documents        (parent_doc_id, L1)
knowledge_bases 1──N knowledge_wiki_pages              (L3)
knowledge_wiki_pages N──M knowledge_documents          (source_doc_ids)
```

---

## 入库管线

### 统一流程

所有模式共享：分块 → FTS 索引 → 可选嵌入。然后按 `enhancement_level` 分支。

### L1 元数据提取（纯规则，无 LLM）

新增模块 `src/knowledge/metadata-extractor.ts`：

**发布时间提取** `extractPublishedAt(content, sourceUrl?, htmlMeta?)`

优先级：
1. HTML meta: `article:published_time`, `og:updated_time`, `datePublished` (JSON-LD)
2. `<time datetime=...>` 标签
3. URL 路径模式: `/2024/03/15/...`
4. 正文正则: `发布于 YYYY-MM-DD`, `Published: ...`, `更新日期：...`
5. 回退: 入库时间

**层级路径构建** `buildDocHierarchy(kbId, sourceUrl?, zipPath?)`

- URL 导入: 从 URL path segments 构建 `doc_path`，在同 KB 内按路径查找父文档设置 `parent_doc_id`
- ZIP 上传: 使用 zip 内部目录路径
- 手动上传: `doc_path` 默认为空，用户可后续编辑

**覆盖检测** `detectSupersession(kbId, docId, sourceUrl?, filename?)`

- 同 `source_url` 且已存在旧文档 → 旧文档 `superseded_by = docId`
- 同 `filename` + 同 `kb_id` → 旧文档 `superseded_by = docId`
- 被覆盖的文档 `status` 不变，但 `superseded_by` 非 NULL 使其从检索中硬排除

### L2 LLM 精简处理（异步）

新增模块 `src/knowledge/llm-enhancer.ts`：

入库完成后触发异步 LLM 处理。`llm_status` 状态流转：`pending` → `processing` → `done`/`failed`

**异步执行机制**：参考 `memory/compaction-scheduler` 模式，使用 `setImmediate` 触发后台处理，`llm_status` 保证幂等性（`processing` 状态超过 5 分钟自动回退为 `pending`，支持崩溃恢复）。单文档单 flight（按 `document_id` 加锁）。

**LLM 调用封装**：`src/knowledge/llm-call.ts` 通过 `getProvider(kb.llm_provider_id)` 解析凭证，`getProviderAdapter(provider.type)` 获取适配器，`llm_model_override` 覆盖 provider 默认模型。权限校验走 KB owner 的 provider 可见性规则。

**摘要生成** `generateSummary(docContent, llmConfig)`

- 输入: 文档全文（超过 token 限制时取前 N 个 chunks + 最后 1 个 chunk）
- 输出: 200-300 字摘要 → 存入 `knowledge_doc_summaries.summary`
- Prompt 模板要求输出结构化 JSON: `{summary, entities: [{name, type, salience}], topics: [...]}`

**关联检测** `detectRelations(kbId, docId, docSummary, llmConfig)`

- 获取同 KB 内所有已有文档的摘要（`knowledge_doc_summaries`）
- 将新文档摘要与每个已有摘要送入 LLM，判断关系
- 关系类型: `supersedes` / `supplements` / `contradicts` / `references`
- 当 `supersedes` 且 `confidence >= 0.8` 时，自动同步到 `knowledge_documents.superseded_by`
- 输出: `{relation_type, confidence, detail}` → 存入 `knowledge_doc_relations`
- 优化: 当 KB 内文档数量大时，先用嵌入相似度筛选 top-20 候选，再用 LLM 精确判断
- 去重: `(source_doc_id, target_doc_id, relation_type)` UNIQUE 约束

**失败处理**：LLM 调用失败时 `llm_status = 'failed'`，不阻塞 FTS 检索（L1 功能始终可用）。可通过 `POST .../llm-process` 手动重试。

### L3 Wiki 完整处理（异步）

新增模块 `src/knowledge/wiki-maintainer.ts`：

**Gating 规则**：仅对 `llm_status = 'done'` 的文档执行 wiki 处理。L2 失败的文档跳过 L3，不阻塞其他文档的 wiki 更新。

**Wiki 页面更新** `updateWikiPages(kbId, docId, entities, topics, llmConfig)`

- 从 `knowledge_wiki_pages` 中查找与当前文档实体/主题匹配的已有页面
- 将新文档信息整合进已有页面内容
- 更新 `source_doc_ids`、`inbound_links`、`outbound_links`
- 递增 `version`

**新页面创建** `createWikiPagesIfNeeded(kbId, entities, topics, llmConfig)`

- 检查 entities 中是否有尚无对应页面的实体
- 为高显著度实体创建 `entity` 类型页面
- 为新主题创建 `concept` 类型页面
- 当同主题文档 >= 3 篇时，创建或更新 `synthesis` 综合页面

**交叉引用维护** `maintainCrossReferences(kbId, affectedPageIds)`

- 扫描受影响页面的 Markdown 内容
- 自动检测对其他 wiki 页面标题的引用
- 更新双向 link 字段

**健康检查** `lintWiki(kbId, llmConfig)`

手动触发（API: `POST /api/knowledge/bases/:id/lint`）：
- 检测孤立页面（无 inbound links）
- 检测矛盾信息（`contradicts` 关系）
- 检测过时页面（引用的源文档已被覆盖）
- 建议需要创建的缺失页面
- 返回结构化报告

---

## 检索增强

### 过滤已覆盖文档

在所有 FTS/向量查询中添加过滤条件：

```sql
-- FTS 查询增加 JOIN 过滤
SELECT c.* FROM knowledge_chunks c
JOIN knowledge_documents d ON d.id = c.document_id
WHERE d.superseded_by IS NULL
  AND d.kb_id IN (...)
  AND ... -- FTS 条件
```

被覆盖文档的 chunks 从检索结果中硬排除。

向量搜索侧：`searchByVector` 返回结果后，在 `retrieval.ts` 的 hydration/过滤阶段同样排除 `superseded_by IS NOT NULL` 的文档（与现有 `getChunkKbIdMap` KB 过滤复用同一查询路径）。

### 时序加权

时序衰减力度增强（时间是重要因子），加成可达 40%：

```
daysSincePublish = (now - published_at) / 86400000
recencyFactor = max(0, 1 - daysSincePublish / halfLifeDays)
temporalScore = baseScore × (1 + recencyFactor × 0.4)
```

- `halfLifeDays` 由 `knowledge_bases.temporal_half_life_days` 配置，默认 365
- 最新文档最高获得 40% 加成
- 超过半衰期的文档加成趋向 0
- `published_at` 为 NULL 时使用 `created_at` 替代

### 层级上下文扩展

检索结果中每个 chunk 附加元数据：

```typescript
interface EnrichedSearchResult {
  chunkId: string;
  content: string;
  score: number;
  // 新增
  docPath: string | null;        // 面包屑路径
  publishedAt: string | null;    // 发布时间
  parentSummary: string | null;  // 父文档摘要（L2+），L1 时为 null
  docSummary: string | null;     // 当前文档摘要（L2+），L1 时为 null
}
```

### 同层加权

当某文档的 chunk 被命中时，同 `parent_doc_id` 下的兄弟文档 chunks 获得 10% 分数加成：

```
if (siblingDocIds.has(chunk.documentId)) {
  chunk.score *= 1.1;
}
```

### Wiki 页面搜索（L3）

L3 模式下，额外搜索 `knowledge_wiki_pages`：

- wiki 页面结果**优先展示**，排在原始 chunk 结果之前
- 搜索使用同样的 FTS 引擎（wiki 页面有对应方言的 FTS 支持）
- **Staleness 检查**：wiki 页面的 `updated_at` 必须 >= 其引用的源文档中最新一篇的 `updated_at`，否则降级到与 chunk 同层排序（避免过时 wiki 综合页面压过更新的原始文档）
- 返回格式区分 `type: 'wiki'` vs `type: 'chunk'`

```typescript
interface SearchResponse {
  wiki_results: WikiSearchResult[];   // L3: wiki 页面结果，优先展示（通过 staleness 检查的）
  chunk_results: ChunkSearchResult[]; // 传统 chunk 结果
}
```

所有模式统一返回此结构；L1/L2 模式下 `wiki_results` 为空数组。

---

## 前端变更

### 知识库创建/编辑表单扩展

新增配置区域：

- **增强模式**：下拉选择 `元数据增强` / `LLM Wiki 精简` / `LLM Wiki 完整`
- **LLM 配置**（L2/L3 可见）：provider 选择 + model name 输入
- **时序半衰期**：数值输入（天），默认 365

### 文档列表增强

- `published_at` 列，可内联编辑
- `doc_path` 面包屑显示
- 被覆盖文档显示「已替代」标记 + 跳转链接
- L2+：LLM 处理状态徽章（`pending`/`processing`/`done`/`failed`）
- L2+：关联关系指示图标（补充/矛盾/引用）

### 新增 Tab 视图

在知识库页面的 tab bar 中添加（根据 `enhancement_level` 条件显示）：

**文档树**（L1+）：
- 可折叠树组件展示文档层级
- 节点显示文档名、发布时间、状态
- 被覆盖文档以删除线样式显示
- 点击节点展开文档详情

**关联图**（L2+）：
- 基于 `knowledge_doc_relations` 的图形可视化
- 节点 = 文档，边 = 关系（颜色/样式区分类型）
- 可使用力导向图布局
- 点击节点查看文档详情和关联说明

**Wiki 浏览**（L3）：
- 页面列表（按 page_type 分组）
- 富文本 Markdown 渲染（支持 wiki 内链跳转）
- 页面版本历史
- 来源文档引用

### 搜索结果增强

- 每个结果显示 `doc_path` 面包屑
- 显示 `published_at` 和时序权重指示（如颜色深浅）
- L2+：显示文档摘要
- L3：wiki 页面结果单独分组，排在 chunk 结果之前

---

## API 变更

### 新增端点

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| PUT | `/api/knowledge/documents/:id/metadata` | assistant.manage | 编辑 `published_at`、`doc_path`、`parent_doc_id` |
| POST | `/api/knowledge/documents/:id/supersede` | assistant.manage | 标记文档被新版替代 |
| GET | `/api/knowledge/bases/:id/tree` | knowledge.view | 获取文档层级树 |
| GET | `/api/knowledge/bases/:id/relations` | knowledge.view | 获取文档关联图（L2+） |
| POST | `/api/knowledge/bases/:id/llm-process` | assistant.manage | 手动触发 LLM 处理（L2+） |
| GET | `/api/knowledge/bases/:id/wiki-pages` | knowledge.view | 列出 wiki 页面（L3） |
| GET | `/api/knowledge/wiki-pages/:id` | knowledge.view | 获取 wiki 页面详情（L3） |
| POST | `/api/knowledge/bases/:id/lint` | assistant.manage | 触发 wiki 健康检查（L3） |

### 现有端点变更

| 端点 | 变更 |
|------|------|
| `POST /api/knowledge/bases` | 新增 `enhancement_level`, `llm_provider_id`, `llm_model_override`, `temporal_half_life_days` 字段 |
| `PUT /api/knowledge/bases/:id` | 同上 |
| `POST /api/knowledge/search` | 返回格式统一为 `{wiki_results, chunk_results}`（L1/L2 时 `wiki_results` 为 `[]`），chunk 结果含 `doc_path`、`published_at`、`doc_summary`、`parent_summary` |
| `POST /api/knowledge/bases/:id/documents` | 新增可选 `published_at` 参数 |
| `POST /api/knowledge/bases/:id/import-url` | 自动提取 `published_at` 和 `doc_path` |

---

## 新增模块清单

| 文件路径 | 职责 |
|----------|------|
| `src/knowledge/metadata-extractor.ts` | L1: 发布时间提取、层级构建、覆盖检测 |
| `src/knowledge/llm-enhancer.ts` | L2: LLM 摘要生成、实体提取、关联检测 |
| `src/knowledge/wiki-maintainer.ts` | L3: wiki 页面 CRUD、交叉引用维护、健康检查 |
| `src/knowledge/llm-call.ts` | 共享: 知识库级 LLM 调用封装（读取 KB 的 provider/model 配置） |

### 修改模块清单

| 文件路径 | 变更 |
|----------|------|
| `src/knowledge/pipeline.ts` | 入库流程增加 L1/L2/L3 分支调用 |
| `src/knowledge/retrieval.ts` | 检索增加覆盖过滤、时序加权、层级扩展、wiki 搜索 |
| `src/knowledge/knowledge-search-engine.ts` | FTS 查询增加 superseded_by IS NULL 过滤 |
| `src/knowledge/url-importer.ts` | 导入时提取 published_at 和构建层级 |
| `src/db/assistants.ts` | 新表 CRUD、文档表扩展字段操作 |
| `src/db/schema-sqlite.ts` | 新表 DDL + 迁移 |
| `src/db/schema-mysql.ts` | 新表 DDL + 迁移 |
| `src/db/schema-postgres.ts` | 新表 DDL + 迁移 + wiki 页面 FTS |
| `src/routes/knowledge-routes.ts` | 新增 API 端点 |
| `web/src/pages/KnowledgePage.tsx` | 表单扩展、新 tab 视图、结果增强 |
| `web/src/styles/knowledge.css` | 新增树/图/wiki 样式 |
| `web/src/app-types.ts` | 类型定义扩展 |
| `src/types/context.ts` | 后端类型定义扩展 |

---

## 环境变量

无新增全局环境变量。LLM 配置在知识库级别存储，不使用全局环境变量。

---

## 三条测试 Case

### Case 1: L1 时序覆盖

输入：
1. 上传「产品 V1.0 用户手册」（published_at: 2024-01-15）到某 KB
2. 上传「产品 V2.0 用户手册」（published_at: 2025-06-01, 同 filename）

预期：
- V1.0 文档 `superseded_by` 指向 V2.0 文档 ID
- 搜索「用户管理」只返回 V2.0 的 chunks
- V1.0 在文档列表中显示「已替代」标记

### Case 2: L2 关联检测

输入：
1. KB 设置 `enhancement_level = 'wiki_lite'`
2. 上传「员工入职流程」文档
3. 上传「新员工 IT 设备申领指南」文档

预期：
- 两篇文档各自生成摘要和实体
- 系统检测到 `supplements` 关系（IT 指南补充了入职流程）
- 搜索「新员工第一天要做什么」时，两篇文档都被命中，且关联信息可见

### Case 3: L3 Wiki 页面生成

输入：
1. KB 设置 `enhancement_level = 'wiki_full'`
2. 依次上传 5 篇关于「Kubernetes 部署」的文章（不同角度）

预期：
- 每篇文章入库后自动更新 wiki 页面
- 生成「Kubernetes」实体页面，综合 5 篇文章的核心信息
- 生成「Kubernetes 部署」概念页面
- 搜索「K8s 如何滚动更新」时，wiki 综合页面优先展示

---

## 并发与安全

### 并发覆盖

当两个上传同时匹配同一 `source_url` 时，采用 last-write-wins 策略：
- 按 `published_at`（或 `created_at`）较晚者为新版
- 环形覆盖检测：写入 `superseded_by` 前检查是否形成 A→B→A 循环，若有则拒绝并报错

### Enhancement level 降级

当 `enhancement_level` 从高层降为低层时：
- 已生成的 summaries / relations / wiki 页面保留在数据库中，但 **检索和 UI 不展示** 对应层级的数据
- 不自动清除，避免数据丢失；用户可通过未来的「清理」API 显式删除

### LLM 凭证验证

创建/编辑 KB 时若选择 L2/L3 模式，前端校验 `llm_provider_id` 非空；后端保存前验证 `getProvider(id)` 可解析且 KB owner 有权使用该 provider
