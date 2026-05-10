# LLM Wiki 维护员指南（for Agents）

这份文件对应 Karpathy "LLM Wiki" 模式中的 **schema 层** —— 告诉跑在本项目里的 Agent，如何把 NanoClaw 的知识库当成一份活的 wiki 来读、来写、来保鲜。开发者读 `docs/知识库架构.md` 了解系统怎么建；Agent 读这份文件了解**自己在 wiki 里的责任边界**。

> 读者：跑 MCP 的 Agent（Claude / Codex / 自定义 runner）。人类开发者顺带读也无妨。

## 角色定位

- **你**是这个知识库的「副驾驶维护员」：面对用户问题时，先读 wiki，再回答；把值得沉淀的答案回写进 wiki。
- **用户**做的事：挑源文档、提出问题、审阅结果。
- **系统**做的事：ingest 时自动 L1/L2/L3 增强、每 5 分钟 sweep（overview 重建、事件裁剪、自动 lint）、按标签路由事件。

所以：**你不需要手工维护交叉引用、overview 页或事件日志** —— 系统会做。你只要管「答好问题 + 沉淀有价值的综合答案」。

## 可用 MCP 工具（6 件）

| 工具 | 用途 | 什么时候用 |
|---|---|---|
| `knowledge_list` | 列出当前用户可见的所有 KB | 每次会话开头；不确定往哪个 KB 查时 |
| `knowledge_search` | FTS + 可选向量混合检索 | 回答任何可能已经在知识库里的问题时，**先于 web search** |
| `knowledge_wiki_list` | 浏览某个 KB 已编译好的 Wiki 页目录 | 想先看 KB 结构、找 overview / entity / concept / synthesis 页时 |
| `knowledge_wiki_read` | 读取单个 Wiki 页全文 | `knowledge_search` 命中某页后，需要展开整页阅读时 |
| `knowledge_recent_events` | 看一个 KB 最近发生了什么 | "最近 XX 有什么变化"；或给 lint / 综述答案补"近 20 条活动"上下文 |
| `knowledge_save_as_page` | 把刚产出的综合答案保存为 wiki 页 | 只有当答案**值得以后被直接命中**时；需 KB 开启 `allow_query_backfill` |

## 工作流

### 回答用户问题

```
user 问 X →
  1. knowledge_list（如果不确定 kb_id）
  2. knowledge_search(query=X 的 2-4 关键字)
  3. 如果命中了有价值的 Wiki 页：knowledge_wiki_read(page_id)
  4. 再综合 wiki + source chunks，回答用户
  5. 如果这个综合答案跨了多篇源文档 & 用户很可能再问一遍：
     knowledge_save_as_page(kb_id, title=question-shaped, content=答案 md)
```

推荐习惯：

- `knowledge_search` 负责**找入口**
- `knowledge_wiki_read` 负责**读整页**
- 不要只看 `knowledge_search` 返回的截断片段就下结论

回填触发的 rule of thumb：**3 篇以上源文档 + 问题是可重复问的**（"X 和 Y 的区别"、"X 的配置清单"、"最近 X 的变化"），就值得回填。一次性、非常 personal 的问题（"帮我改我这行代码"）不要回填。

### 被用户问"最近发生了什么"

- 先 `knowledge_recent_events(kb_id, limit=20)` 拿时间线
- 按 `event_type` 聚合（例如 "3 篇 ingest、1 次 lint、2 次 supersede"）
- 回答人类风格的变化摘要；不要贴原始 JSON

### 被用户问"帮我检查 wiki 有没有问题"

- **不要手工跑 lint**。系统每天会自动 lint 一个 wiki_full KB。
- 如果用户明确要**立刻** lint，告诉他调 `POST /api/knowledge/bases/:id/lint` API。Agent 当前没有这个工具是刻意的（lint 比较贵，避免被滥用）。

## 硬边界（别踩）

| 项 | 上限 | 超出后果 |
|---|---|---|
| `knowledge_save_as_page` title | 255 字符 | 400 拒绝 |
| `knowledge_save_as_page` content | 256 KB（UTF-8 字节） | 413 拒绝，请拆成多页 |
| `knowledge_save_as_page` 频率 | 每 `(user, kb)` 每分钟 5 次 | 429 拒绝，限速兜底 |
| KB `allow_query_backfill=0` | — | 403 拒绝；让管理员在 KB 配置里打开 |

## 命名 & 回填建议

- **标题**写成**可重复问的问题形态**，不要写成某次对话的脚本：
  - 好：`部署到 K8s 前的检查清单`
  - 差：`Alice 昨天问的那个 k8s 问题`
- **同标题再次保存** = 更新同一页并 `version + 1`，不会建重复页。所以迭代优化同一个综合答案是被鼓励的。
- **内容**用 markdown；链接其他 wiki 页用 `[title](wiki://<page_id>)`，系统会让 overview / 交叉引用自动感知。
- **source_query** 字段传原始用户问题。不是必需，但方便之后回溯"这页是哪次对话生成的"。

## 多副本与限流语义（给运维背景）

本项目的进程内限流（5 次/分/(user, kb)）和 L2/L3 单 flight 锁都是**进程内**的。如果部署成多副本（同一 KB 被多个 nanoclaw 实例服务），每个实例独立计数：

- 限速真实上限 ≈ `副本数 × 5 次/分` — 不严格但可以接受（反正由内部 token 防外部滥用）。
- LLM 单文档增强可能在两个副本并发触发 → 两次 LLM 调用，后写胜出；**不会产生数据损坏**，仅是成本。

单实例部署下这两点都是严格的。Agent 不用关心；运维可按规模决定是否迁到 Redis / DB 锁。

## 不在范围

- 你不维护 overview 页（系统 sweep 自动）
- 你不维护交叉引用（Wiki 维护器自动）
- 你不裁剪事件日志（系统 sweep 自动）
- 你不手动触发 lint（自动 sweep 或管理员 API）

## 相关文档

- 开发者架构：[docs/知识库架构.md](./知识库架构.md)
- Karpathy LLM Wiki 模式原文：见代码仓库的二轮审查报告 plan
