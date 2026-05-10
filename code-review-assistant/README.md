# code-review-assistant-2

一个面向多仓库场景的代码审查系统，支持单仓审查、跨仓联合审查、自动轮询、报告下载、进度追踪和权限控制。

## 主要功能

- 仓库管理：新增/编辑/删除仓库，配置基线分支、通知、轮询
- 分支同步：手动同步远端分支，更新本地分支清单
- 审查触发：
  - 单仓手动审查（指定分支 / 全分支策略）
  - 自动轮询审查
  - 跨仓联合审查（同名分支）
- 审查记录：状态追踪、分页、详情查看、Markdown 报告下载
- 进度可视化：任务队列状态 + 审查进度时间线（含每分钟心跳）
- 登录与权限：
  - API Key 必填（支持 Cursor Key 与 Claude Key）
  - 可选管理员账号密码（管理员/访客权限分级）

## 技术栈

- 后端：FastAPI + SQLAlchemy + SQLite + APScheduler
- 前端：React + TypeScript + Vite + Ant Design + React Query
- Git 审查执行：本地 Git 命令 + 临时 worktree 隔离上下文
- LLM 调用：Cursor CLI / Claude Code CLI

## 目录结构

```text
code-review-assistant-2/
├─ backend/
│  ├─ app/
│  │  ├─ api/                 # 路由：auth/repos/reviews/...
│  │  ├─ services/            # 审查、Git、调度、通知等服务
│  │  ├─ prompts/             # 审查模板、知识、skills
│  │  ├─ main.py              # FastAPI 入口
│  │  ├─ models.py            # ORM 模型
│  │  └─ config.py            # 配置读取（.env）
│  ├─ data/                   # SQLite 数据文件
│  └─ runtime-logs/           # 运行日志（默认不进 git）
├─ frontend/
│  ├─ src/
│  │  ├─ pages/               # 主页面（仓库/联审）
│  │  ├─ api/                 # 请求封装
│  │  └─ types/               # 类型定义
│  └─ package.json
├─ restart-backend.bat        # Windows 一键重启后端（8000）
└─ start-frontend.bat         # Windows 一键启动前端（5173）
```

## 环境要求

- Python 3.10+
- Node.js 18+（建议 LTS）
- Git（可在命令行使用）
- Windows / macOS / Linux（当前仓库已提供 Windows bat 脚本）

## 后端配置

后端从 `backend/.env` 读取配置（见 `backend/app/config.py`）。

可用配置项：

- `DATABASE_URL`（默认：`sqlite+aiosqlite:///./data/code_review.db`）
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- `FEISHU_WEBHOOK_URL`
- `GIT_EXECUTABLE`（默认 `git`）
- `CORS_ORIGINS`（默认 `http://localhost:5173,http://127.0.0.1:5173`）
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

示例（`backend/.env`）：

```env
DATABASE_URL=sqlite+aiosqlite:///./data/code_review.db
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-20250514
ANTHROPIC_BASE_URL=
ANTHROPIC_AUTH_TOKEN=
FEISHU_WEBHOOK_URL=
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_password
```

## 快速启动

### 方式一：使用 bat 脚本（Windows 推荐）

1. 启动后端：双击 `restart-backend.bat`
2. 启动前端：双击 `start-frontend.bat`

### 方式二：手动启动

后端：

```bash
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

前端：

```bash
cd frontend
npm install
npm run dev
```

访问地址：

- 前端：http://127.0.0.1:5173
- 后端健康检查：http://127.0.0.1:8000/api/health
- API 文档：http://127.0.0.1:8000/docs

## 使用流程（建议）

1. 登录系统（API Key 必填）
2. 新建仓库并配置本地路径、基线分支
3. 点击“同步仓库”拉取远端分支
4. 创建 Profile（可选）
5. 触发单仓或跨仓审查
6. 在记录页查看进度、详情并下载报告

## 关键机制说明

- 审查上下文隔离：通过 `git worktree` 在目标提交创建独立工作区，避免受当前本地分支污染
- 并发控制：队列 + 仓库级锁，防止多任务同时 checkout 冲突
- 进度心跳：审查执行中每分钟写入一条 heartbeat，便于确认任务存活
- 轮询看门狗：对长时间“reviewing”但实际不在队列/执行集中的任务自动标记失败

## 常见问题

- API Key 验证慢：首次会调用 CLI 校验；后端有 12 小时缓存，后续登录更快
- 审查长时间无结果：检查本机 Git/CLI 可用性、仓库路径是否有效、分支是否可解析
- 联审未命中仓库：需至少 2 个启用仓库存在同名分支且本地路径为有效 Git 仓库

## 版本与日志

- 数据库：SQLite（`backend/data/`）
- 运行日志：`backend/runtime-logs/`（已在 `.gitignore` 中忽略）

---

如需扩展（如更多审查模板、知识库、报告格式），可优先从 `backend/app/prompts/` 和 `backend/app/services/review_service.py` 入手。
