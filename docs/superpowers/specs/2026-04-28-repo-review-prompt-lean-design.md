# Repo Review Prompt 精简化改造设计

## 背景

今天两次提交（`5771a0e fix: harden repo review output fallback` 与 `67770d0 feat: add configurable prompt center and traces`）改动了 Repo Review 的 prompt 构建路径，触发了线上审查被模型直接拒答的回归（`"I'm sorry, but I cannot assist with that request."`）。

根因是 `buildReviewPrompt` 一直把完整 diff 正文、项目上下文、变更文件全文一次性塞进 user prompt。在外部仓库审查时 prompt 可以膨胀到 70 KB+，而系统 prompt 只是通用的 "helpful coding assistant"，模型在缺乏任务锚定的情况下容易把这类高体积业务代码视为外部敏感数据而拒答。5771a0e 又移除了原先兼职"任务锚点"的 Markdown 报告模板，进一步压缩了任务框架。

与此同时 `runReviewAgent` 早已把仓库目录以 `/workspace/extra`（只读）挂载到 agent 容器，agent 天生具备 `read_file`、`bash`（含 git）工具。当前架构等于给了 agent 工具却又把证据全部预先推送，既耗 token 又压制探索。

## 目标

把 Repo Review prompt 从"证据搬运"改成"方向指引"：prompt 只告诉 agent 在哪个路径、对比哪两个 SHA、用什么工具、输出什么格式、有哪些限制；diff、文件全文、项目上下文全部由 agent 按需读取。

## 非目标

- 不重建 agent 运行时、provider 调度或 workteam 子系统。
- 不改 Prompt Center 的 UI 或持久化协议。
- 不改动 Repo Review 的触发、回调、通知路径。
- 不重新设计 `review_runs` 表结构。

## 核心设计

### 1. Prompt 模板（精简版）

所有五个 `repo_review.*` prompt 统一采用"方向指引 + 单 JSON 输出"结构：

```
你是资深代码审查工程师。

## 本次审查对象
仓库：{repositoryName}
工作目录：/workspace/extra（只读挂载，即仓库根目录）
对比范围：{baseSha}..{headSha}
分支：{branch}
触发：{stage} / {source}

变更文件 ({fileCount}):
- path/a
- path/b

{customPromptBlock?}   ← 用户在 profile 里填的自定义规则

## 你可以做什么
- 读文件：`read_file` 或 `cat /workspace/extra/<path>`
- 看 diff：`git -C /workspace/extra diff {baseSha}..{headSha} -- <path>`
- 看提交：`git -C /workspace/extra show {sha}`、`git -C /workspace/extra log {baseSha}..{headSha}`
- 你应当至少执行一次 `git diff {baseSha}..{headSha}` 获取原始 diff；
  需要更多上下文时再按需 `read_file` 或 `git show`。

## 限制
- 只能访问 /workspace/extra 下的文件。
- 禁用网页搜索、外链抓取、联网查资料。
- 不做 `git blame`、`git log --all`、跨仓库对比等大范围探索。
- 证据不足时把原因写进 scope_limitations，不要臆测。

## 问题分类（每个 finding 必须标注之一）
- 语法错误 / 逻辑漏洞 / 性能问题 / 安全风险 / 代码规范

## 风险等级
- high：必须修复（数据损坏、安全漏洞、生产事故、功能失效）
- medium：建议修复（可维护性、性能、潜在边界）
- low：可选优化

## 审查原则
1. 先高风险、后中低风险，最后列可取之处
2. 每个问题给出具体修复建议（含示例片段）
3. 无明显问题时显式说明「未发现明显问题」并指出亮点
4. 上下文不足写 scope_limitations，不要伪装成问题

## 输出协议
只返回一个 JSON 对象，不要前言、不要 markdown 包裹、不要 `---REVIEW_BODY---`：

{"overall":"pass|warn|fail","summary":"中文结论","findings":[{"severity":"high|medium|low","file":"...","line":"42 或 42-50","type":"...","title":"...","detail":"...","suggestion":"..."}],"file_reviews":[{"file":"...","summary":"..."}],"scope_limitations":[],"commit_reviews":[{"commit":"sha","title":"...","author":"...","positives":[],"issues":[]}],"suggestions":[],"confidence":"high|medium|low","recommended_block":false,"raw_report_markdown":"可选"}

除 overall / severity / confidence 等枚举外，所有面向用户的文字必须使用简体中文。
```

五个 prompt key 的差异：

| Key | 差异点 |
| --- | --- |
| `repo_review.primary` | 基础模板，单 agent 路径用 |
| `repo_review.diff_worker` | 额外说明"你只负责文件组 {groupFiles}，file_reviews 只写这组文件" |
| `repo_review.split_main` | 额外说明"子代理已产出 findings 摘要：{workerFindings}，你做跨文件合并与最终结论" |
| `repo_review.supplemental_file` | 额外说明"当前是第二阶段，只针对 {filePath} 做文件级完整审查" |
| `repo_review.supplemental_orchestrator` | manifest + 分派说明 |

变量一律缩减到"必要元数据"：repositoryName、baseSha、headSha、branch、stage、source、fileCount、changedFiles（路径清单）、customPromptBlock、可选的 groupFiles / workerFindings / filePath / primarySummary。**不再注入** `diffText`、`filteredDiff`、`fileContent`、`projectContextBlocks`。

### 2. 单一真相源

目前 `src/prompt-registry.ts` 里的 `defaultTemplate` 是"占位符壳"，而 `src/repo-review-run-executor.ts` 里的 fallbackPrompt 是全量版本——两份会漂移（这次事故的放大器之一）。

改造方案：把五个 prompt 的模板抽到 `src/repo-review-prompt-templates.ts`（新文件），导出 `REPO_REVIEW_PROMPT_TEMPLATES`（`Record<PromptKey, string>`）。

- `prompt-registry.ts` 的 `defaultTemplate` 直接引用该常量。
- `repo-review-run-executor.ts` 的 `fallbackText` 也引用该常量。
- `resolvePromptText` 的优先级保持不变：DB 配置 > fallbackText > registry default，但 fallbackText 和 registry default 现在恒等。

这样用户在 Prompt Center 删除配置会回退到同一份默认，保存任何改动也不会意外瘦身。

### 3. `ReviewPreparedContext` 精简

现有 `prepareReviewContext` 会生成 `diffText`、`diffIndex`、`projectContextBlocks` 等字段。新模式下这些不再进 prompt。

- `diffText`：保留生成（成本很低：一次 `git diff base..head`），仅用于 `review_runs.diff_bytes` 列的大小快照，不再参与 prompt。
- `diffIndex`：只在"split diff 按文件切片"场景用。split 禁用后可删除。
- `projectContextBlocks`：整段删除，executor 不再读取 CLAUDE.md / README / changed files 全文。

### 4. Split-diff 路径

当前 `diffSubagentThreshold` 按 diff 字节数触发拆分。新模式下 prompt 与 diff 体积解耦，该阈值语义失效。

采用方案 B：**第一版直接禁用 split-diff 路径**，所有审查走 primary 单 agent。理由：

- YAGNI。新模式下 agent 自行决定读哪些文件，并行 subagent 的主要价值（避免 prompt 过长）已消失。
- `diff_worker` / `split_main` 两个 prompt key 仍保留在 registry 和模板文件里，但 executor 暂不调用。未来如果真的需要按文件数并行（例如 > 50 文件的 monorepo 审查），可以以"按 changed file 数阈值"的新语义重新启用，不会破坏 Prompt Center 兼容。
- `diffSubagentThreshold` 字段在 profile 上保留但标注 deprecated；UI 不移除，行为视为 0（即从不拆分）。

### 5. `includeFullFileContext` 语义变化

该开关原本控制"是否在 prompt 里注入变更文件全文"。新模式下第一阶段 prompt 永远不注入全文，因此该语义不再适用。

新语义：**只控制是否执行第二阶段「逐文件全文复审」**。

- 开关 OFF（默认）：只跑第一阶段 primary 审查；agent 自行决定要不要读全文。
- 开关 ON：第一阶段结束后，针对每个变更文件跑一次 `supplemental_file` 复审（supplemental orchestrator 依旧按当前 manifest 流程分派，但 worker prompt 也按新 lean 模式重写）。

### 6. 输出协议

保留 5771a0e 引入的单 JSON 协议，修掉那个悬空 bullet（`"- 除 overall..."`）。不再引入长 Markdown 模板。parseReviewResult 现有逻辑兼容，无需改动。

### 7. 遥测与诊断

- `recordRepoReviewPromptBytes`：保留，但只记录 prompt 构建后的长度（现在恒定几 KB，便于对比回归）。
- `recordPromptTrace`：保留并扩展——metadata 里新增 `promptSource: 'lean_v1'`，方便日后按版本切片排查。
- review_runs.diff_bytes：继续记录（从独立 git diff 结果算），与 prompt 大小解耦。

## 验证

### 单元测试（`src/repo-review-service.test.ts` 或新文件 `src/repo-review-prompt.test.ts`）

1. `buildReviewPrompt` 返回内容不含 `prepared.diffText`、不含 changed file 全文。
2. prompt 长度上限：同一 profile 下，构造 1MB diff 与构造 1KB diff，prompt 长度偏差 < 5%（验证体积与 diff 解耦）。
3. `resolvePromptText` 在 DB 无配置时返回值 === `REPO_REVIEW_PROMPT_TEMPLATES[key]`（经变量渲染）。
4. DB 配置为空字符串时回退到默认模板（防止 "保存空配置就废掉审查"）。
5. `supplemental_file` prompt 不含 `fileContent` 全文。

### 集成验证

- 本地起服务，对一个挂了 `bg-mp-product-analysis` 风格的业务仓做一次审查：
  - 确认 agent 真的发起了 `git diff` / `read_file` 调用（在 `prompt_traces` / turn events 里可见）。
  - 审查不再被模型拒答，能正常返回 JSON 结构化结果。
- 在 Prompt Center UI 里保存一份自定义 `repo_review.primary` 模板，重跑审查，确认生效；清除后重跑，确认回退到默认。

## 已知风险 / 待验证

1. **agent 可能不主动 `git diff`**：若 agent 在新 prompt 下偶尔跳过 diff 直接输出结论，需要在 prompt 里把"必须先跑 `git diff`"强化为硬性前置步骤，或在 orchestrator 层做"未见 git diff 工具调用即重试一次"兜底。首轮灰度观察决定。
2. **agent 若没有 bash 权限**：需要确认 `runReviewAgent` 的 `managedSkillIds` / default tool set 是否包含 bash 与 read_file。若不含需要在 profile 级别补默认。
3. **`git -C /workspace/extra` 在容器里可用性**：`agent-runner` 目前允许 bash，但需确认容器里装了 git 且 readonly 挂载不会阻塞 `git diff`（只读对 `git diff` 应无影响）。
4. **旧 review_runs 回放**：旧记录里的 `markdown_body` / `raw_model_output` 保留原格式，渲染路径不变。

## 落地范围（影响文件）

- 新增：`src/repo-review-prompt-templates.ts`
- 改：`src/prompt-registry.ts`（五个 `repo_review.*` 的 `defaultTemplate` 改为引用新常量）
- 改：`src/repo-review-run-executor.ts`
  - `buildReviewPrompt` / `buildDiffWorkerPrompt` / `buildSplitDiffMainPrompt` / `buildSupplementalFileReviewPrompt` / `buildSupplementalFullFileReviewOrchestratorPrompt`：
    - fallbackText 改为新模板
    - 变量集合替换为精简版
    - 调用端不再传 `diffText` / `filteredDiff` / `fileContent` / `projectContextBlocks`
  - `runSplitDiffReview`：暂不进入（由上层判断短路）
  - 配套清理 `buildDiffStatsFromTasks` 等只服务 split 的辅助函数（若最终不再被引用）
- 改：`src/repo-review-service.ts`
  - `diffSubagentThreshold` 语义变为 "always 0"；profile save 仍保留字段兼容
  - `includeFullFileContext` 语义收窄为"是否执行第二阶段"
  - `prepareReviewContext`：移除 `projectContextBlocks` 构建
- 改：`src/repo-review-model.ts` 相关类型（移除 `projectContextBlocks` 等字段）
- 新增测试：`src/repo-review-prompt.test.ts`
- 文档：`docs/RepoReview.md` 更新"prompt 合同"章节

## 向前兼容

- Prompt Center DB 中 `repo_review.*` 记录仍然有效，只是模板变量集合改变——旧的 DB 模板若引用了已移除变量（如 `{{diffText}}`）会被渲染成空串，不会抛错（`stringifyPromptVariable` 对 undefined 返回 ''）。
- 既有 `review_runs` 行、`prompt_traces` 行不受影响。
- 当前 Prompt Center 表里没有任何配置，回归点仅在 fallback。

## 开放问题

- **按文件数并行化** 是否作为 follow-up：如果单 agent 在 50+ 文件大仓审查里慢到无法接受，再启用 diff_worker 路径（按 file group 分派，prompt 仍走 lean 版）。建议先上线观察 1–2 周再决定。