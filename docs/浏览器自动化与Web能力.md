# 浏览器自动化与 Web 能力

## 两套能力要分开理解

当前仓库里至少存在两类相关能力：

- 浏览器控制
  由后端 Browser API 和前端控制面板驱动
- Agent 侧 Web 搜索 / 抓取
  由运行时默认工具、站点规则和渲染抓取能力组成

## 浏览器控制

后端提供的浏览器接口覆盖：

- 状态查看
- 启动 / 停止
- 标签页管理
- 页面快照
- 角色快照
- 截图
- 日志查看
- 页面动作执行

支持的动作包括导航、点击、输入、按键、等待、选择、滚动和 evaluate。

## 前端入口

浏览器控制台位于配置页中的 Browser 区域，适合做：

- 本机浏览器连通性验证
- 页面交互调试
- 渲染抓取链路验证

## Agent 侧 Web 能力

运行时还支持默认 Web 搜索 / 抓取与站点规则配置。它和浏览器控制不是同一层：

- 浏览器控制更偏“人工操控或调试”
- Agent 侧 Web 能力更偏“模型工具链”

在多用户模式下，`browser_cli` 渲染抓取同样视为本机高风险能力：

- 即使没有走 `/api/browser/*`，它仍会执行本机浏览器命令模板。
- Runner 启动前会按本机能力策略净化环境变量。
- 没有对应权限的用户会被自动降级为 `basic/auto` 抓取，不会拿到可执行的 `browser_cli` 命令配置。

## Agent 侧 Web 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NANOCLAW_WEB_SEARCH_ENABLED` | `true` | 是否启用 `search_web` 工具 |
| `NANOCLAW_WEB_FETCH_ENABLED` | `true` | 是否启用 `fetch_url` 工具（独立于搜索开关） |
| `NANOCLAW_WEB_SEARCH_PROVIDER` | `auto` | 搜索引擎：`auto`/`duckduckgo_html`/`bing`/`brave`/`tavily`/`searxng` |
| `NANOCLAW_WEB_SEARCH_BING_DOMAIN` | `cn.bing.com` | Bing 搜索域名，非中国区部署可改为 `www.bing.com` |
| `NANOCLAW_WEB_SEARCH_MAX_RESULTS` | `5` | 搜索返回的最大结果数 |
| `NANOCLAW_WEB_SEARCH_ALLOWED_DOMAINS` | (空) | JSON 字符串数组，限制搜索和抓取的域名白名单 |
| `NANOCLAW_WEB_FETCH_PROVIDER` | `auto` | 抓取方式：`auto`/`basic`/`browser_cli` |
| `NANOCLAW_WEB_FETCH_MAX_CHARS` | `10000` | 抓取内容最大字符数 |
| `NANOCLAW_WEB_FETCH_BROWSER_COMMAND` | (空) | 渲染抓取的浏览器命令模板 |

## 使用建议

- 先验证浏览器可执行环境
- 再验证控制 API
- 最后再把它接到 Agent 工作流里

## 风险提示

- 浏览器操作具备真实页面交互能力
- 渲染抓取可能受站点登录态、反爬和本机环境影响
- 不应把浏览器控制能力暴露给不可信来源
