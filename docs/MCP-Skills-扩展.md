# MCP、Skills 与扩展

## 模块范围

运行时扩展体系包含：

- MCP Servers（用户级 + 共享）
- Skills（用户级 + 共享）
- 扩展市场源（管理员配置）
- 市场安装记录
- 公共库（聚合展示）

## 架构概览（v2）

v2 引入用户级隔离和共享模型：

- 每个用户拥有独立的 MCP/Skills 配置（`user_mcp_servers`, `user_skills` 表）
- 用户可选择将自己的配置设为公开分享（`visibility=shared`）
- 公共库聚合所有用户分享的 + 市场源提供的内容
- 管理员通过 `marketplace_sources` 表管理多个插件市场源
- 每个 MCP/Skill 可附带结构化 metadata：capability、requirements、artifact、generator 信息
- 系统对用户扩展执行环境检查，给出 `ready / warning / blocked` 健康状态

### 数据模型

```
user_mcp_servers   — 用户 MCP 配置（user_id + visibility）
user_skills        — 用户 Skills（user_id + visibility）
marketplace_sources — 市场源（管理员管理）
marketplace_installs — 安装记录
```

metadata 现阶段落在：

- `user_mcp_servers.metadata_json`
- `user_skills.metadata_json`

### 用户隔离 + 共享

- `visibility=private`：仅用户自己可见
- `visibility=shared`：所有人可在公共库中看到
- 从公共库安装 = 创建独立副本到自己空间，修改互不影响

## MCP Servers

MCP 把外部工具或服务接入运行时。v2 支持：

- 用户自行创建、编辑、删除 MCP 配置
- JSON 导入（兼容 Cursor/Claude 格式）
- 从本地路径导入 Node stdio MCP 包或单个入口文件
- 启用/禁用开关
- 公开分享/取消分享
- 从公共库安装他人分享的 MCP
- AI 根据接口说明生成可安装的 TypeScript/Node stdio MCP
- 通过 metadata 声明 capability、requirements、artifact 类型
- 在列表页展示环境健康状态和能力标签

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/user/mcp-servers` | 列出可见 MCP（自己的 + 共享） |
| GET | `/api/user/mcp-servers/mine` | 仅列出自己的 |
| POST | `/api/user/mcp-servers` | 创建 |
| POST | `/api/user/mcp-servers/ai-generate` | AI 生成并安装用户私有 MCP |
| POST | `/api/user/mcp-servers/import-path` | 从本地目录或入口文件导入 MCP |
| PUT | `/api/user/mcp-servers/:id` | 更新 |
| DELETE | `/api/user/mcp-servers/:id` | 删除 |
| POST | `/api/user/mcp-servers/:id/toggle-visibility` | 切换公开/私有 |
| POST | `/api/user/mcp-servers/install-shared` | 安装共享 MCP |

## Skills

Skills 是 AI 可读的 Markdown 指令集合。v2 支持：

- 用户创建自定义 Skills（含 SKILL.md 编辑器）
- 从本地 Skill 目录或 `SKILL.md` 文件导入
- 启用/禁用
- 公开分享/取消分享
- 从公共库安装他人分享的 Skills
- 通过 metadata 声明 capability、requirements 和运行约束
- 在列表页展示环境健康状态

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/user/skills` | 列出可见 Skills |
| GET | `/api/user/skills/mine` | 仅列出自己的 |
| POST | `/api/user/skills` | 创建 |
| POST | `/api/user/skills/import-path` | 从本地目录或 SKILL.md 导入 Skill |
| PUT | `/api/user/skills/:id` | 更新 |
| DELETE | `/api/user/skills/:id` | 删除 |
| POST | `/api/user/skills/:id/toggle-visibility` | 切换公开/私有 |
| POST | `/api/user/skills/install-shared` | 安装共享 Skill |

## 公共库

聚合展示所有公开内容：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/public-library` | 查询公共库（支持 type/search/分页） |
| POST | `/api/public-library/install` | 安装公共库中的条目 |

## 市场源管理（管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/marketplace-sources` | 列出所有市场源 |
| POST | `/api/admin/marketplace-sources` | 添加 |
| PUT | `/api/admin/marketplace-sources/:id` | 更新 |
| DELETE | `/api/admin/marketplace-sources/:id` | 删除 |
| GET | `/api/marketplace-sources` | 公开端点：列出已启用市场源 |

### 内置 Agent Reach 市场源

- 系统会额外暴露一个内置的 `Agent Reach` 市场源，用来把 Agent Reach 风格的互联网工具路由沉淀成可安装 Skill bundle。
- 这个内置源随仓库一起发布，不依赖管理员手工录入 GitHub 地址；更新仓库代码后会随运行时资产一起更新。
- 当前 bundle 重点提供 Skill 路由与安装指引，不把 `xhs-cli`、`twitter-cli`、`mcporter` 这类混合上游直接伪装成 NanoClaw managed MCP。原因是现有 managed MCP 模型只适合 stdio command，而 Agent Reach 的渠道后端同时包含 CLI、mcporter alias 和外部 MCP 服务。
- 因此推荐落地方式是：
  - 管理员安装 `Agent Reach` bundle
  - Assistant 绑定该 Skill
  - 按需再启用上游工具，例如 `xhs-cli`、`douyin-mcp-server`、`mcporter + Exa`

## 注册表（Registry）

统一市场入口，聚合公共库、市场源和 AI 生成内容：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/registry/catalog` | 查询注册表目录（支持 type/search/refresh） |
| POST | `/api/registry/install` | 从注册表安装条目 |

注册表服务：`src/registry-service.ts`
路由：`src/routes/registry-routes.ts`

## AI 访问方案

AI Agent 需要读取本地 `.md` 文件。方案采用 **启动时重建 + CRUD 实时同步**：

1. 数据库是 source of truth
2. 启动时 `startup-hydration.ts` 从 DB 重建所有用户的文件到磁盘：
   - `data/users/{user_id}/mcp-servers/{id}/config.json`
   - `data/users/{user_id}/skills/{id}/SKILL.md`
   - `data/shared/mcp-servers/{id}/config.json`（共享项）
   - `data/shared/skills/{id}/SKILL.md`（共享项）
   - AI 生成或本地导入 MCP 的附加文件保存在对应用户 MCP 目录中，例如 `data/users/{user_id}/mcp-servers/{id}/package/*`
   - 本地导入 Skill 的附加文件保存在对应用户 Skill 目录中，例如 `data/users/{user_id}/skills/{id}/*`
3. 每次 CRUD 操作同步更新 DB 和本地文件
4. Agent 进程通过 `agent-runner-spawn.ts` 注入用户专属 MCP
5. Agent 进程通过 `agent-runner-mounts.ts` 挂载用户专属 + 共享 Skills

## 数据迁移

v1 到 v2 的迁移在 `src/migration/mcp-skills-migration.ts` 中：

- `WEB_MCP_SERVERS` config → `user_mcp_servers`（user_id=__system__）
- `WEB_ENABLED_SKILLS` + 文件系统 Skills → `user_skills`
- `WEB_EXTENSION_MARKETPLACES` → `marketplace_sources`
- `WEB_EXTENSION_INSTALLS` → `marketplace_installs`

迁移在首次启动时自动执行，原 config key 保留为 `_MIGRATED` 后缀备份。

## 前端

v2 前端使用 `AppsPageV2.tsx`，包含三个标签：

- **我的应用**：卡片网格，支持状态/类型过滤，创建/编辑抽屉，本地路径导入，显示 capability 与 health 状态，并支持 AI 生成 MCP
- **公共库**：搜索 + 类型过滤 + 安装
- **市场源管理**：管理员可见，CRUD 市场源

## 兼容性

旧的 `/api/managed-mcp-servers` 和 `/api/managed-skills` API 仍然可用（`runtime-customization-routes.ts`），实现渐进迁移。

## 风险边界

- 扩展安装会改变本地运行时状态
- MCP 和 Skills 可能扩大 Agent 的工具能力边界
- 用户分享的 MCP/Skills 可被所有人安装
