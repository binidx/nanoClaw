# 贡献说明

NanoClaw 当前已经是一个包含后端运行时、Web 控制台、多渠道接入、任务调度、记忆系统、Repo Review、股票分析、MCP 与 Skills 管理的完整工作台。提交改动时请以“现状一致性”和“可运维性”为第一原则。

## 推荐贡献类型

- 缺陷修复
- 安全修复
- 文档重写与补全
- 测试覆盖补强
- 不改变产品方向的可维护性优化
- 与当前 UI 风格一致的小范围交互改进

## 基本要求

- 代码改动必须同步更新相关文档
- 删除功能时，相关文档必须同改动一起删除或重写
- 涉及 `src/**` 的行为改动，优先补充定向测试
- 涉及 `web/src/**` 的改动，保持现有信息密度和工作台式布局
- 不要保留已经失效的能力说明、旧模型名或历史设计稿表述

## 提交前至少做什么

后端改动：

```bash
npm run build
```

前端改动：

```bash
cd web && npm run build
```

前后端同时改动：

```bash
npm run build:all
```

建议补充检查：

```bash
npm run test
npm run test:critical
npm run test:memory
npm run typecheck
npm run format:check
```

Agent Runner 改动：

```bash
cd agent/runner && npm run build
```

## 合并门禁

- `npm run test:memory` 是 memory/context 相关改动的重点回归集
- `.husky/pre-push` 默认会在推送前执行这组测试
- 如确有例外需要跳过本地 hook，请明确知道风险后再使用 `NANOCLAW_SKIP_MEMORY_GATE=1 git push` 或 `HUSKY=0 git push`

## 建议先熟悉的入口

- `src/index.ts`：运行时编排
- `src/web-server.ts`：API 与 Web 行为
- `src/db.ts`：持久化契约
- `src/routes/*.ts`：功能域路由
- `src/memory/**`：记忆系统
- `src/repo-review-service.ts`：Repo Review 主逻辑
- `src/stock-analysis-*.ts`：股票分析模块
- `web/src/App.tsx`：前端状态总线
- `web/src/pages/*.tsx`：一级页面

## 文档约定

- `README.md` 负责项目总入口
- `docs/` 只保留“当前真实能力”的中文文档
- `AGENTS.md`、`CLAUDE.md`、`SKILL.md` 属于协作或代理说明，不应混入对外产品文档

## 提交信息建议

- 使用能直接说明改动面的标题
- 涉及高风险功能时，在提交说明里点明影响范围，例如 Repo Review、任务调度、访问策略、终端、扩展安装
