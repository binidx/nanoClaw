import { describe, expect, it } from 'vitest';

import {
  buildRepoReviewEvidenceBundle,
  mergeCanonicalRepoReviewFindings,
  partitionRepoReviewEvidenceChunks,
  renderRepoReviewMarkdownFromStructuredResult,
  shouldDirectMainAgentReview,
  type RepoReviewEvidenceBundle,
} from './repo-review-coordinator.js';

function makeBundle(
  overrides: Partial<RepoReviewEvidenceBundle> = {},
): RepoReviewEvidenceBundle {
  return {
    repository: {
      id: 'repo-1',
      name: 'Repo',
      language: 'TypeScript',
      localRepoPath: '/tmp/repo',
      remoteProvider: '',
      remoteRepoSlug: '',
      remoteBaseUrl: '',
      cloneUrl: '',
      defaultTargetBranch: 'main',
      reviewChatJid: 'chat',
      actorMentionMappings: [],
      reviewerUsernames: [],
      autoSyncEnabled: false,
      autoSyncIntervalMinutes: 0,
      lastAutoSyncAt: '',
      nextAutoSyncAt: '',
      lastAutoSyncStatus: '',
      lastAutoSyncMessage: '',
      digestDailyEnabled: false,
      digestWeeklyEnabled: false,
      digestDailyHour: 0,
      digestWeeklyDay: 0,
      digestWeeklyHour: 0,
      lastDigestDailyAt: '',
      nextDigestDailyAt: '',
      lastDigestWeeklyAt: '',
      nextDigestWeeklyAt: '',
      enabled: true,
      allowAiFix: false,
      hasWebhookSecret: false,
      hasPlatformToken: false,
    },
    profile: {
      id: 'profile-1',
      repositoryId: 'repo-1',
      name: 'Profile',
      stage: 'push',
      sourceMode: 'local',
      blockingMode: 'soft_fail',
      passDecisionMode: 'ai',
      reviewScope: 'staged_diff',
      targetBranches: [],
      skillIds: [],
      mcpServerIds: [],
      promptTemplate: '',
      includeGlobs: [],
      excludeGlobs: [],
      includeFullFileContext: true,
      maxFiles: 20,
      maxDiffBytes: 100000,
      writeToChat: false,
      writeToPlatform: false,
      reviewOutputMode: 'message',
      diffSubagentThreshold: 0,
      enabled: true,
    },
    event: {
      source: 'local-hook',
      stage: 'push',
      repositoryId: 'repo-1',
      blockingExpected: false,
    },
    prepared: {
      diffText: '',
      changedFiles: [],
      baseSha: 'base',
      headSha: 'head',
      branch: 'main',
      ref: 'refs/heads/main',
      actor: 'alice',
      commitSummaryLines: [],
      commitDetails: [],
      projectContextBlocks: [],
    },
    workspacePath: '/tmp/repo',
    files: [],
    changedFiles: [],
    diffBytes: 0,
    fileContentBytes: 0,
    totalPromptBytes: 0,
    commitSummaryBlock: '',
    projectContextBlock: '',
    directMainAgentReview: true,
    ...overrides,
  };
}

describe('repo-review coordinator', () => {
  it('prefers canonical reducer findings when worker duplicates only rephrase the same evidence', () => {
    const merged = mergeCanonicalRepoReviewFindings(
      [
        {
          severity: 'medium',
          file: 'web/src/styles/pages-misc.css',
          line: '3049-3058',
          title: 'Run detail modal 网格选择器被收窄为直接子节点，三列表布局实际失效',
          detail: '选择器从后代匹配改成直接子节点匹配，导致规则不再命中。',
          codeSnippet:
            '.modal.repo-review-run-detail-modal > .status-detail-grid {\n  grid-template-columns: repeat(3, minmax(0, 1fr));\n}',
          fixCode:
            '.modal.repo-review-run-detail-modal .status-detail-grid {\n  grid-template-columns: repeat(3, minmax(0, 1fr));\n}',
        },
      ],
      [
        {
          severity: 'medium',
          file: 'web/src/styles/pages-misc.css',
          line: '3049-3058',
          title:
            'Run detail modal grid selector was narrowed to direct children, so the 3-column layout no longer applies',
          detail:
            'The selector now requires a direct child, so the current JSX structure no longer matches.',
          codeSnippet:
            '.modal.repo-review-run-detail-modal > .status-detail-grid {\n  grid-template-columns: repeat(3, minmax(0, 1fr));\n}',
          fixCode:
            '.modal.repo-review-run-detail-modal .status-detail-grid {\n  grid-template-columns: repeat(3, minmax(0, 1fr));\n}',
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toContain('三列表布局实际失效');
  });

  it('keeps distinct findings when the evidence anchor differs', () => {
    const merged = mergeCanonicalRepoReviewFindings(
      [
        {
          severity: 'medium',
          file: 'src/db/tasks.ts',
          line: '66-73',
          title: '任务归属放宽同时作用于写路径',
          detail: '写路径被放宽。',
          codeSnippet: 'const canWrite = true;',
          fixCode: 'const canWrite = isOwner;',
        },
      ],
      [
        {
          severity: 'medium',
          file: 'src/db/tasks.ts',
          line: '88-95',
          title: '任务列表排序回退',
          detail: '排序字段被回退。',
          codeSnippet: 'ORDER BY updated_at ASC',
          fixCode: 'ORDER BY updated_at DESC',
        },
      ],
    );

    expect(merged).toHaveLength(2);
  });

  it('partitions evidence into bounded worker chunks', () => {
    const bundle = makeBundle({
      directMainAgentReview: false,
      files: Array.from({ length: 10 }, (_, index) => ({
        filePath: `src/file-${index}.ts`,
        diffText: 'diff\n' + 'x'.repeat(2000),
        diffBytes: 2000,
        fileContent: 'y'.repeat(12000),
        fileContentBytes: 12000,
        fileContentSource: 'workspace',
        groupKey: 'src',
        isTestFile: false,
        language: 'ts',
      })),
      changedFiles: Array.from(
        { length: 10 },
        (_, index) => `src/file-${index}.ts`,
      ),
      totalPromptBytes: 140000,
      fileContentBytes: 120000,
      diffBytes: 20000,
    });

    const chunks = partitionRepoReviewEvidenceChunks(bundle);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.files.length <= 8)).toBe(true);
    expect(chunks.every((chunk) => chunk.promptBytes > 0)).toBe(true);
  });

  it('coalesces worker chunks to a caller-provided upper bound when safe', () => {
    const bundle = makeBundle({
      directMainAgentReview: false,
      files: Array.from({ length: 4 }, (_, index) => ({
        filePath: `src/file-${index}.ts`,
        diffText: 'diff\n' + 'x'.repeat(40000),
        diffBytes: 40000,
        fileContent: '',
        fileContentBytes: 0,
        fileContentSource: 'omitted' as const,
        groupKey: 'src',
        isTestFile: false,
        language: 'ts',
      })),
      changedFiles: Array.from(
        { length: 4 },
        (_, index) => `src/file-${index}.ts`,
      ),
      totalPromptBytes: 160000,
      fileContentBytes: 0,
      diffBytes: 160000,
    });

    const chunks = partitionRepoReviewEvidenceChunks(bundle, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.files.length === 2)).toBe(true);
  });

  it('uses file count and prompt bytes together as the worker delegation gate', () => {
    expect(
      shouldDirectMainAgentReview({
        changedFileCount: 7,
        totalPromptBytes: 50_000,
        diffSubagentThreshold: 8,
        maxMainAgentPromptBytes: 96 * 1024,
      }),
    ).toBe(true);
    expect(
      shouldDirectMainAgentReview({
        changedFileCount: 7,
        totalPromptBytes: 500_000,
        diffSubagentThreshold: 8,
        maxMainAgentPromptBytes: 96 * 1024,
      }),
    ).toBe(false);
    expect(
      shouldDirectMainAgentReview({
        changedFileCount: 8,
        totalPromptBytes: 50_000,
        diffSubagentThreshold: 8,
        maxMainAgentPromptBytes: 96 * 1024,
      }),
    ).toBe(false);
    expect(
      shouldDirectMainAgentReview({
        changedFileCount: 9,
        totalPromptBytes: 500_000,
        diffSubagentThreshold: 8,
        maxMainAgentPromptBytes: 96 * 1024,
      }),
    ).toBe(false);
  });

  it('treats includeFullFileContext as lazy evidence permission', async () => {
    const bundle = await buildRepoReviewEvidenceBundle({
      repository: makeBundle().repository,
      profile: {
        ...makeBundle().profile,
        includeFullFileContext: true,
        diffSubagentThreshold: 2,
      },
      event: makeBundle().event,
      prepared: {
        ...makeBundle().prepared,
        diffText: [
          'diff --git a/src/a.ts b/src/a.ts',
          '--- a/src/a.ts',
          '+++ b/src/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
        ].join('\n'),
        changedFiles: ['src/a.ts'],
      },
      workspacePath: '/tmp/repo-review-missing-workspace',
    });

    expect(bundle.files[0]?.fileContent).toBe('');
    expect(bundle.files[0]?.fileContentReason).toContain(
      'lazy full file context',
    );
    expect(bundle.directMainAgentReview).toBe(true);
  });

  it('keeps a single-file oversized diff on the worker path', async () => {
    const bundle = await buildRepoReviewEvidenceBundle({
      repository: makeBundle().repository,
      profile: {
        ...makeBundle().profile,
        includeFullFileContext: false,
        diffSubagentThreshold: 2,
      },
      event: makeBundle().event,
      prepared: {
        ...makeBundle().prepared,
        diffText: [
          'diff --git a/src/huge.ts b/src/huge.ts',
          '--- a/src/huge.ts',
          '+++ b/src/huge.ts',
          '@@ -1 +1 @@',
          `-${'x'.repeat(140000)}`,
          `+${'y'.repeat(140000)}`,
        ].join('\n'),
        changedFiles: ['src/huge.ts'],
      },
      workspacePath: '/tmp/repo-review-missing-workspace',
    });

    expect(bundle.changedFiles).toEqual(['src/huge.ts']);
    expect(bundle.totalPromptBytes).toBeGreaterThan(96 * 1024);
    expect(bundle.directMainAgentReview).toBe(false);
  });

  it('renders markdown from structured results and falls back when needed', () => {
    expect(
      renderRepoReviewMarkdownFromStructuredResult({
        summary: '需要关注',
        findings: [],
        commitReviews: [],
        suggestions: ['先补测试'],
        markdownBody: '',
      }),
    ).toContain('代码审查报告');

    expect(
      renderRepoReviewMarkdownFromStructuredResult({
        summary: '需要关注',
        findings: [],
        commitReviews: [],
        suggestions: [],
        markdownBody: '## custom body',
      }),
    ).toBe('## custom body');
  });
});
