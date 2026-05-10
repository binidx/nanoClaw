# 仓库功能 Map 维护 Schema

这份文件是 NanoClaw 仓库功能 Map 的规则层，作用类似 LLM Wiki 的 `schema`：约束 Agent 如何维护 `docs/repo-feature-map/index.md`，避免索引膨胀成另一份全仓 dump。

## 三层结构

| 层 | 文件/数据源 | 责任 |
|---|---|---|
| Raw | PostgreSQL `code_index_*` 表、本地源码、主题文档 | 只读原始事实；不要把 raw 内容大段复制进功能 Map。 |
| Wiki | `docs/repo-feature-map/index.md` | 面向 Agent 的功能入口、文件定位、搜索范围和常见问题路由。 |
| Schema | `docs/repo-feature-map/schema.md` | 维护规则、命名规范、摄入/查询/lint 流程。 |

## Query：定位代码时怎么用

1. 读 `docs/repo-feature-map/index.md` 的“功能总表”。
2. 按用户问题选择 1 个功能域；跨域问题最多先选 2 个。
3. 读取该功能域列出的入口文件和主题文档。
4. 如果入口文件不能回答问题，再在“优先搜索范围”内做定向搜索。
5. 只有当功能 Map 明显缺失时，才扩大到相邻目录；不要默认全仓搜索。

推荐命令形态：

```bash
rtk rg "keyword" src/routes src/db web/src/pages/CodeMapPage.tsx
rtk rg "keyword" src/repo-review-* src/db/review.ts web/src/components/repo-review
rtk rg "keyword" src/knowledge src/routes/knowledge-routes.ts web/src/pages/KnowledgePage.tsx
```

## Ingest：什么时候更新功能 Map

满足任一条件就更新：

- 新增或删除一个用户可见功能域。
- 功能入口文件迁移，例如 route、DB 模块、页面组件换位置。
- 新增架构级模块：新表、新后台任务、新搜索/索引机制、新数据流。
- 主题文档和代码入口不一致。
- Agent 定位时发现本索引误导或缺入口。

不需要更新：

- 只改局部 helper、样式、测试细节。
- 文件内部函数重命名但功能入口不变。
- 临时设计稿或 `docs/superpowers/**` 计划变动，除非已落地为当前能力。

## Index 编写规范

- 每个功能域用“功能 / 先读这些文件 / 后端或数据入口 / 前端入口 / 文档或测试”表达。
- 每格列稳定入口，避免塞 20+ 个文件。
- 文件路径必须可点击、可直接打开。
- 用中文描述能力，用英文保留代码路径和标识符。
- 明确“不要先查哪里”，帮助 Agent 避免高噪声搜索。
- 数据库字段和索引规则不要复制完整 schema；只写应该去哪个 `src/db/schema-*.ts` 和哪个 DB 模块。

## Lint：健康检查清单

每次更新后快速检查：

- `README.md`、`docs/文档索引.md` 是否能找到功能 Map。
- `.codex/README.md` 和 `docs/agent-harness.md` 是否要求先查功能 Map。
- 新增功能域是否同时有后端入口、前端入口或明确“无直接 UI”。
- 表格中是否存在已删除路径。
- 是否记录 `docs/repo-feature-map/log.md`。

## 数据库索引复用说明

当前可复用的原始索引是 `code_index_*` 明细表：

- `code_index_snapshots`：snapshot、分支、代码来源和阶段状态。
- `code_index_files`：文件摘要、语言、行数、导入导出、rank。
- `code_index_chunks`：chunk 内容、行号、摘要和 hash。
- `code_index_functions`：函数/符号声明。
- `code_index_function_edges`：函数调用边。

如果需要刷新原始索引，优先使用产品已有 Code Index 重建能力，不要写一次性全仓扫描脚本替代产品链路。若只维护文档，可直接读取现有明细表汇总。

## 与项目文档的边界

- `docs/repo-feature-map/index.md` 是 Agent 查找入口，不替代主题文档。
- `docs/系统概览.md` 解释系统结构。
- `docs/知识库架构.md` 解释产品知识库，不等同于本仓库功能 Map。
- `docs/knowledge-wiki-maintainer.md` 面向运行中的知识库 MCP Agent；本 schema 面向开发仓库内的 coding Agent。
