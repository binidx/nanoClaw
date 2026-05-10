# 统一用户记忆系统 Brainstorm

**日期**: 2026-03-27
**状态**: 设计中

## 我们要做什么

将现有的两套独立记忆系统（文件/FTS 长期记忆 + Soul 人格记忆）统一为一套以数据库为核心、按用户隔离的记忆系统。目标：

1. **每个用户有独立的记忆空间** — 我的偏好、习惯、个人信息不会被其他用户看到
2. **AI 在对话中自动学习用户信息** — 通过正则初筛 + LLM 精提的智能触发方式
3. **支持用户和 AI 的命名** — Soul 配置中加入"用户称呼"专属字段
4. **记忆可靠召回** — 核心记忆始终注入 prompt，其他记忆按相关性语义召回
5. **废弃文件记忆** — 不再使用 MEMORY.md / memory/*.md，全部迁移到数据库
6. **短期记忆保持现状** — session context、compaction 等不变

## 为什么选这个方案

以 `user_souls` + `user_soul_memories` 为基础扩展（方案 A），而不是新建独立服务：

- 已有 per-user 隔离的表结构（按 `users.id`），扩展成本最低
- Soul 和记忆本来就是一体的概念——"了解用户"既包含人格设定也包含学到的信息
- 重命名 `user_soul_memories` → `user_memories`，语义更通用

## 关键设计决策

### 1. 数据模型变更

**`user_souls` 表新增字段：**
- `user_nickname` — 用户希望 AI 怎么称呼自己（如"小明"、"老板"）
- `ai_name` — 用户给 AI 起的名字（已有 `name` 字段可复用）

**`user_soul_memories` → `user_memories` 重命名，扩展 category：**
- `identity` — 用户身份信息（姓名、年龄、职业等）
- `preference` — 偏好（喜欢什么、不喜欢什么）
- `habit` — 习惯（工作方式、沟通风格等）
- `fact` — 事实（养了一只猫、住在上海等）
- `skill` — 技能水平（会 Python、不懂 SQL 等）
- `relationship` — 关系（同事叫张三、老板是李四等）
- `general` — 通用/未分类

**新增 `memory_extraction_log` 表：**
- 记录每次 LLM 提取的结果，防止重复提取，用于调试

### 2. 写入路径（三通道）

```
用户消息 → 正则初筛（低成本）
              ↓ 命中？
         LLM 提取（异步后台）→ user_memories
              
手动配置页 → user_souls + user_memories

agent memory_save 工具 → user_memories（改写指向数据库 API）
```

**正则初筛关键词（示例）：**
- 身份类：我叫、我是、我的名字、叫我、称呼我
- 偏好类：我喜欢、我不喜欢、我偏好、我讨厌、我爱
- 习惯类：我习惯、我一般、我通常、我每天
- 事实类：我有、我养了、我住在、我在...工作
- 技能类：我会、我不会、我擅长、我不懂
- 指令类：记住、别忘了、以后、从现在开始

**LLM 提取 prompt 设计要点：**
- 输入：用户的最近几条消息
- 输出：结构化 JSON（category + content + importance）
- 去重：与现有记忆对比，只存增量

### 3. 读取路径（混合召回）

```
对话开始时：
  1. 始终注入：user_souls 人格 + user_memories 中 importance >= 8 的核心记忆
  2. 语义搜索：根据当前对话内容，从 user_memories 中召回相关记忆（FTS/向量）
  3. 合并去重后注入 system prompt
```

### 4. Agent 工具改造

现有 `memory_search` / `memory_get` / `memory_save` 工具改为：
- 读写 `user_memories` 表（通过 internal API）
- 需要传入 `user_id`（从 env 注入）
- 旧的文件路径操作全部废弃

### 5. 废弃清单

需要逐步移除的模块：
- `src/memory/document-sync-loop.ts` — 文件同步循环
- `src/memory/document-indexing.ts` — 文件索引
- `src/memory/promotion.ts` — 文件写入提升
- `src/memory/ingest-promotion.ts` — 自动提升到文件
- `agent/runner/src/memory-tools.ts` — 重写为数据库版本
- `MEMORY.md` / `memory/*.md` 文件写入逻辑

保留的模块：
- `src/memory/context-assembly.ts` — 改造为从数据库读取
- `src/memory/context-config.ts` — 配置开关保留
- Session context / compaction — 短期记忆不动

### 6. 记忆淘汰策略

- **触发条件**：每次写入新记忆时检查，或定时任务（每小时）
- **淘汰规则**：
  - `importance <= 2` 且 `access_count == 0` 且创建超过 30 天 → 自动删除
  - `importance <= 4` 且 `last_accessed_at` 超过 90 天 → 标记为归档（不参与召回）
  - 每次被召回时 `access_count++` 并更新 `last_accessed_at`
- **不淘汰**：`importance >= 8` 的核心记忆永久保留

### 7. 记忆冲突处理

- **策略：同 category 相似内容自动替换**
- LLM 提取时，系统先查该用户同 category 的现有记忆
- 如果 LLM 输出的 content 与某条现有记忆语义高度相似（FTS 分数阈值），更新该记忆而非新增
- 不确定时以新记忆为准（用户最新表达优先）

### 8. Importance 评分

- **由 LLM 提取时同时给出**（1-10 分）
- LLM 提取 prompt 要求输出 `{ category, content, importance, reasoning }`
- 身份类信息 LLM 通常会给 8-9 分，一般事实给 5-6 分

### 9. User ID 传递到 Agent 子进程

- 新增环境变量 `NANOCLAW_USER_ID`，在 `spawnAgent` 时从 `processGroupMessages` 传入
- agent runner 中 `memory_*` 工具读取此 env，调用 internal API 时带上 `user_id`
- Internal API 新增 `/internal/memory/user/:userId/search` 和 `/internal/memory/user/:userId/save`

### 10. FTS 索引

```sql
CREATE VIRTUAL TABLE user_memories_fts USING fts5(
  content,
  content='user_memories',
  content_rowid='rowid'
);
```

- 与 `user_memories` 联动，写入时自动更新 FTS
- 搜索时先过滤 `user_id` 再 FTS 匹配

### 11. Conversation ID

- `conversation_id` 使用现有的 `chat_jid` 值
- scope='conversation' 的记忆在 prompt 注入时仅在对应 `chat_jid` 的对话中生效

## 已解决的问题

1. **向量搜索 vs FTS** → **先用 FTS，后续按需升级向量**。SQLite FTS 已有基础设施，足够起步。语义相似度需求大时再引入 sqlite-vec。
2. **LLM 提取模型** → **可配置**。默认用便宜小模型（GPT-4o-mini / Haiku），允许用户在设置中切换。
3. **记忆容量** → **不限制，用淘汰策略管理**。按 importance + 最近访问时间自动降级；importance 低 + 长期未被召回的记忆自动归档。
4. **旧数据迁移** → **不迁移，从零开始**。旧 MEMORY.md 数据自然淘汰。
5. **跨对话记忆** → **分层设计**：
   - **全局记忆**（`scope = 'global'`）：跨所有对话共享，如用户偏好、身份信息
   - **对话记忆**（`scope = 'conversation'` + `conversation_id`）：仅在特定对话中有效，如"这个项目里我们用 React"

## 数据模型（最终版）

### user_memories 表

```sql
CREATE TABLE user_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL DEFAULT 'global',        -- 'global' | 'conversation'
  conversation_id TEXT,                         -- scope='conversation' 时填写
  category TEXT NOT NULL DEFAULT 'general',     -- identity/preference/habit/fact/skill/relationship/general
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5,        -- 1-10
  source TEXT NOT NULL DEFAULT 'manual',        -- manual/chat_auto/llm_extract/agent_tool
  access_count INTEGER NOT NULL DEFAULT 0,      -- 召回次数，用于淘汰
  last_accessed_at TEXT,                        -- 最近被召回的时间
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### user_souls 表新增字段

```sql
ALTER TABLE user_souls ADD COLUMN user_nickname TEXT;  -- "叫我小明"
-- ai_name 复用已有的 name 字段
```

### memory_extraction_log 表

```sql
CREATE TABLE memory_extraction_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  source_message_ids TEXT,      -- JSON array of message IDs analyzed
  extracted_memories TEXT,       -- JSON array of extracted items
  model_used TEXT,
  tokens_used INTEGER,
  created_at TEXT NOT NULL
);
```
