import { describe, expect, it } from 'vitest';

import {
  buildRepoReviewCloudDoc,
  buildRepoReviewSummaryMessage,
} from './repo-review-doc-render.js';
import type { RepoReviewRepository, RepoReviewRun } from './repo-review-service.js';

function createRepository(): RepoReviewRepository {
  return {
    id: 'repo-doc-render',
    name: 'feature/login',
    language: 'TypeScript',
    localRepoPath: 'D:/repo',
    remoteProvider: 'github',
    remoteRepoSlug: 'team/repo',
    remoteBaseUrl: 'https://github.com',
    cloneUrl: 'https://github.com/team/repo.git',
    defaultTargetBranch: 'main',
    reviewChatJid: 'feishu:test-chat',
    actorMentionMappings: [],
    reviewerUsernames: [],
    autoSyncEnabled: false,
    autoSyncIntervalMinutes: 30,
    lastAutoSyncAt: '',
    nextAutoSyncAt: '',
    lastAutoSyncStatus: '',
    lastAutoSyncMessage: '',
    enabled: true,
    hasWebhookSecret: false,
    hasPlatformToken: false,
  };
}

function createRun(): RepoReviewRun {
  return {
    id: 'run-doc-render',
    repositoryId: 'repo-doc-render',
    profileId: 'profile-doc-render',
    source: 'github',
    stage: 'push',
    status: 'completed',
    idempotencyKey: 'repo-doc-render:push:feature/login:head-sha-1',
    overall: 'fail',
    passDecisionMode: 'ai',
    recommendedBlock: true,
    blockingEnforced: true,
    baselineSource: 'default-branch-head',
    baselineRef: 'origin/main',
    baselineLabel: 'main baseline',
    resultState: 'failed',
    ref: 'refs/heads/feature/login',
    branch: 'feature/login',
    baseSha: '1111111111111111111111111111111111111111',
    headSha: '2222222222222222222222222222222222222222',
    prMrNumber: '42',
    actor: 'alice',
    summary: '登录流程存在真实风险，需要先补齐边界校验。',
    findings: [
      {
        severity: 'high',
        file: 'src/auth.ts',
        title: '缺少 token 判空',
        detail: '空 token 会直接进入后续逻辑，导致鉴权状态不一致。',
        suggestion: '在进入鉴权主流程前显式拒绝空 token 并补充回归测试。',
      },
      {
        severity: 'medium',
        file: 'src/login.ts',
        title: '错误映射不稳定',
        detail: '上游超时和鉴权失败被映射成同一种错误码。',
        suggestion: '拆分错误码并保留可观测字段。',
      },
    ],
    fileReviews: [
      {
        file: 'src/auth.ts',
        summary: [
          '已复核当前完整文件，核心风险仍集中在 token 判空与鉴权入口边界。',
          '值得保留的是：鉴权主流程拆分较清晰。',
          '需要继续关注的是：token 判空缺失会放大后续状态不一致风险。',
          '建议优先处理：补充空 token 快速失败与回归测试。',
        ].join('\n\n'),
      },
      {
        file: 'src/login.ts',
        summary: '已复核当前完整文件，暂未发现独立于 diff 之外的新风险。',
      },
    ],
    scopeLimitations: ['本次仅覆盖当前 diff，未验证历史兼容分支。'],
    reviewTurns: [],
    commitDetails: [
      {
        commit: '2222222',
        sha: '2222222222222222222222222222222222222222',
        title: 'feat: add login flow',
        author: 'alice',
        message: 'feat: add login flow',
        timestamp: '2026-03-27T10:00:00.000Z',
      },
    ],
    commitReviews: [
      {
        commit: '2222222',
        title: 'feat: add login flow',
        author: 'alice',
        positives: ['主流程拆分清楚。'],
        issues: ['缺少 token 判空。'],
      },
    ],
    suggestions: ['先修复高风险鉴权问题，再补充错误码回归测试。'],
    changedFiles: ['src/auth.ts', 'src/login.ts'],
    diffBytes: 4096,
    durationMs: 120000,
    platformStatus: '',
    chatDeliveryStatus: 'delivered',
    platformStatusDeliveryStatus: 'skipped',
    platformCommentDeliveryStatus: 'skipped',
    platformCommentId: '',
    platformCommentUrl: '',
    lastDeliveryError: '',
    deliveryRetryCount: 0,
    effectiveRules: {},
    manualDecision: '',
    manualDecisionBy: '',
    manualDecisionAt: '',
    error: '',
    startedAt: '2026-03-27T10:00:00.000Z',
    completedAt: '2026-03-27T10:05:00.000Z',
    createdAt: '2026-03-27T10:00:00.000Z',
    updatedAt: '2026-03-27T10:05:00.000Z',
  };
}

describe('repo-review-doc-render', () => {
  it('renders the full repo-review cloud doc with deterministic sections', () => {
    const rendered = buildRepoReviewCloudDoc({
      repository: createRepository(),
      run: createRun(),
    });

    expect(rendered.title).toBe('feature/login 2026-03-27 10:05');
    expect(rendered.sections[0]).toEqual({
      kind: 'heading',
      level: 1,
      text: 'feature/login · feature/login 审查报告',
    });
    expect(rendered.summaryLines).toContain('总体结论：不通过');
    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'paragraph' && section.text.includes('**Base：**'),
      ),
    ).toBe(true);
    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'paragraph' &&
          section.text.includes('**\u6765\u6e90\uff1a**'),
      ),
    ).toBe(true);
    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'paragraph' &&
          section.text.includes('**\u98ce\u9669\u7edf\u8ba1\uff1a**\u9ad8 1 / \u4e2d 1 / \u4f4e 0'),
      ),
    ).toBe(true);
    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'heading' && section.text === '审查边界',
      ),
    ).toBe(true);
    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'heading' &&
          section.text === '后续建议',
      ),
    ).toBe(true);
    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'heading' &&
          section.text === '变更文件全文审查',
      ),
    ).toBe(true);
    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'paragraph' &&
          section.text.includes('已复核当前完整文件，核心风险仍集中在 token 判空与鉴权入口边界。'),
      ),
    ).toBe(true);
    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'paragraph' &&
          section.text.includes('值得保留的是：鉴权主流程拆分较清晰。'),
      ),
    ).toBe(true);
    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'heading' && section.text === '缺少 token 判空',
      ),
    ).toBe(false);
    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'paragraph' &&
          section.text.includes('[高风险] 缺少 token 判空'),
      ),
    ).toBe(true);
    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'paragraph' &&
          section.text.includes('src/auth.ts'),
      ),
    ).toBe(true);
  });

  it('renders code evidence for findings when snippet context is provided', () => {
    const rendered = buildRepoReviewCloudDoc({
      repository: createRepository(),
      run: createRun(),
      findingEvidence: {
        'src/auth.ts::缺少 token 判空': [
          '@@ -1,3 +1,7 @@',
          '-export function authenticate(token: string) {',
          '+export function authenticate(token?: string) {',
          '+  if (!token) {',
          '+    throw new Error("token required");',
          '+  }',
          '   return verifyToken(token);',
          ' }',
        ].join('\n'),
      },
    });

    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'code' &&
          section.text.includes('if (!token) {'),
      ),
    ).toBe(true);
  });

  it('renders full-file supplemental findings in a dedicated section', () => {
    const run = createRun();
    run.findings.push({
      severity: 'low',
      file: 'src/login.ts',
      title: '[全文件补充] 文件级兜底校验仍然缺失',
      detail: '虽然本次 diff 未直接触达，但当前文件整体仍缺少统一参数校验。',
      suggestion: '补充统一入口校验，避免不同调用路径行为不一致。',
    });

    const rendered = buildRepoReviewCloudDoc({
      repository: createRepository(),
      run,
    });

    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'paragraph' &&
          section.text.includes('[低风险] 文件级兜底校验仍然缺失'),
      ),
    ).toBe(true);
  });

  it('renders raw model output in a fallback section when structured parsing failed', () => {
    const run = createRun();
    run.summary = '模型输出未完全结构化，已回退展示原始审查结果。';
    run.findings = [
      {
        severity: 'medium',
        file: 'src/demo.ts',
        title: '审查输出格式不符合要求',
        detail: 'Unexpected end of JSON input',
      },
    ];
    run.markdownBody = [
      '## 代码审查报告',
      '',
      '### 一、审查总结',
      '这是原始 Markdown 审查结果。',
    ].join('\n');
    run.rawModelOutput = run.markdownBody;

    const rendered = buildRepoReviewCloudDoc({
      repository: createRepository(),
      run,
    });

    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'heading' &&
          section.text === '原始审查输出（回退）',
      ),
    ).toBe(true);
    expect(
      rendered.sections.some(
        (section) =>
          section.kind === 'paragraph' &&
          section.text.includes('这是原始 Markdown 审查结果。'),
      ),
    ).toBe(true);
  });

  it('builds a short repo-review summary message and flags incomplete authorization explicitly', () => {
    const text = buildRepoReviewSummaryMessage({
      repository: createRepository(),
      run: createRun(),
      cloudDocUrl: 'https://tenant.feishu.cn/docx/doccn123',
      authorizationIncomplete: true,
    });

    expect(text).toContain('**AI 审查完成** · feature/login');
    expect(text).toContain('[medium] src/login.ts: 错误映射不稳定');
    expect(text).toContain(
      'https://tenant.feishu.cn/docx/doccn123',
    );
    expect(text).toContain('云文档已生成，但飞书授权可能不完整，请检查访问权限。');
    expect(text).not.toContain('提交点评:');
    expect(text).not.toContain('空 token 会直接进入后续逻辑');
  });
});
