# NanoClaw - 中文入口

仓库主文档已统一到 [README.md](README.md)（英文版本）。

## 阅读建议

1. 快速了解项目：[README.md](README.md)
2. 中文详细文档：[docs/文档索引.md](docs/文档索引.md)
3. 安装部署：[docs/快速开始.md](docs/快速开始.md)
4. 系统架构：[docs/系统概览.md](docs/系统概览.md)
5. 界面展示：[效果图.md](效果图.md)

## 主要功能概览

- **多渠道会话**：Web、飞书、Telegram、Discord、Slack、Gmail、WhatsApp
- **AI Agent 运行时**：本地子进程执行、工作区挂载、子代理支持
- **IM 消息系统**：内部消息、好友/群聊、消息收发
- **记忆系统**：身份画像、混合检索（BM25 + 向量）、时序衰减、上下文压缩
- **知识库**：文档分块、向量检索、LLM 增强、Wiki 自动生成
- **代码审查**：Repo Review、CodeMap、代码索引与语义检索
- **任务调度**：Cron、定时任务、AI 生成任务草稿
- **浏览器自动化**：CDP 控制、渲染抓取、扩展市场
- **Workflow Workbench**：图形化多智能体工作台
- **数据库**：SQLite（默认）、MySQL/TiDB、PostgreSQL 三套支持

## 快速启动

```bash
git clone <repository-url>
cd nanoclaw
npm install
cd web && npm install
cd ../agent/runner && npm install && npm run build
cd ..
npm run build
npm run onboard
./start.sh
```

详细安装说明请查看 [docs/快速开始.md](docs/快速开始.md)。
