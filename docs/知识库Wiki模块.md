# 知识库 Wiki 模块

这份文档只讲 **Wiki 模块本身**，不重复整套知识库的通用分块、向量检索和 URL 导入细节。目标是回答 4 个问题：

1. 现在 Wiki 是怎么生成的
2. 文档关系和 Wiki 关系是怎么建立的
3. 当前质量优化做到了什么，边界还在哪里
4. Web UI、内部 API、MCP Agent 分别怎么消费 Wiki

配套总览见：

- 架构总文档：[`知识库架构.md`](./知识库架构.md)
- Agent 侧使用规约：[`knowledge-wiki-maintainer.md`](./knowledge-wiki-maintainer.md)

---

## 1. 模块定位

当前实现里，Wiki 不是“单独维护的一套事实库”，而是位于：

`原始文档 -> 文档摘要/关系 -> Wiki 页面 -> 查询回答`

之间的**编译层**。

它的职责不是替代原文，而是：

- 把多文档知识先编译成可读页面
- 提供实体、概念、综合页、对比页入口
- 让回答优先消费已经组织好的知识，而不是每次重新从 chunk 拼装
- 仍然保留原文 chunk 作为证据层和兜底层

因此当前系统的目标不是“只看 Wiki 就够”，而是：

`Wiki 负责组织与归纳，原文负责验证与细节`

---

## 2. 生成链路

### 2.1 入口

Wiki 只在 `wiki_full` 模式下自动生成。

触发入口有三类：

- 文档入库后自动异步增强
- 手动整库处理：`POST /api/knowledge/bases/:id/llm-process`
- 手动单文档重建：`POST /api/knowledge/documents/:id/rebuild-llm`

其中手动处理支持三种模式：

- `recover`：只处理 `null/pending/failed`
- `rebuild_all`：全量重建已索引文档
- `rebuild_docs`：只重建指定文档

### 2.2 实际阶段

对每个文档，链路固定为：

1. `metadata-extractor.ts`
   - 提取 `published_at`
   - 推断 `doc_path / depth`
   - 修复 `parent_doc_id`
   - 检测 `superseded_by`

2. `llm-enhancer.ts`
   - 读取文档内容
   - 做内容清洗与抽样
   - 生成结构化摘要 `knowledge_doc_summaries`
   - 抽实体 `entities`
   - 抽主题 `topics`
   - 判断与其他文档的关系 `knowledge_doc_relations`

3. `wiki-maintainer.ts`
   - 基于摘要和来源文档集合，重建实体页 / 概念页 / 综合页
   - 维护 `source_doc_ids`
   - 维护 `inbound_links / outbound_links`
   - 更新 wiki FTS 索引

4. `overview-maintainer.ts`
   - 规则化重建 `overview` 页
   - 把当前 KB 的 Wiki 结构、版本、来源数、近期事件汇总成总目录

### 2.3 为什么现在比之前稳定

之前的 Wiki 更接近“把模型输出原样存起来”；现在已经补了几层保护：

- 文档摘要前先做去重和结构抽样，降低垃圾文本污染
- JSON 返回支持 fence 剥离和片段提取，减少整个摘要任务失败
- Wiki 页生成有固定章节骨架
- 模型返回太短、太散、缺关键章节时，自动回退到规则化 fallback 页面
- `entity / concept` 页不再只靠旧页增量叠加 source ids，而是按当前 KB 内真实命中的摘要重算来源文档集合

---

## 3. 页面类型

当前页面类型如下：

- `overview`
  - 自动维护的总目录页
  - 不允许人工编辑
  - 作为 KB 入口页使用

- `entity`
  - 面向明确实体名
  - 来源集合由摘要中的高置信实体匹配决定

- `concept`
  - 面向主题/概念
  - 来源集合由摘要中的 `topics` 匹配决定

- `synthesis`
  - 综合页
  - 使用最近一批已完成增强的文档摘要聚合生成

- `comparison`
  - 查询回填页
  - 来自 `knowledge_save_as_page` 或 `/wiki-pages/backfill`

---

## 4. 关系模型

### 4.1 文档关系

文档层关系存储在 `knowledge_doc_relations`，当前支持：

- `supersedes`
- `supplements`
- `contradicts`
- `references`

这层关系来自 `llm-enhancer.ts`：

- 先从当前 KB 的摘要池中挑候选摘要
- 候选选择优先用 embedding 相似度
- 无 embedding 时退回关键词重叠
- 再让 LLM 逐批判断具体关系

### 4.2 Wiki 关系

Wiki 页自身还有两类关系：

- `source_doc_ids`
  - 记录页面由哪些源文档支持
  - 这是当前最重要的可追溯字段

- `inbound_links / outbound_links`
  - 通过页面标题共现做轻量交叉引用
  - 属于页面层 link graph，不是数据库外键

### 4.3 图谱来源

前端图谱 `GET /api/knowledge/bases/:id/graph` 混合了三种边：

- 文档树父子边
- 文档关系边
- 文档到 Wiki 的 `wiki_source` 边

所以现在的“知识层级”本质上更接近：

`文档树 + 文档关系图 + Wiki 聚合图`

而不是完整 ontology / 本体系统。

---

## 5. 当前质量机制

### 5.1 摘要质量

`llm-enhancer.ts` 当前做了这些优化：

- 去重重复行
- 代表性抽样，而不是把整篇 chunk 生硬拼 prompt
- 摘要要求偏“事实/步骤/约束”
- 版本更新类文档要求摘要里体现影响模块与变更点
- 操作说明类文档要求摘要里体现关键步骤

### 5.2 Wiki 页面质量

`wiki-maintainer.ts` 当前做了这些优化：

- 固定页面结构：
  - 摘要
  - 核心事实
  - 关键实体/术语
  - 关系与上下文
  - 差异与待确认
  - 来源
- 过滤低价值 topic 标签
- `entity / concept` 来源集合按当前摘要池重算
- fallback 页面保证最低可读性

### 5.3 查询质量

`retrieval.ts` 当前做了这些优化：

- Wiki 结果按页面类型、正文长度、来源文档数做质量重排
- `overview` 自动降权
- stale Wiki 自动降权
- 仍保留原文 chunk 结果
- 每个 Wiki 命中自动绑定 `evidenceChunks`
  - 当前默认 1-2 条
  - 用查询词和来源 chunk 的启发式匹配选出

这意味着现在回答链路更接近：

`Wiki 结论 + 原文证据 + 额外 chunk`

而不是单纯“Wiki 一段摘要”。

---

## 6. MCP / Agent 使用方式

当前 MCP 侧已经不只是“能搜到一点 Wiki 摘录”，而是完整支持：

- `knowledge_list`
- `knowledge_search`
- `knowledge_wiki_read`
- `knowledge_recent_events`
- `knowledge_save_as_page`

当前没有单独的 `knowledge_wiki_list` 工具；需要浏览 Wiki 结构时，先用 `knowledge_list` / `knowledge_search` 找入口，再用 `knowledge_wiki_read` 展开具体页面。

推荐调用链是：

1. `knowledge_search`
   - 找入口页
   - 查看 `page_id`
   - 同时拿到 `evidenceChunks`

2. `knowledge_wiki_read`
   - 读整页

3. 如仍不够
   - 再参考 `source chunks`

所以现在 Agent 已经具备：

- 找 Wiki
- 展开整页
- 直接看到配套原文证据

而不是只能“搜到一个截断文本块”。

---

## 7. Web UI 能力

知识库页当前已支持：

- 概览页展示 `已处理/总计`
- 文档树展示实时进度条
- 手动 `recover`
- 手动 `rebuild_all`
- 单文档 `rebuild_docs`
- 全局 `KB_LLM_CONCURRENCY` 设置与保存
- Wiki 浏览
- overview 索引页快捷入口

因此从可运维角度，当前 Wiki 已经从：

`不可见、不可控、不可重建`

升级到：

`可见、可重建、可控并发、可浏览整页`

---

## 8. 当前边界与已知不足

虽然这几轮已经把质量往上推了不少，但现在仍然有 4 个明确边界：

### 8.1 不是 claim-level grounding

当前是：

- 页级 `source_doc_ids`
- 页级 `evidenceChunks`

还不是：

- 每条核心事实逐条绑定 source span

这意味着它已经接近“可验证”，但还没到“逐句可审计”。

### 8.2 概念层级还不是 ontology

现在的 `entity / concept / synthesis` 仍然是实用型聚合，不是严格知识本体。

优点：

- 成本低
- 重建快
- 对一般知识库够用

缺点：

- 深层语义层级还不够强
- 复杂领域里“概念树”可能还不够稳定

### 8.3 evidence chunk 是启发式选的

当前 evidence 选择逻辑基于：

- query 命中
- token 重叠
- filename 轻微加权

它已经比纯随机 chunk 强很多，但还不是最优 reranker。

### 8.4 Wiki 仍然不应完全替代原文

当前最合理的使用方式仍然是：

- Wiki 负责入口、归纳、导航、综合
- 原文负责证据、参数、边界条件、细节核对

如果问题非常细、非常依赖精确措辞，chunk 仍然可能比 Wiki 更可靠。

---

## 9. 现在的结论

如果只看当前实现，可以给出很明确的判断：

### 9.1 “Wiki 现在优化了吗？”

优化了，而且不是只做了界面。

已经落地的优化包括：

- 真实进度与运行态
- 整库/单文档重建
- 全局并发可配
- 摘要 JSON 解析兜底
- Wiki 页面结构化生成
- 低质量输出 fallback
- Entity / Concept 来源重算
- MCP 可读整页 Wiki
- Wiki 命中自动带原文 evidence chunks

### 9.2 “现在 Wiki 怎么生成？”

简化后的真实流程是：

`文档 -> metadata -> summary/entities/topics -> doc relations -> entity/concept/synthesis -> overview -> retrieval`

### 9.3 “关系如何？”

当前关系是实用型的三层：

- 文档树层级
- 文档语义关系
- Wiki 聚合关系

足够支撑：

- 主题浏览
- 交叉引用
- 综合页
- 图谱浏览

但还不是完整 ontology。

### 9.4 “质量如何？”

当前已经能做到：

- 比之前明显可用
- 在概览、多文档综合、实体/主题解释上明显优于单纯原文查询
- 在需要证据支撑时，已经开始接近 “Wiki + 原文证据” 模式

但还没做到：

- 完全替代原文检索
- 逐条 claim 可追溯
- 复杂知识本体级层次建模

---

## 10. 下一步最值钱的演进

如果继续往“高质量可验证 Wiki”推进，最值钱的下一步是：

### A. claim-level grounding

把 `核心事实` 从普通 markdown bullet 升级成结构化 claim 列表，并给每条 claim 绑定：

- `source_doc_id`
- `evidence_chunk_id`
- 可选 source span

这是从“好用”走向“可信”的关键一步。

### B. evidence 选择从启发式升级到 rerank

当前 `evidenceChunks` 是启发式打分；后续可以：

- 先召回来源 chunk
- 再用更强的 rerank prompt / 本地 reranker
- 选出真正能支撑 claim 的证据

### C. 概念层从 topic 聚合升级成轻量 ontology

不是上来做大而全本体，而是逐步补：

- `parent concept`
- `related concepts`
- `aliases`
- `same-as / subtype-of`

这样图谱层会更稳定。

---

## 11. 相关代码入口

最值得先看的文件：

- `src/knowledge/llm-enhancer.ts`
- `src/knowledge/wiki-maintainer.ts`
- `src/knowledge/retrieval.ts`
- `src/knowledge/overview-maintainer.ts`
- `src/routes/knowledge-routes.ts`
- `src/routes/internal-knowledge-routes.ts`
- `agent/runner/src/ipc-mcp-stdio.ts`

如果要改：

- 页面质量：先看 `wiki-maintainer.ts`
- 摘要/关系：先看 `llm-enhancer.ts`
- 查询质量：先看 `retrieval.ts`
- Agent 消费方式：先看 `ipc-mcp-stdio.ts`
