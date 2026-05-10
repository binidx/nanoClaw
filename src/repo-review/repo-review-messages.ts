import type { ReviewStage } from '../db.js';
import type {
  RepoReviewCommitInfo,
  RepoReviewCommitReview,
  RepoReviewEvent,
  RepoReviewProfile,
  RepoReviewRepository,
  RepoReviewRun,
  ReviewPreparedContext,
} from './repo-review-model.js';
import { shortSha } from './repo-review-model.js';

export function formatReviewLinkLabel(run: RepoReviewRun): string {
  const branch = run.branch || 'unknown';
  let dateStr = '';
  if (run.createdAt) {
    const d = new Date(run.createdAt);
    if (Number.isFinite(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0');
      dateStr = ` ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  return `${branch}${dateStr}`;
}

export function overallLabel(
  overall: RepoReviewRun['overall'] | string,
): string {
  if (overall === 'pass') return '通过';
  if (overall === 'warn') return '需要关注';
  if (overall === 'fail') return '不通过';
  if (overall === 'error') return '执行出错';
  if (overall === 'skipped') return '已跳过';
  return '未知';
}

function startedTitle(name: string): string {
  return `AI 审查开始 · ${name}`;
}

function completedTitle(name: string): string {
  return `AI 审查完成 · ${name}`;
}

function manualCompletedTitle(name: string): string {
  return `人工审查完成 · ${name}`;
}

function mentionResultLine(actor: string): string {
  return `${formatActorMention(actor)} 请关注以下审查结果`;
}

function conclusionRiskLine(input: {
  conclusion: string;
  high: number;
  medium: number;
  low: number;
}): string {
  return `结论: ${input.conclusion} | 风险: 高 ${input.high} / 中 ${input.medium} / 低 ${input.low}`;
}

export function branchConclusionLine(summary: string): string {
  const normalized = String(summary || '')
    .trim()
    .replace(/^分支结论[:：]\s*/u, '');
  return normalized ? `分支结论：${normalized}` : '';
}

function fullReportLine(label: string, url?: string): string {
  return `完整 CR 报告: ${label}${url ? `\n${url}` : ''}`;
}

export function resolveRepoReviewVisibleBody(
  run: Pick<
    RepoReviewRun,
    | 'markdownBody'
    | 'rawModelOutput'
    | 'summary'
    | 'findings'
    | 'commitReviews'
    | 'suggestions'
  >,
): string {
  const markdownBody = String(run.markdownBody || '').trim();
  if (markdownBody) return markdownBody;
  const rawModelOutput = String(run.rawModelOutput || '').trim();
  if (!rawModelOutput) return '';
  if (String(run.summary || '').includes('解析失败')) {
    return rawModelOutput;
  }
  if (/^```(?:markdown|md)?/i.test(rawModelOutput)) {
    return rawModelOutput;
  }
  if (!rawModelOutput.startsWith('{')) {
    return rawModelOutput;
  }
  return buildStructuredRepoReviewMarkdown(run);
}

function formatFindingMarkdown(
  finding: Pick<
    RepoReviewRun['findings'][number],
    'severity' | 'file' | 'title' | 'detail' | 'suggestion'
  >,
): string {
  const severityIcon =
    finding.severity === 'high'
      ? '🔴'
      : finding.severity === 'medium'
        ? '🟡'
        : '🔵';
  const severityLabel =
    finding.severity === 'high'
      ? '高风险'
      : finding.severity === 'medium'
        ? '中风险'
        : '低风险';
  const title = finding.title || '未命名问题';
  const issueType = finding.severity === 'high'
    ? '问题类型'
    : finding.severity === 'medium'
      ? '回归风险'
      : '代码规范';
  const fileLine = finding.file ? `**文件：** \`${finding.file}\`` : '**文件：** `未知`';
  const codeSnippet = finding.detail?.trim() || '// 模型未返回可直接展示的代码片段';
  const fixSnippet = finding.suggestion?.trim() || '// 暂无修复建议';
  return [
    `${severityIcon} [${issueType}] ${title}`,
    fileLine,
    '```text',
    codeSnippet,
    '```',
    '**问题：** ' + (finding.detail?.trim() || '暂无详细说明。'),
    '**修复建议：**',
    '```text',
    fixSnippet,
    '```',
    `风险等级：${severityLabel}`,
  ].join('\n');
}

export function buildStructuredRepoReviewMarkdown(
  run: Pick<
    RepoReviewRun,
    'summary' | 'findings' | 'commitReviews' | 'suggestions'
  >,
): string {
  const findings = run.findings || [];
  const high = findings.filter((finding) => finding.severity === 'high');
  const medium = findings.filter((finding) => finding.severity === 'medium');
  const low = findings.filter((finding) => finding.severity === 'low');
  const commitPositives = Array.from(
    new Set(
      (run.commitReviews || [])
        .flatMap((review) => review.positives || [])
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
  const suggestions = Array.from(
    new Set(
      (run.suggestions || []).map((entry) => entry.trim()).filter(Boolean),
    ),
  );

  const summaryText = branchConclusionLine(run.summary || '模型未返回摘要。');
  const buildSection = (
    heading: string,
    emptyMessage: string,
    items: typeof findings,
  ) => {
    if (items.length === 0) {
      return [`### ${heading}`, emptyMessage].join('\n');
    }
    return [
      `### ${heading}`,
      ...items.flatMap((finding) => ['', formatFindingMarkdown(finding)]),
    ].join('\n');
  };
  const lines: string[] = [
    '## 代码审查报告',
    '',
    '### 一、审查总结',
    summaryText,
    '',
    buildSection('二、高风险问题', '未发现高风险问题。', high),
    '',
    buildSection('三、中风险问题', '未发现中风险问题。', medium),
    '',
    buildSection('四、低风险问题 / 代码规范', '未发现低风险问题。', low),
    '',
    '### 五、代码亮点',
    commitPositives.length > 0
      ? commitPositives.map((item) => `- ${item}`).join('\n')
      : '未发现需要特别说明的代码亮点。',
    '',
    '### 六、总结',
    `| 风险等级 | 数量 | 主要问题 |`,
    `|---------|------|---------|`,
    `| 🔴 高风险 | ${high.length} | ${high[0]?.title || '无'} |`,
    `| 🟡 中风险 | ${medium.length} | ${medium[0]?.title || '无'} |`,
    `| 🔵 低风险 | ${low.length} | ${low[0]?.title || '无'} |`,
    '',
    suggestions.length > 0
      ? [
          `建议在合并前优先处理 ${high.length} 个高风险问题。`,
          '建议优先处理：',
          ...suggestions.map((item) => `- ${item}`),
        ].join('\n')
      : `建议在合并前优先处理 ${high.length} 个高风险问题。`,
  ];

  return lines.join('\n');
}

export function formatActorMention(actor: string): string {
  const normalized = actor.trim();
  if (!normalized) return '';
  return normalized.startsWith('@') ? normalized : `@${normalized}`;
}

function describeReviewTarget(input: {
  stage: ReviewStage;
  prMrNumber?: string;
}): string {
  if (input.prMrNumber) return `PR/MR #${input.prMrNumber}`;
  return input.stage === 'commit' ? '本次提交' : '本次推送';
}

function resolveCommitCount(input: {
  commitDetails?: RepoReviewCommitInfo[];
  commitReviews?: RepoReviewCommitReview[];
  commitSummaryLines?: string[];
}): number {
  return Math.max(
    input.commitDetails?.length || 0,
    input.commitReviews?.length || 0,
    input.commitSummaryLines?.length || 0,
  );
}

function describeStartPolicy(profile: RepoReviewProfile): string {
  if (profile.blockingMode === 'hard_fail') {
    if (profile.passDecisionMode === 'human') {
      return 'AI 提示风险，最终由人工判定是否放行';
    }
    return 'AI 判定不通过时会阻断当前提交/推送';
  }
  return '仅提示风险，不阻断当前提交/推送';
}

function describeRunHandling(input: {
  run: RepoReviewRun;
  decisionMode: 'ai' | 'human';
}): string {
  const { run, decisionMode } = input;
  if (run.blockingEnforced) {
    return '是，当前已阻断，请修复后重新提交或推送';
  }
  if (run.status === 'error' || run.overall === 'error') {
    return '审查执行出错，请查看运行日志后重试';
  }
  if (run.overall === 'skipped') {
    return '无需处理，本次审查已跳过';
  }
  if (decisionMode === 'human' && run.stage === 'push') {
    return run.recommendedBlock
      ? '需要人工确认，AI 建议暂不放行'
      : '需要人工确认，AI 未建议阻断';
  }
  if (
    run.recommendedBlock ||
    run.overall === 'fail' ||
    run.overall === 'warn'
  ) {
    return '请根据问题列表处理风险后再放行';
  }
  return '无需额外处理，可以继续';
}

function formatCommitBullet(
  commit: Pick<RepoReviewCommitInfo, 'commit' | 'title' | 'author'>,
): string {
  return `${commit.commit || '(unknown)'} ${commit.title}${commit.author ? ` · ${commit.author}` : ''}`;
}

function collectActionableSuggestions(run: RepoReviewRun): string[] {
  const merged = [...run.suggestions];
  for (const finding of run.findings) {
    if (finding.suggestion) {
      merged.push(finding.suggestion);
    }
  }
  return Array.from(
    new Set(merged.map((entry) => entry.trim()).filter(Boolean)),
  );
}

export function formatRepoReviewStartedMessage(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
}): string {
  const commitCount = resolveCommitCount({
    commitDetails: input.prepared.commitDetails,
    commitSummaryLines: input.prepared.commitSummaryLines,
  });
  const target = describeReviewTarget({
    stage: input.event.stage,
    prMrNumber: input.event.prMrNumber,
  });
  const lines = [
    startedTitle(input.repository.name),
    `对象: ${target}`,
    `Profile: ${input.profile.name}`,
    `阶段: ${input.event.stage} | 来源: ${input.event.source}`,
    input.prepared.actor ? `提交人: ${input.prepared.actor}` : '',
    input.prepared.branch ? `分支: ${input.prepared.branch}` : '',
    `提交数: ${commitCount}`,
    `变更文件数: ${input.prepared.changedFiles.length}`,
    input.event.prMrNumber ? `PR/MR: #${input.event.prMrNumber}` : '',
    input.prepared.baseSha ? `Base: ${shortSha(input.prepared.baseSha)}` : '',
    input.prepared.headSha ? `Head: ${shortSha(input.prepared.headSha)}` : '',
    `审查策略: ${describeStartPolicy(input.profile)}`,
    '当前动作: AI 正在分析这次改动，稍后会给出结论和处理建议',
    `变更文件 (${input.prepared.changedFiles.length}):`,
    ...(input.prepared.changedFiles.length > 0
      ? input.prepared.changedFiles.slice(0, 12)
      : ['- (none)']),
  ];
  if (input.prepared.changedFiles.length > 12) {
    lines.push(
      `... 还有 ${input.prepared.changedFiles.length - 12} 个文件未列出`,
    );
  }
  if (input.prepared.commitSummaryLines.length > 0) {
    lines.push('提交摘要:');
    lines.push(...input.prepared.commitSummaryLines.slice(0, 10));
  }
  return lines.join('\n');
}

export function formatRepoReviewMarkdownMessage(
  repository: RepoReviewRepository,
  run: RepoReviewRun,
  opts?: { shareUrl?: string; skipActorMention?: boolean },
): string {
  const high = run.findings.filter((f) => f.severity === 'high').length;
  const medium = run.findings.filter((f) => f.severity === 'medium').length;
  const low = run.findings.filter((f) => f.severity === 'low').length;
  const lines = [
    !opts?.skipActorMention && run.actor ? mentionResultLine(run.actor) : '',
    completedTitle(repository.name),
    conclusionRiskLine({
      conclusion: overallLabel(run.overall || run.status),
      high,
      medium,
      low,
    }),
    branchConclusionLine(run.summary),
  ].filter(Boolean);
  const body = resolveRepoReviewVisibleBody(run);
  if (body) {
    lines.push('');
    lines.push(body);
  }
  if (opts?.shareUrl) {
    lines.push('');
    lines.push(fullReportLine(formatReviewLinkLabel(run), opts.shareUrl));
  }
  return lines.join('\n');
}

export function formatRepoReviewShareLinkMessage(
  repository: RepoReviewRepository,
  run: RepoReviewRun,
  shareUrl: string,
  opts?: { skipActorMention?: boolean },
): string {
  const allFindings = run.findings ?? [];
  const high = allFindings.filter((f) => f.severity === 'high').length;
  const medium = allFindings.filter((f) => f.severity === 'medium').length;
  const low = allFindings.filter((f) => f.severity === 'low').length;
  const findings = allFindings.slice(0, 3);
  const lines = [
    !opts?.skipActorMention && run.actor ? mentionResultLine(run.actor) : '',
    completedTitle(repository.name),
    conclusionRiskLine({
      conclusion: overallLabel(run.overall || run.status),
      high,
      medium,
      low,
    }),
    branchConclusionLine(run.summary),
  ].filter(Boolean);
  if (findings.length > 0) {
    lines.push('');
    lines.push('关键问题:');
    for (const finding of findings) {
      lines.push(
        `[${finding.severity}] ${finding.file ? `${finding.file}: ` : ''}${finding.title}`,
      );
    }
  }
  lines.push('');
  lines.push(fullReportLine(formatReviewLinkLabel(run), shareUrl));
  return lines.join('\n');
}

export function formatRepoReviewCompletedMessage(
  repository: RepoReviewRepository,
  run: RepoReviewRun,
  decisionMode: 'ai' | 'human' = 'ai',
  opts?: { skipActorMention?: boolean },
): string {
  const target = describeReviewTarget({
    stage: run.stage,
    prMrNumber: run.prMrNumber,
  });
  const commitCount = resolveCommitCount({
    commitDetails: run.commitDetails,
    commitReviews: run.commitReviews,
  });
  const actionableSuggestions = collectActionableSuggestions(run);
  const lines = [
    !opts?.skipActorMention && run.actor ? mentionResultLine(run.actor) : '',
    completedTitle(repository.name),
    `AI 结论: ${overallLabel(run.overall || run.status)}`,
    `需处理: ${describeRunHandling({ run, decisionMode })}`,
    `对象: ${target}`,
    `阶段: ${run.stage} | 来源: ${run.source}`,
    run.actor ? `提交人: ${run.actor}` : '',
    run.branch ? `分支: ${run.branch}` : '',
    `提交数: ${commitCount}`,
    `变更文件数: ${run.changedFiles.length}`,
    run.prMrNumber ? `PR/MR: #${run.prMrNumber}` : '',
    run.baseSha ? `Base: ${shortSha(run.baseSha)}` : '',
    run.headSha ? `Head: ${shortSha(run.headSha)}` : '',
    run.blockingEnforced ? '阻断状态: 已阻断' : '',
    decisionMode === 'human' &&
    run.stage === 'push' &&
    run.overall !== 'skipped' &&
    run.overall !== 'error'
      ? '人工判定: 等待人工确认'
      : '',
    decisionMode === 'human' && run.recommendedBlock && run.stage === 'push'
      ? 'AI 建议: 暂不放行'
      : '',
  ].filter(Boolean);
  if (run.summary) {
    lines.push('');
    lines.push('分支结论:');
    lines.push(run.summary);
  }
  if (run.changedFiles.length > 0) {
    lines.push('');
    lines.push(`变更文件 (${run.changedFiles.length}):`);
    lines.push(...run.changedFiles.slice(0, 12));
    if (run.changedFiles.length > 12) {
      lines.push(`... 还有 ${run.changedFiles.length - 12} 个文件未列出`);
    }
  }
  if (run.findings.length > 0) {
    lines.push('');
    lines.push('主要问题:');
    for (const finding of run.findings.slice(0, 6)) {
      lines.push(
        `[${finding.severity}] ${finding.file ? `${finding.file}: ` : ''}${finding.title}${finding.detail ? ` - ${finding.detail}` : ''}`,
      );
    }
  }
  if (run.commitReviews.length > 0) {
    lines.push('');
    lines.push('提交点评:');
    for (const review of run.commitReviews.slice(0, 6)) {
      lines.push(formatCommitBullet(review));
      for (const issue of review.issues.slice(0, 3)) {
        lines.push(`  风险: ${issue}`);
      }
      for (const positive of review.positives.slice(0, 2)) {
        lines.push(`  亮点: ${positive}`);
      }
    }
  } else if (run.commitDetails.length > 0) {
    lines.push('');
    lines.push('提交摘要:');
    for (const commit of run.commitDetails.slice(0, 8)) {
      lines.push(formatCommitBullet(commit));
    }
  }
  if (run.scopeLimitations.length > 0) {
    lines.push('');
    lines.push('审查边界:');
    for (const limitation of run.scopeLimitations.slice(0, 3)) {
      lines.push(limitation);
    }
  }
  if (actionableSuggestions.length > 0) {
    lines.push('');
    lines.push('下一步建议:');
    for (const suggestion of actionableSuggestions.slice(0, 5)) {
      lines.push(suggestion);
    }
  }
  if (run.error) {
    lines.push('');
    lines.push(`Error: ${run.error}`);
  }
  return lines.join('\n');
}

export function formatRepoReviewPlatformCommentMessage(
  repository: RepoReviewRepository,
  run: RepoReviewRun,
  decisionMode: 'ai' | 'human' = 'ai',
): string {
  const actionableSuggestions = collectActionableSuggestions(run);
  const lines = [
    completedTitle(repository.name),
    `AI 结论: ${overallLabel(run.overall || run.status)}`,
    `需处理: ${describeRunHandling({ run, decisionMode })}`,
    run.branch ? `分支: ${run.branch}` : '',
    run.headSha ? `Head: ${shortSha(run.headSha)}` : '',
    run.summary ? `摘要: ${run.summary}` : '',
  ].filter(Boolean);
  if (run.findings.length > 0) {
    lines.push('');
    lines.push('关键问题:');
    for (const finding of run.findings.slice(0, 3)) {
      lines.push(
        `[${finding.severity}] ${finding.file ? `${finding.file}: ` : ''}${finding.title}${finding.detail ? ` - ${finding.detail}` : ''}`,
      );
    }
  }
  if (run.scopeLimitations.length > 0) {
    lines.push('');
    lines.push('审查边界:');
    lines.push(run.scopeLimitations[0]!);
  }
  if (actionableSuggestions.length > 0) {
    lines.push('');
    lines.push('下一步建议:');
    for (const suggestion of actionableSuggestions.slice(0, 3)) {
      lines.push(suggestion);
    }
  }
  return lines.join('\n');
}

export function formatRepoReviewManualDecisionMessage(input: {
  repository: RepoReviewRepository;
  run: RepoReviewRun;
  decision: 'pass' | 'fail';
  decidedBy: string;
  decidedAt: string;
  skipActorMention?: boolean;
}): string {
  const { repository, run, decision, decidedBy, decidedAt } = input;
  const target = describeReviewTarget({
    stage: run.stage,
    prMrNumber: run.prMrNumber,
  });
  const commitCount = resolveCommitCount({
    commitDetails: run.commitDetails,
    commitReviews: run.commitReviews,
  });
  const decisionLabel = decision === 'pass' ? '人工通过' : '人工驳回';
  const handling =
    decision === 'pass'
      ? '已人工确认通过，可以继续'
      : '人工确认不通过，请修复后重新提交或推送';
  const lines = [
    !input.skipActorMention && run.actor ? mentionResultLine(run.actor) : '',
    manualCompletedTitle(repository.name),
    `最终结论: ${decisionLabel}`,
    `AI 结论: ${overallLabel(run.overall || run.status)}`,
    `处理结果: ${handling}`,
    `对象: ${target}`,
    `阶段: ${run.stage} | 来源: ${run.source}`,
    run.actor ? `提交人: ${run.actor}` : '',
    run.branch ? `分支: ${run.branch}` : '',
    `提交数: ${commitCount}`,
    `变更文件数: ${run.changedFiles.length}`,
    decidedBy ? `判定人: ${decidedBy}` : '',
    decidedAt ? `判定时间: ${new Date(decidedAt).toLocaleString('zh-CN')}` : '',
    run.summary ? `摘要: ${run.summary}` : '',
  ].filter(Boolean);
  if (run.findings.length > 0) {
    lines.push('主要问题:');
    for (const finding of run.findings.slice(0, 5)) {
      lines.push(
        `[${finding.severity}] ${finding.file ? `${finding.file}: ` : ''}${finding.title}${finding.detail ? ` - ${finding.detail}` : ''}`,
      );
    }
  }
  if (run.suggestions.length > 0) {
    lines.push('下一步建议:');
    for (const suggestion of run.suggestions.slice(0, 4)) {
      lines.push(suggestion);
    }
  }
  return lines.join('\n');
}
