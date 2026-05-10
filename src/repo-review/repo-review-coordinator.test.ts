import { describe, expect, it } from 'vitest';

import {
  partitionRepoReviewEvidenceChunks,
  renderRepoReviewMarkdownFromStructuredResult,
  type RepoReviewEvidenceBundle,
} from './repo-review-coordinator.js';

function makeBundle(overrides: Partial<RepoReviewEvidenceBundle> = {}): RepoReviewEvidenceBundle {
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
    event: { source: 'local-hook', stage: 'push', repositoryId: 'repo-1', blockingExpected: false },
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
    directReducerOnly: true,
    ...overrides,
  };
}

describe('repo-review coordinator', () => {
  it('partitions evidence into bounded worker chunks', () => {
    const bundle = makeBundle({
      directReducerOnly: false,
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
      changedFiles: Array.from({ length: 10 }, (_, index) => `src/file-${index}.ts`),
      totalPromptBytes: 140000,
      fileContentBytes: 120000,
      diffBytes: 20000,
    });

    const chunks = partitionRepoReviewEvidenceChunks(bundle);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.files.length <= 8)).toBe(true);
    expect(chunks.every((chunk) => chunk.promptBytes > 0)).toBe(true);
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
