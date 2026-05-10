import type {
  RepoReviewFileReview,
  RepoReviewRepository,
  RepoReviewRun,
  RepoReviewRunFinding,
} from './repo-review-service.js';
import {
  formatActorMention,
  formatReviewLinkLabel,
  overallLabel,
  resolveRepoReviewVisibleBody,
} from './repo-review-messages.js';
import { shortSha } from './repo-review-model.js';

export type RepoReviewCloudDocSection =
  | {
      kind: 'heading';
      level: 1 | 2 | 3;
      text: string;
    }
  | {
      kind: 'paragraph' | 'code';
      text: string;
    };

export interface RepoReviewCloudDocModel {
  title: string;
  summaryLines: string[];
  sections: RepoReviewCloudDocSection[];
}

type RepoReviewFindingBucket = 'diff' | 'full_file';

export function buildRepoReviewFindingEvidenceKey(
  finding: Pick<RepoReviewRunFinding, 'file' | 'title'>,
): string {
  return `${String(finding.file || '').trim()}::${String(finding.title || '').trim()}`;
}

function heading(level: 1 | 2 | 3, text: string): RepoReviewCloudDocSection {
  return { kind: 'heading', level, text };
}

function paragraph(text: string): RepoReviewCloudDocSection {
  return { kind: 'paragraph', text };
}

function code(text: string): RepoReviewCloudDocSection {
  return { kind: 'code', text };
}

function appendParagraphBlocks(
  sections: RepoReviewCloudDocSection[],
  text: string,
): void {
  const blocks = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length === 0) {
    sections.push(paragraph('暂无内容。'));
    return;
  }
  for (const block of blocks) {
    sections.push(paragraph(block));
  }
}

function formatReviewTime(value: string): string {
  const iso = String(value || '').trim();
  if (!iso) return 'unknown';
  return iso.replace('T', ' ').slice(0, 16);
}

function formatReviewScopeText(run: RepoReviewRun): string {
  const base = shortSha(run.baseSha || '');
  const head = shortSha(run.headSha || '');
  if (base && head) return `${base}..${head}`;
  if (head) return `${head}^!`;
  if (base) return `${base}..HEAD`;
  return 'unknown';
}

function normalizeLine(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function countRiskLevels(run: RepoReviewRun): {
  high: number;
  medium: number;
  low: number;
} {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const finding of run.findings) {
    if (finding.severity === 'high') {
      high += 1;
    } else if (finding.severity === 'low') {
      low += 1;
    } else {
      medium += 1;
    }
  }
  return { high, medium, low };
}

function truncateLine(value: string, maxLength: number): string {
  const normalized = normalizeLine(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function collectSuggestedNextActions(run: RepoReviewRun): string[] {
  const seen = new Set<string>();
  const actions: string[] = [];
  for (const suggestion of run.suggestions) {
    const normalized = normalizeLine(suggestion);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    actions.push(normalized);
  }
  if (actions.length > 0) {
    return actions;
  }
  if (run.recommendedBlock) {
    return ['建议先修复阻断风险，再继续合并或发布。'];
  }
  return ['按常规流程复核后继续推进。'];
}

function isPlaceholderScopeLimitation(text: string): boolean {
  const normalized = normalizeLine(text).toLowerCase();
  return (
    normalized.includes('no explicit scope limitations') ||
    normalized.includes('无明确审查边界限制') ||
    !normalized
  );
}

function classifyRepoReviewFindingBucket(
  finding: Pick<RepoReviewRunFinding, 'title'>,
): RepoReviewFindingBucket {
  return normalizeLine(finding.title).startsWith('[全文件补充]')
    ? 'full_file'
    : 'diff';
}

function stripFullFileFindingPrefix(title: string): string {
  return normalizeLine(title).replace(/^\[全文件补充\]\s*/u, '').replace(/^\[Full file\]\s*/u, '') || title.trim();
}

function isRawOutputFallbackRun(
  run: Pick<RepoReviewRun, 'summary' | 'findings' | 'rawModelOutput'>,
): boolean {
  if (!normalizeLine(run.rawModelOutput || '')) {
    return false;
  }
  const summary = normalizeLine(run.summary);
  if (summary.includes('解析失败') || summary.includes('未完全结构化')) {
    return true;
  }
  return run.findings.some(
    (finding) =>
      normalizeLine(finding.title) === '模型输出解析失败' ||
      normalizeLine(finding.title) === '审查输出格式不符合要求',
  );
}

function severityEmoji(severity: RepoReviewRunFinding['severity']): string {
  switch (severity) {
    case 'high':
      return '\u{1F534}';
    case 'medium':
      return '\u{1F7E1}';
    case 'low':
      return '\u{1F7E2}';
  }
}

function severityLabel(severity: RepoReviewRunFinding['severity']): string {
  switch (severity) {
    case 'high':
      return '高风险';
    case 'medium':
      return '中风险';
    case 'low':
      return '低风险';
  }
}

function renderFindingSection(
  sections: RepoReviewCloudDocSection[],
  findings: RepoReviewRunFinding[],
  input: { findingEvidence?: Record<string, string> },
): void {
  for (let i = 0; i < findings.length; i += 1) {
    const finding = findings[i]!;
    if (i > 0) {
      sections.push(paragraph('\u200B'));
    }
    const title =
      classifyRepoReviewFindingBucket(finding) === 'full_file'
        ? stripFullFileFindingPrefix(finding.title)
        : finding.title;
    sections.push(
      paragraph(
        `${severityEmoji(finding.severity)} [${severityLabel(finding.severity)}] ${title}`,
      ),
    );
    if (finding.file) {
      sections.push(paragraph(`**文件：**${finding.file}`));
    }
    const evidence = String(
      input.findingEvidence?.[buildRepoReviewFindingEvidenceKey(finding)] || '',
    ).trim();
    if (evidence) {
      sections.push(paragraph('**关键证据：**'));
      sections.push(code(evidence));
    }
    sections.push(
      paragraph(`**问题：**${finding.detail || '暂无详细说明。'}`),
    );
    if (finding.suggestion) {
      sections.push(paragraph(`**修复建议：**${finding.suggestion}`));
    }
  }
}

function renderFileReviewSection(
  sections: RepoReviewCloudDocSection[],
  fileReviews: RepoReviewFileReview[],
): void {
  for (const review of fileReviews) {
    sections.push(heading(3, review.file || '(unknown file)'));
    appendParagraphBlocks(
      sections,
      review.summary || '暂无内容。',
    );
  }
}

function resolveReviewTitle(run: RepoReviewRun): string {
  return `${run.branch || 'repo-review'} · ${formatReviewScopeText(run)} · ${formatReviewTime(
    run.completedAt || run.updatedAt,
  )}`;
}

export function buildRepoReviewCloudDoc(input: {
  repository: RepoReviewRepository;
  run: RepoReviewRun;
  findingEvidence?: Record<string, string>;
}): RepoReviewCloudDocModel {
  const { repository, run } = input;
  const reviewTime = formatReviewTime(run.completedAt || run.updatedAt);
  const title = resolveReviewTitle(run);
  const riskCounts = countRiskLevels(run);
  const diffFindings = run.findings.filter(
    (finding) => classifyRepoReviewFindingBucket(finding) === 'diff',
  );
  const fullFileFindings = run.findings.filter(
    (finding) => classifyRepoReviewFindingBucket(finding) === 'full_file',
  );
  const scopeLimitations = run.scopeLimitations.filter(
    (entry) => !isPlaceholderScopeLimitation(entry),
  );
  const nextActions = collectSuggestedNextActions(run);
  const baselineText =
    run.baselineLabel || run.baselineRef || run.baselineSource || '';

  const sections: RepoReviewCloudDocSection[] = [
    heading(1, `${run.branch || 'unknown'} · ${repository.name} 审查报告`),
  ];

  // --- 概览 (compact info block) ---
  sections.push(heading(2, '审查概览'));
  sections.push(
    paragraph(
      `**整体结论：**${overallLabel(run.overall || run.status)}`,
    ),
  );
  sections.push(paragraph(run.summary || '模型未返回摘要。'));
  sections.push(
    paragraph(
      `**风险统计：**高 ${riskCounts.high} / 中 ${riskCounts.medium} / 低 ${riskCounts.low}` +
        '　｜　' +
        `**处理建议：**${run.recommendedBlock ? '建议先修复再继续' : '常规复核后可继续'}`,
    ),
  );
  const metaLines = [
    `**仓库：**${repository.name}`,
    `**分支：**${run.branch || 'unknown'}`,
    baselineText ? `**基线：**${baselineText}` : '',
    `**Base：**${run.baseSha?.slice(0, 12) || 'unknown'} → **Head：**${run.headSha?.slice(0, 12) || 'unknown'}`,
    `**来源：**${run.source || 'unknown'}　｜　**时间：**${reviewTime}`,
    run.changedFiles.length > 0
      ? `**变更文件 (${run.changedFiles.length})：**${run.changedFiles.slice(0, 15).join(', ')}${run.changedFiles.length > 15 ? ' …' : ''}`
      : '',
  ].filter(Boolean);
  sections.push(paragraph(metaLines.join('\n')));

  // --- 问题清单 (promoted to appear early, grouped by severity) ---
  const allFindings = [...diffFindings, ...fullFileFindings];
  if (allFindings.length === 0) {
    sections.push(heading(2, '关键问题'));
    sections.push(paragraph('未发现需要重点关注的问题。'));
  } else {
    const highFindings = allFindings.filter((f) => f.severity === 'high');
    const mediumFindings = allFindings.filter((f) => f.severity === 'medium');
    const lowFindings = allFindings.filter((f) => f.severity === 'low');

    if (highFindings.length > 0) {
      sections.push(heading(2, '高风险问题'));
      renderFindingSection(sections, highFindings, input);
    }
    if (mediumFindings.length > 0) {
      sections.push(heading(2, '中风险问题'));
      renderFindingSection(sections, mediumFindings, input);
    }
    if (lowFindings.length > 0) {
      sections.push(heading(2, '低风险问题'));
      renderFindingSection(sections, lowFindings, input);
    }
  }

  if (isRawOutputFallbackRun(run)) {
    sections.push(heading(2, '原始审查输出（回退）'));
    appendParagraphBlocks(
      sections,
      resolveRepoReviewVisibleBody(run) || '模型没有返回可解析的结构化结果。',
    );
  }

  // --- 提交点评 ---
  if (run.commitDetails.length > 0) {
    sections.push(heading(2, '提交点评'));
    for (const commit of run.commitDetails) {
      const review = run.commitReviews.find(
        (entry) => entry.commit === commit.commit || entry.title === commit.title,
      );
      const commitLabel = [commit.commit || '', commit.title || ''].filter(Boolean).join(' ');
      sections.push(heading(3, commitLabel || 'unknown'));
      const commitMeta = [
        `作者：${commit.author || 'unknown'}`,
        commit.timestamp ? `时间：${formatReviewTime(commit.timestamp)}` : '',
      ].filter(Boolean);
      sections.push(paragraph(commitMeta.join('　｜　')));
      if (review?.positives?.length) {
        sections.push(paragraph(`✓ ${review.positives.join('；')}`));
      }
      if (review?.issues?.length) {
        sections.push(paragraph(`✗ ${review.issues.join('；')}`));
      }
    }
  }

  // --- 变更文件全文审查 ---
  if ((run.fileReviews || []).length > 0) {
    sections.push(heading(2, '变更文件全文审查'));
    renderFileReviewSection(sections, run.fileReviews || []);
  }

  // --- 后续建议 ---
  if (nextActions.length > 0) {
    sections.push(heading(2, '后续建议'));
    for (const action of nextActions) {
      sections.push(paragraph(`• ${action}`));
    }
  }

  // --- 审查边界 (moved to bottom, omitted if empty) ---
  if (scopeLimitations.length > 0) {
    sections.push(heading(2, '审查边界'));
    for (const entry of scopeLimitations) {
      sections.push(paragraph(`• ${entry}`));
    }
  }

  return {
    title,
    summaryLines: [
      `总体结论：${overallLabel(run.overall || run.status)}`,
      `分支：${run.branch || 'unknown'} · 范围：${formatReviewScopeText(run)}`,
      `风险统计：高 ${riskCounts.high} / 中 ${riskCounts.medium} / 低 ${riskCounts.low}`,
      run.summary || '模型未返回摘要。',
    ],
    sections,
  };
}

export function buildRepoReviewSummaryMessage(input: {
  repository: RepoReviewRepository;
  run: RepoReviewRun;
  cloudDocUrl: string;
  authorizationIncomplete?: boolean;
  skipActorMention?: boolean;
}): string {
  const { repository, run } = input;
  const riskCounts = countRiskLevels(run);
  const findings = run.findings.slice(0, 3);
  const lines = [
    !input.skipActorMention && run.actor ? `${formatActorMention(run.actor)} 请关注以下审查结果` : '',
    `**AI 审查完成** · ${repository.name}`,
    `**结论:** ${overallLabel(run.overall || run.status)} | **风险:** 高 ${riskCounts.high} / 中 ${riskCounts.medium} / 低 ${riskCounts.low}`,
    run.summary ? `${truncateLine(run.summary, 120)}` : '',
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
  lines.push(`完整 CR 报告: ${formatReviewLinkLabel(run)}\n${input.cloudDocUrl}`);
  if (input.authorizationIncomplete) {
    lines.push('云文档已生成，但飞书授权可能不完整，请检查访问权限。');
  }
  return lines.join('\n');
}
