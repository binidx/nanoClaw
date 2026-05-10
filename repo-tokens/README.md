# Repo Tokens

`repo-tokens` 是一个 GitHub Action，用来估算仓库源码占用的 token 数量，并把结果写回 README 或 SVG 徽章。

它适合用来快速判断代码库对大模型上下文窗口的占用比例。

<p>
  <img src="examples/green.svg" alt="tokens 12.4k">&nbsp;
  <img src="examples/yellow-green.svg" alt="tokens 74.8k">&nbsp;
  <img src="examples/yellow.svg" alt="tokens 120k">&nbsp;
  <img src="examples/red.svg" alt="tokens 158k">
</p>

## 基本用法

```yaml
- uses: qwibitai/nanoclaw/repo-tokens@v1
  with:
    include: 'src/**/*.ts'
    exclude: 'src/**/*.test.ts'
```

这个 Action 会使用 `tiktoken` 统计匹配文件的 token 数，并把结果写到 README 中的注释标记之间。

颜色规则默认基于 `200000` 上下文窗口：

- 低于 30%：绿色
- 30% 到 50%：黄绿色
- 50% 到 70%：黄色
- 70% 以上：红色

## 为什么要做这个

对于编码型 Agent 来说，仓库越容易整体装进上下文，协作成本通常越低。这个徽章不是精确性能指标，但能提供一个直观提醒，避免代码库无限膨胀。

## README 标记

在 README 中放入下面的标记：

```html
<!-- token-count --><!-- /token-count -->
```

Action 会替换标记之间的内容。

## 完整工作流示例

```yaml
name: Update token count

on:
  push:
    branches: [main]
    paths: ['src/**']

permissions:
  contents: write

jobs:
  update-tokens:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - uses: qwibitai/nanoclaw/repo-tokens@v1
        id: tokens
        with:
          include: 'src/**/*.ts'
          exclude: 'src/**/*.test.ts'
          badge-path: '.github/badges/tokens.svg'

      - name: Commit if changed
        run: |
          git add README.md .github/badges/tokens.svg
          git diff --cached --quiet && exit 0
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git commit -m "docs: update token count to ${{ steps.tokens.outputs.badge }}"
          git push
```

## 输入参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `include` | 必填 | 需要统计的 glob，空格分隔 |
| `exclude` | `''` | 要排除的 glob，空格分隔 |
| `context-window` | `200000` | 上下文窗口大小 |
| `readme` | `README.md` | 要更新的 README 路径 |
| `encoding` | `cl100k_base` | `tiktoken` 编码名 |
| `marker` | `token-count` | 注释标记名 |
| `badge-path` | `''` | 输出 SVG 徽章路径，留空则不生成 |

## 输出参数

| 输出 | 说明 |
|---|---|
| `tokens` | 总 token 数 |
| `percentage` | 占上下文窗口的百分比 |
| `badge` | 写回 README 的格式化文本 |

## 实现方式

这是一个 composite GitHub Action。它会安装 `tiktoken`，执行一段很短的 Python 脚本完成统计与回写，但不会自动提交代码，提交策略由调用方工作流决定。
