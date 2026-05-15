import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelInstanceConfig } from '../config-store.js';

const mockRunAgentProcess = vi.fn();
const mockRequestAgentClose = vi.fn();
const mockSendAgentPrompt = vi.fn();
const mockListFeishuChatMembersByJid = vi.fn();
const mockGetWebChannel = vi.fn(() => null);
const mockGetConfiguredChannelInstances = vi.fn<() => ChannelInstanceConfig[]>(
  () => [],
);

vi.mock('../agent-runner.js', () => ({
  runAgentProcess: (...args: unknown[]) => mockRunAgentProcess(...args),
  requestAgentClose: (...args: unknown[]) => mockRequestAgentClose(...args),
  sendAgentPrompt: (...args: unknown[]) => mockSendAgentPrompt(...args),
}));

vi.mock('../agent/agent-runner.js', () => ({
  runAgentProcess: (...args: unknown[]) => mockRunAgentProcess(...args),
  requestAgentClose: (...args: unknown[]) => mockRequestAgentClose(...args),
  sendAgentPrompt: (...args: unknown[]) => mockSendAgentPrompt(...args),
}));

vi.mock('../channels/feishu.js', () => ({
  listFeishuChatMembersByJid: (...args: unknown[]) =>
    mockListFeishuChatMembersByJid(...args),
  buildFeishuJid: (instanceId: string, chatId: string) =>
    instanceId === 'default'
      ? `feishu:${chatId}`
      : `feishu:${instanceId}:${chatId}`,
}));

vi.mock('../channels/web.js', () => ({
  getWebChannel: () => mockGetWebChannel(),
}));

vi.mock('../config-store.js', async () => {
  const actual =
    await vi.importActual<typeof import('../config-store.js')>(
      '../config-store.js',
    );
  return {
    ...actual,
    getAssistantName: () => 'NanoClaw',
    getConfiguredChannelInstances: () => mockGetConfiguredChannelInstances(),
  };
});

function runGit(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function normalizeGitLocalPath(absPath: string): string {
  return absPath.replace(/\\/g, '/');
}

async function waitForCondition(
  assertion: () => void | Promise<void>,
  timeoutMs = 8000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('waitForCondition timed out');
}

function buildAgenticPlanMockResult(
  tasks: Array<{
    id?: string;
    title?: string;
    objective?: string;
    files: string[];
    focus?: string;
    fullFileFiles?: string[];
  }>,
  options: {
    shouldDelegate?: boolean;
    delegationReason?: string;
    fullFileReviewFiles?: string[];
    notes?: string[];
  } = {},
) {
  return {
    status: 'success' as const,
    result: JSON.stringify({
      review_plan: {
        should_delegate: options.shouldDelegate ?? tasks.length > 0,
        delegation_reason:
          options.delegationReason ||
          (tasks.length > 0 ? '按文件委派局部审查。' : '主代理独立完成审查。'),
        tasks: tasks.map((task, index) => ({
          id: task.id || `task-${index + 1}`,
          title: task.title || `审查 ${task.files.join(', ')}`,
          objective: task.objective || `审查 ${task.files.join(', ')}`,
          files: task.files,
          focus: task.focus || '变更风险',
          full_file_files: task.fullFileFiles || [],
        })),
        full_file_review_files: options.fullFileReviewFiles || [],
        risk_areas: [],
        notes: options.notes || [],
      },
    }),
  };
}

function buildAgenticSubagentMockResult(input: {
  files: string[];
  findings?: Array<Record<string, unknown>>;
  fileReviews?: Array<Record<string, unknown>>;
  suggestions?: string[];
  summary?: string;
}) {
  return {
    status: 'success' as const,
    result: JSON.stringify({
      checked_files: input.files,
      read_evidence: input.files.map((file) => ({
        file,
        evidence: input.summary || `${file} 已完成局部审查。`,
      })),
      findings: input.findings || [],
      file_reviews: input.fileReviews || [],
      suggestions: input.suggestions || [],
      scope_limitations: [],
      confidence: 'high',
    }),
  };
}

function buildAgenticSubagentMarkdownResult(input: {
  files: string[];
  summary?: string;
  findingsMarkdown?: string[];
  remainingChecks?: string[];
  confidence?: 'high' | 'medium' | 'low';
}) {
  return {
    status: 'success' as const,
    result: [
      '## 任务范围',
      input.files.map((file) => `- ${file}`).join('\n'),
      '',
      '## 已检查内容',
      input.files.map((file) => `- ${file}`).join('\n'),
      '',
      '## 确认问题',
      ...(input.findingsMarkdown && input.findingsMarkdown.length > 0
        ? input.findingsMarkdown
        : ['未发现明确问题。']),
      '',
      '## 需要主代理继续确认',
      ...(input.remainingChecks && input.remainingChecks.length > 0
        ? input.remainingChecks.map((line) => `- ${line}`)
        : ['- 无']),
      '',
      '## 结论',
      input.summary || '局部审查已完成。',
      `置信度：${input.confidence || 'high'}`,
    ].join('\n'),
  };
}

function buildAgenticReportMarkdown(summary: string): string {
  return [
    '代码审查报告',
    '',
    '一、审查总结',
    `分支结论：${summary}`,
    '',
    '二、高风险问题',
    '未发现高风险问题。',
    '',
    '三、中风险问题',
    '未发现中风险问题。',
    '',
    '四、低风险问题',
    '未发现低风险问题。',
    '',
    '五、代码亮点',
    '未发现需要特别说明的代码亮点。',
    '',
    '六、总结',
    '风险统计：高 0 / 中 0 / 低 0',
  ].join('\n');
}

function buildAgenticExtractorMockResult(input: {
  overall?: string;
  summary: string;
  findings?: Array<Record<string, unknown>>;
  fileReviews?: Array<Record<string, unknown>>;
  suggestions?: string[];
  markdown?: string;
}) {
  return {
    status: 'success' as const,
    result: JSON.stringify({
      overall: input.overall || 'pass',
      summary: input.summary,
      findings: input.findings || [],
      file_reviews: input.fileReviews || [],
      scope_limitations: [],
      commit_reviews: [],
      suggestions: input.suggestions || [],
      recommended_block: false,
      raw_report_markdown:
        input.markdown || buildAgenticReportMarkdown(input.summary),
    }),
  };
}

function buildMockReviewProcessWithSubagentResult(result: Record<string, unknown>) {
  return async (
    _group: unknown,
    _input: unknown,
    onProcess: (proc: unknown, agentLabel: string) => void,
    onOutput: (output: Record<string, unknown>) => Promise<void>,
  ) => {
    onProcess(
      {
        stdin: {
          destroyed: false,
          writableEnded: false,
          end() {
            this.writableEnded = true;
          },
        },
      },
      'review-agent',
    );
    await onOutput({
      status: 'success',
      result: null,
      turnEvent: {
        type: 'turn.started',
        turnId: 'turn-full-file-orchestrator',
        timestamp: '2026-03-27T00:00:00.000Z',
      },
    });
    await onOutput({
      status: 'success',
      result: null,
      turnEvent: {
        type: 'item.completed',
        turnId: 'turn-full-file-orchestrator',
        timestamp: '2026-03-27T00:00:01.000Z',
        item: {
          id: 'tool-agent-1',
          type: 'tool_call',
          status: 'completed',
          title: 'Agent',
          argumentsText: '{"agent_type":"explorer"}',
          resultText: JSON.stringify(result),
          subagentInfo: {
            agentName: 'full-file-reviewer',
            provider: 'codex',
            mode: 'agent',
            workProfile: 'explorer',
            status: 'completed',
          },
          timestamp: '2026-03-27T00:00:01.000Z',
        },
      },
    });
    return {
      status: 'success' as const,
      result: JSON.stringify(result),
    };
  };
}

describe('repo-review-service', () => {
  const originalCwd = process.cwd();
  let tempRepo = '';

  beforeEach(async () => {
    vi.resetModules();
    mockRunAgentProcess.mockReset();
    mockRequestAgentClose.mockReset();
    mockSendAgentPrompt.mockReset();
    mockListFeishuChatMembersByJid.mockReset();
    mockListFeishuChatMembersByJid.mockResolvedValue([]);
    mockGetWebChannel.mockReset();
    mockGetWebChannel.mockReturnValue(null);
    mockGetConfiguredChannelInstances.mockReset();
    mockGetConfiguredChannelInstances.mockReturnValue([]);
    const db = await import('../db.js');
    db._initTestDatabase();

    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-review-repo-'));
    runGit(tempRepo, ['init']);
    runGit(tempRepo, ['branch', '-m', 'main']);
    runGit(tempRepo, ['config', 'user.name', 'alice']);
    runGit(tempRepo, ['config', 'user.email', 'alice@example.com']);
    fs.writeFileSync(path.join(tempRepo, 'demo.ts'), 'const a = 1;\n', 'utf8');
    runGit(tempRepo, ['add', 'demo.ts']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.NANOCLAW_REVIEW_SUBAGENT_TIMEOUT_MS;
    delete process.env.NANOCLAW_REVIEW_SUBAGENT_TIMEOUT_GRACE_MS;
    process.chdir(originalCwd);
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  it('parses github push webhook payloads', async () => {
    const service = await import('./repo-review-service.js');
    const event = service.parseRepoReviewWebhookEvent({
      provider: 'github',
      repositoryId: 'repo-1',
      headers: {
        'x-github-event': 'push',
      },
      payload: {
        ref: 'refs/heads/main',
        before: '111',
        after: '222',
        sender: { login: 'alice' },
        commits: [
          {
            id: '2222222222222222',
            message: 'feat: add remote branch review\n\nmore detail',
            url: 'https://example.com/commit/222',
            timestamp: '2026-03-12T10:00:00Z',
            author: { username: 'alice', name: 'Alice' },
          },
        ],
      },
    });

    expect(event).toMatchObject({
      source: 'github',
      stage: 'push',
      repositoryId: 'repo-1',
      branch: 'main',
      baseSha: '111',
      headSha: '222',
      actor: 'alice',
    });
    expect(
      (event?.callbackContext as { commitDetails?: Array<{ commit: string }> })
        ?.commitDetails?.[0]?.commit,
    ).toBe('222222222222');
  });

  it('parses gitlab push webhook payloads from object_kind when event header is missing', async () => {
    const service = await import('./repo-review-service.js');
    const event = service.parseRepoReviewWebhookEvent({
      provider: 'gitlab',
      repositoryId: 'repo-1',
      headers: {},
      payload: {
        object_kind: 'push',
        ref: 'refs/heads/main',
        before: '111',
        after: '222',
        user_username: 'alice',
        commits: [
          {
            id: '2222222222222222',
            title: 'feat: add remote branch review',
            message: 'feat: add remote branch review',
            url: 'https://gitlab.example.com/commit/222',
            timestamp: '2026-03-12T10:00:00Z',
            author: { name: 'Alice' },
          },
        ],
      },
    });

    expect(event).toMatchObject({
      source: 'gitlab',
      stage: 'push',
      repositoryId: 'repo-1',
      branch: 'main',
      baseSha: '111',
      headSha: '222',
      actor: 'alice',
    });
    expect(
      (event?.callbackContext as { commitDetails?: Array<{ commit: string }> })
        ?.commitDetails?.[0]?.commit,
    ).toBe('222222222222');
  });

  it('persists auto sync repository settings and computes next sync time', async () => {
    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-auto-sync',
      name: 'Repo Auto Sync',
      local_repo_path: tempRepo,
      remote_provider: 'github',
      remote_repo_slug: 'owner/repo',
      clone_url: 'https://github.com/owner/repo.git',
      platformToken: 'github_pat_test',
      actorMentionMappings: [
        {
          actor: 'alice',
          channel: 'feishu',
          id: 'ou_alice',
          name: 'Alice',
        },
      ],
      autoSyncEnabled: true,
      autoSyncIntervalMinutes: 15,
      enabled: true,
    });

    expect(repository.autoSyncEnabled).toBe(true);
    expect(repository.autoSyncIntervalMinutes).toBe(15);
    expect(repository.nextAutoSyncAt).toBeTruthy();
    expect(repository.actorMentionMappings).toEqual([
      {
        actor: 'alice',
        channel: 'feishu',
        id: 'ou_alice',
        name: 'Alice',
      },
    ]);

    const disabled = await service.upsertRepoReviewRepository({
      id: 'repo-auto-sync',
      name: 'Repo Auto Sync',
      autoSyncEnabled: false,
      enabled: true,
    });

    expect(disabled.autoSyncEnabled).toBe(false);
    expect(disabled.nextAutoSyncAt).toBe('');
  });

  it('auto-detects gitlab repository settings from local git remote', async () => {
    runGit(tempRepo, [
      'remote',
      'add',
      'company',
      'git@gitlab.example.com:zhangsan/minirpc.git',
    ]);
    const service = await import('./repo-review-service.js');

    const detection = service.inspectRepoReviewRepositoryCandidate({
      localRepoPath: tempRepo,
      remoteProvider: 'gitlab',
    });

    expect(detection).toMatchObject({
      provider: 'gitlab',
      remoteRepoSlug: 'zhangsan/minirpc',
      remoteBaseUrl: 'https://gitlab.example.com',
      cloneUrl: 'git@gitlab.example.com:zhangsan/minirpc.git',
      defaultTargetBranch: 'main',
      source: 'local_repo',
      detectedRemoteName: 'company',
    });
    expect(detection.warnings).toContain(
      '当前是从 SSH 远端推断出的站点地址，Base URL 默认按 `https://主机名` 生成；如果你的 GitLab / Gitea 只开放了 HTTP 或有额外前缀，请手动修正。',
    );
  });

  it(
    'returns all local remotes and supports selecting a specific remote',
    async () => {
    runGit(tempRepo, [
      'remote',
      'add',
      'origin',
      'https://github.com/ady/minirpc.git',
    ]);
    runGit(tempRepo, [
      'remote',
      'add',
      'company',
      'git@gitlab.example.com:zhangsan/minirpc.git',
    ]);
    const service = await import('./repo-review-service.js');

    const detected = service.inspectRepoReviewRepositoryCandidate({
      localRepoPath: tempRepo,
    });
    expect(detected.detectedRemoteName).toBe('origin');
    expect(
      detected.availableRemotes.map((entry) => entry.remoteName).sort(),
    ).toEqual(['company', 'origin']);
    expect(detected.warnings).toContain(
      '检测到多个 git remote，当前先使用 `origin`。如果不是你要接入的平台，请在界面里切换为其他 remote 后重新导入。',
    );

    const selected = service.inspectRepoReviewRepositoryCandidate({
      localRepoPath: tempRepo,
      remoteName: 'company',
    });
    expect(selected.detectedRemoteName).toBe('company');
    expect(selected.provider).toBe('gitlab');
    expect(selected.remoteRepoSlug).toBe('zhangsan/minirpc');
    },
    15000,
  );

  it('auto-creates default profiles when saving a repository without profiles', async () => {
    runGit(tempRepo, [
      'remote',
      'add',
      'company',
      'git@gitlab.example.com:zhangsan/minirpc.git',
    ]);
    const service = await import('./repo-review-service.js');

    const result = await service.saveRepoReviewRepositoryConfig({
      id: 'repo-default-profiles',
      name: 'Repo Default Profiles',
      localRepoPath: tempRepo,
      remoteProvider: 'gitlab',
      platformToken: 'glpat-test',
      webhookSecret: 'hook-token',
      autoSyncEnabled: false,
      enabled: true,
    });

    expect(result.autoCreatedProfiles).toHaveLength(1);
    expect(result.autoCreatedProfiles.map((profile) => profile.name)).toEqual([
      'Push Remote Default',
    ]);

    const profiles = await service.listRepoReviewProfiles('repo-default-profiles');
    expect(profiles).toHaveLength(1);
    expect(result.repository.remoteRepoSlug).toBe('zhangsan/minirpc');
    expect(result.repository.cloneUrl).toBe(
      'git@gitlab.example.com:zhangsan/minirpc.git',
    );
  }, 15000);

  it('normalizes gitlab project page urls filled into remote base url', async () => {
    const service = await import('./repo-review-service.js');

    const result = await service.saveRepoReviewRepositoryConfig({
      id: 'repo-invalid-base-url',
      name: 'Repo Invalid Base URL',
      localRepoPath: tempRepo,
      remoteProvider: 'gitlab',
      remoteRepoSlug: 'zhangsan/minirpc',
      remoteBaseUrl: 'http://gitlab.example.com/zhangsan/minirpc',
      cloneUrl: 'git@gitlab.example.com:zhangsan/minirpc.git',
      platformToken: 'glpat-test',
      enabled: true,
    });

    expect(result.repository.remoteBaseUrl).toBe('http://gitlab.example.com');
    expect(result.repository.remoteRepoSlug).toBe('zhangsan/minirpc');
    expect(result.warnings).toContain(
      '检测到你填写的远端 Base URL 更像仓库页面链接，系统已自动提取为站点根地址和仓库 slug。',
    );
  });

  it('normalizes raw feishu chat ids when saving a review repository binding', async () => {
    mockGetConfiguredChannelInstances.mockReturnValue([
      {
        id: 'default',
        type: 'feishu',
        name: 'Default Feishu',
        enabled: true,
        config: {},
      },
    ]);
    const service = await import('./repo-review-service.js');

    const result = await service.saveRepoReviewRepositoryConfig({
      id: 'repo-feishu-chat-id',
      name: 'Repo Feishu Chat',
      localRepoPath: tempRepo,
      reviewChatJid: 'oc_test_chat_123',
      enabled: true,
    });

    expect(result.repository.reviewChatJid).toBe('feishu:oc_test_chat_123');
    await expect(
      service.getRepoReviewConversationBinding('feishu:oc_test_chat_123'),
    ).resolves.toMatchObject({
      repositoryId: 'repo-feishu-chat-id',
    });
  });

  it('recomputes and clears digest next-run timestamps when digest schedule changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T08:15:00.000Z'));
    const service = await import('./repo-review-service.js');
    const { getReviewRepositoryById } = await import('../db.js');
    try {
      await service.saveRepoReviewRepositoryConfig({
        id: 'repo-digest-schedule',
        name: 'Repo Digest Schedule',
        localRepoPath: tempRepo,
        digestDailyEnabled: true,
        digestDailyHour: 18,
        digestWeeklyEnabled: true,
        digestWeeklyDay: 5,
        digestWeeklyHour: 20,
        enabled: true,
      });

      const initial = await getReviewRepositoryById('repo-digest-schedule');
      expect(initial?.next_digest_daily_at).toBeTruthy();
      expect(initial?.next_digest_weekly_at).toBeTruthy();

      await service.saveRepoReviewRepositoryConfig({
        id: 'repo-digest-schedule',
        name: 'Repo Digest Schedule',
        digestDailyEnabled: true,
        digestDailyHour: 9,
        digestWeeklyEnabled: false,
        enabled: true,
      });

      const updated = await getReviewRepositoryById('repo-digest-schedule');
      expect(updated?.next_digest_daily_at).not.toBe(initial?.next_digest_daily_at);
      expect(updated?.next_digest_weekly_at).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects ambiguous raw feishu chat ids when multiple instances are enabled', async () => {
    mockGetConfiguredChannelInstances.mockReturnValue([
      {
        id: 'team-a',
        type: 'feishu',
        name: 'Team A',
        enabled: true,
        config: {},
      },
      {
        id: 'team-b',
        type: 'feishu',
        name: 'Team B',
        enabled: true,
        config: {},
      },
    ]);
    const service = await import('./repo-review-service.js');

    await expect(
      service.saveRepoReviewRepositoryConfig({
        id: 'repo-feishu-ambiguous',
        name: 'Repo Feishu Ambiguous',
        localRepoPath: tempRepo,
        reviewChatJid: 'oc_test_chat_456',
        enabled: true,
      }),
    ).rejects.toThrow('当前启用了多个飞书实例');
  });

  it(
    'supports preserving and clearing stored sensitive values explicitly',
    async () => {
    const service = await import('./repo-review-service.js');

    const created = await service.saveRepoReviewRepositoryConfig({
      id: 'repo-sensitive-values',
      name: 'Repo Sensitive Values',
      localRepoPath: tempRepo,
      remoteProvider: 'gitlab',
      remoteRepoSlug: 'zhangsan/minirpc',
      cloneUrl: 'git@gitlab.example.com:zhangsan/minirpc.git',
      platformToken: 'glpat-test',
      webhookSecret: 'hook-secret',
      enabled: true,
    });
    expect(created.repository.hasPlatformToken).toBe(true);
    expect(created.repository.hasWebhookSecret).toBe(true);

    const preserved = await service.saveRepoReviewRepositoryConfig({
      id: 'repo-sensitive-values',
      name: 'Repo Sensitive Values',
      webhookSecretMode: 'preserve',
      platformTokenMode: 'preserve',
      enabled: true,
    });
    expect(preserved.repository.hasPlatformToken).toBe(true);
    expect(preserved.repository.hasWebhookSecret).toBe(true);

    const cleared = await service.saveRepoReviewRepositoryConfig({
      id: 'repo-sensitive-values',
      name: 'Repo Sensitive Values',
      webhookSecretMode: 'clear',
      platformTokenMode: 'clear',
      enabled: true,
    });
    expect(cleared.repository.hasPlatformToken).toBe(false);
    expect(cleared.repository.hasWebhookSecret).toBe(false);
  },
    15000,
  );

  it('requires github api token when remote auto sync is enabled', async () => {
    const service = await import('./repo-review-service.js');

    await expect(
      service.saveRepoReviewRepositoryConfig({
        id: 'repo-github-token-required',
        name: 'Repo GitHub Token Required',
        localRepoPath: tempRepo,
        remoteProvider: 'github',
        remoteRepoSlug: 'owner/repo',
        cloneUrl: 'https://github.com/owner/repo.git',
        autoSyncEnabled: true,
        enabled: true,
      }),
    ).rejects.toThrow(
      'GitHub 已启用远端轮询，但还没有配置平台 Token。这里需要的是可访问 GitHub API 的 Personal Access Token 或 App Token，不是 Webhook Secret。',
    );
  });

  it('requires gitea api token when remote auto sync is enabled', async () => {
    const service = await import('./repo-review-service.js');

    await expect(
      service.saveRepoReviewRepositoryConfig({
        id: 'repo-gitea-token-required',
        name: 'Repo Gitea Token Required',
        localRepoPath: tempRepo,
        remoteProvider: 'gitea',
        remoteRepoSlug: 'team/repo',
        cloneUrl: 'https://gitea.example.com/team/repo.git',
        autoSyncEnabled: true,
        enabled: true,
      }),
    ).rejects.toThrow(
      'Gitea 已启用远端轮询，但还没有配置平台 Access Token。这里需要的是可访问 Gitea API 的令牌，不是 Webhook Secret。',
    );
  });

  it('lists repo review chat members from feishu API and cached messages', async () => {
    mockListFeishuChatMembersByJid.mockResolvedValue([
      {
        id: 'ou_alice',
        name: 'Alice',
        chatJid: 'feishu:test-chat',
        source: 'feishu_api',
      },
    ]);

    const db = await import('../db.js');
    await db.storeChatMetadata(
      'feishu:test-chat',
      '2026-03-13T00:00:00.000Z',
      'Feishu Test Chat',
      'feishu',
      true,
    );
    await db.storeMessageDirect({
      id: 'msg_bob',
      chat_jid: 'feishu:test-chat',
      sender: 'ou_bob',
      sender_name: 'Bob',
      content: 'hello',
      timestamp: '2026-03-13T00:00:00.000Z',
      is_from_me: false,
    });

    const service = await import('./repo-review-service.js');
    const members = await service.listRepoReviewChatMembers('feishu:test-chat');

    expect(members).toEqual([
      {
        id: 'ou_alice',
        name: 'Alice',
        chatJid: 'feishu:test-chat',
        source: 'feishu_api',
      },
      {
        id: 'ou_bob',
        name: 'Bob',
        chatJid: 'feishu:test-chat',
        source: 'message',
      },
    ]);
    expect(mockListFeishuChatMembersByJid).toHaveBeenCalledWith(
      'feishu:test-chat',
    );
  });

  it('formats repo review notifications with clear start and completion summaries', async () => {
    const service = await import('./repo-review-service.js');

    const repository = {
      id: 'repo-template',
      name: 'Repo Template',
      language: 'TypeScript',
      localRepoPath: tempRepo,
      remoteProvider: 'github' as const,
      remoteRepoSlug: 'team/repo',
      remoteBaseUrl: '',
      cloneUrl: '',
      defaultTargetBranch: 'main',
      reviewChatJid: 'feishu:test-chat',
      actorMentionMappings: [],
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
    const profile = {
      id: 'profile-template',
      repositoryId: repository.id,
      name: 'Push Deep Review',
      stage: 'push' as const,
      sourceMode: 'remote' as const,
      blockingMode: 'hard_fail' as const,
      passDecisionMode: 'ai' as const,
      reviewScope: 'commit_range' as const,
      targetBranches: [],
      skillIds: [],
      mcpServerIds: [],
      promptTemplate: '',
      includeGlobs: [],
      excludeGlobs: [],
      maxFiles: 80,
      maxDiffBytes: 200000,
      writeToChat: true,
      writeToPlatform: true,
      enabled: true,
    };
    const started = service.formatRepoReviewStartedMessage({
      repository,
      profile,
      event: {
        source: 'github',
        stage: 'push',
        repositoryId: repository.id,
        branch: 'feature/login',
        prMrNumber: '42',
        blockingExpected: false,
      },
      prepared: {
        diffText: 'diff',
        changedFiles: ['src/app.ts', 'src/auth.ts'],
        baseSha: '111111111111',
        headSha: '222222222222',
        branch: 'feature/login',
        ref: 'refs/heads/feature/login',
        actor: 'alice',
        commitSummaryLines: ['abc1234 feat: add login flow · alice'],
        commitDetails: [
          {
            commit: 'abc1234',
            title: 'feat: add login flow',
            author: 'alice',
            message: 'feat: add login flow',
          },
        ],
        projectContextBlocks: [],
      },
    });

    expect(started).toContain('AI 审查开始 · Repo Template');
    expect(started).toContain('对象: PR/MR #42');
    expect(started).toContain('提交数: 1');
    expect(started).toContain('变更文件数: 2');
    expect(started).toContain('审查策略: AI 判定不通过时会阻断当前提交/推送');
    expect(started).toContain('当前动作: AI 正在分析这次改动');
    expect(started).toContain('提交摘要:');
    expect(started).not.toContain('通知对象:');
    expect(started).not.toMatch(/\b(?:auto|pleaseReviewResults|targetLabel|stageSourceLabel|changedFilesHeader)_?/);

    const completed = service.formatRepoReviewCompletedMessage(
      repository,
      {
        id: 'run-template',
        repositoryId: repository.id,
        profileId: profile.id,
        source: 'github',
        stage: 'push',
        status: 'completed',
        idempotencyKey: 'idempotency-template',
        overall: 'fail',
        passDecisionMode: 'ai',
        recommendedBlock: true,
        blockingEnforced: true,
        baselineSource: 'compare',
        resultState: 'failed',
        ref: 'refs/heads/feature/login',
        branch: 'feature/login',
        baseSha: '111111111111',
        headSha: '222222222222',
        prMrNumber: '42',
        actor: 'alice',
        summary: '登录流程缺少边界校验',
        findings: [
          {
            severity: 'high',
            file: 'src/auth.ts',
            title: '缺少边界检查',
            detail: '空 token 情况未处理',
          },
        ],
        scopeLimitations: [],
        reviewTurns: [],
        commitDetails: [
          {
            commit: 'abc1234',
            title: 'feat: add login flow',
            author: 'alice',
            message: 'feat: add login flow',
          },
        ],
        commitReviews: [
          {
            commit: 'abc1234',
            title: 'feat: add login flow',
            author: 'alice',
            positives: ['意图明确'],
            issues: ['缺少空 token 校验'],
          },
        ],
        suggestions: ['补充 token 判空和测试用例'],
        changedFiles: ['src/app.ts', 'src/auth.ts'],
        diffBytes: 120,
        durationMs: 60000,
        platformStatus: '',
        chatDeliveryStatus: 'delivered',
        platformStatusDeliveryStatus: 'delivered',
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
        startedAt: '2026-03-13T00:00:00.000Z',
        completedAt: '2026-03-13T00:01:00.000Z',
        createdAt: '2026-03-13T00:00:00.000Z',
        updatedAt: '2026-03-13T00:01:00.000Z',
      },
      'ai',
    );

    expect(completed).toContain('AI 审查完成 · Repo Template');
    expect(completed).toContain('AI 结论: 不通过');
    expect(completed).toContain(
      '需处理: 是，当前已阻断，请修复后重新提交或推送',
    );
    expect(completed).toContain('对象: PR/MR #42');
    expect(completed).toContain('提交数: 1');
    expect(completed).toContain('分支结论:');
    expect(completed).toContain('主要问题:');
    expect(completed).toContain('提交点评:');
    expect(completed).toContain('下一步建议:');
    expect(completed).not.toMatch(/\b(?:auto|pleaseReviewResults|aiReviewCompletedBold|conclusionRiskBold)_?/);
  });

  it('uses isolated runtime namespaces for executor-owned full-file subagents', async () => {
    mockRunAgentProcess
      .mockResolvedValueOnce(
        buildAgenticPlanMockResult([
          { id: 'task-1', title: '审查 split-a', files: ['split-a.ts'], fullFileFiles: ['split-a.ts'] },
          { id: 'task-2', title: '审查 split-b', files: ['split-b.ts'], fullFileFiles: ['split-b.ts'] },
        ]),
      )
      .mockResolvedValueOnce(
        buildAgenticSubagentMockResult({ files: ['split-a.ts'], summary: 'split-a.ts 全文审查通过。' }),
      )
      .mockResolvedValueOnce(
        buildAgenticSubagentMockResult({ files: ['split-b.ts'], summary: 'split-b.ts 全文审查通过。' }),
      )
      .mockResolvedValueOnce({
        status: 'success',
        result: buildAgenticReportMarkdown('主审查通过，进入全文补充。'),
      })
      .mockResolvedValueOnce(
        buildAgenticExtractorMockResult({
          summary: '主审查通过，进入全文补充。',
          markdown: buildAgenticReportMarkdown('主审查通过，进入全文补充。'),
        }),
      );

    runGit(tempRepo, ['commit', '-m', 'base']);
    fs.writeFileSync(path.join(tempRepo, 'split-a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tempRepo, 'split-b.ts'), 'export const b = 1;\n');
    runGit(tempRepo, ['add', 'split-a.ts', 'split-b.ts']);

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-split-runtime',
      name: 'Repo Split Runtime',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-split-runtime',
      repository_id: repository.id,
      name: 'Split Runtime Review',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      include_full_file_context: true,
      diff_subagent_threshold: 1,
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    expect(result.runs[0]?.run.status).toBe('completed');
    expect(mockRunAgentProcess).toHaveBeenCalledTimes(4);
    const namespaces = mockRunAgentProcess.mock.calls.map(
      (call) => String(call[1]?.runtimeNamespace || ''),
    );
    expect(namespaces).toContain(`${result.runs[0]!.run.id}:main-plan:1`);
    expect(namespaces).toEqual(
      expect.arrayContaining([
        `${result.runs[0]!.run.id}:subagent:1`,
        `${result.runs[0]!.run.id}:subagent:2`,
        `${result.runs[0]!.run.id}:main-final`,
      ]),
    );
    expect(new Set(namespaces).size).toBe(namespaces.length);
    const progressRun = await service.getRepoReviewRun(result.runs[0]!.run.id);
    const progressSteps = progressRun?.reviewProgress?.steps || [];
    expect(
      progressSteps.some(
        (step) =>
          step.id.startsWith('agentic_subagent_') &&
          step.label.startsWith('子代理') &&
          step.status === 'completed',
      ),
    ).toBe(true);
    expect(progressSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agentic_main_plan',
          label: '主代理制定审查计划',
          status: 'completed',
        }),
        expect.objectContaining({
          id: 'agentic_subagents',
          label: '执行子代理局部审查',
          status: 'completed',
        }),
        expect.objectContaining({
          id: 'agentic_main_summary',
          label: '主代理汇总结论',
          status: 'completed',
        }),
        expect.objectContaining({
          id: 'agentic_structured_extract',
          label: '格式化整理',
          status: 'skipped',
        }),
      ]),
    );
    expect(progressRun?.executionStats).toMatchObject({
      plannedSubagentCount: 2,
      delegatedSubagentCount: 2,
      modelCallCount: 4,
    });
  });

  it('surfaces provider wait status inside repo review progress steps', async () => {
    mockRunAgentProcess
      .mockImplementationOnce(async (_group, _input, onProcess, onOutput) => {
        onProcess?.(
          {
            stdin: {
              destroyed: false,
              writableEnded: false,
              end() {
                this.writableEnded = true;
              },
            },
          },
          'review-agent',
        );
        await onOutput?.({
          status: 'success',
          result: null,
          event: {
            id: 'provider-wait-plan',
            kind: 'status',
            status: 'in_progress',
            title: 'Waiting for Codex provider availability',
            body: 'Codex plan request',
            timestamp: '2026-04-23T00:00:00.000Z',
          },
        });
        return buildAgenticPlanMockResult([], {
          shouldDelegate: false,
          delegationReason: '主代理独立完成审查。',
        });
      })
      .mockResolvedValueOnce({
        status: 'success',
        result: buildAgenticReportMarkdown('主代理独立完成审查。'),
      })
      .mockResolvedValueOnce(
        buildAgenticExtractorMockResult({
          summary: '主代理独立完成审查。',
          markdown: buildAgenticReportMarkdown('主代理独立完成审查。'),
        }),
      );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-provider-progress',
      name: 'Repo Provider Progress',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-provider-progress',
      repository_id: repository.id,
      name: 'Provider Progress Review',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      include_full_file_context: false,
      diff_subagent_threshold: 0,
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    expect(result.runs[0]?.run.status).toBe('completed');
    const progressRun = await service.getRepoReviewRun(result.runs[0]!.run.id);
    const planStep = progressRun?.reviewProgress?.steps?.find(
      (step) => step.id === 'agentic_main_plan',
    );
    expect(planStep).toBeTruthy();
    expect(planStep?.metadataText).toContain(
      'event_title: Waiting for Codex provider availability',
    );
    expect(planStep?.metadataText).toContain('event_body: Codex plan request');
  });

  it('lets the main agent consume markdown subagent reports directly', async () => {
    mockRunAgentProcess
      .mockResolvedValueOnce(
        buildAgenticPlanMockResult([
          {
            id: 'task-1',
            title: '审查 split-a',
            files: ['split-a.ts'],
            fullFileFiles: [],
          },
        ]),
      )
      .mockResolvedValueOnce(
        buildAgenticSubagentMarkdownResult({
          files: ['split-a.ts'],
          summary: '发现一个中风险问题，需要主代理汇总。',
          findingsMarkdown: [
            '🟡 缓存字段兼容性遗漏',
            '文件：split-a.ts',
            '缓存命中路径没有补齐新增字段，可能造成旧对象返回。',
            '修复建议：主代理汇总时要求补齐字段。',
          ],
          remainingChecks: ['需要主代理确认跨文件调用方是否依赖旧字段。'],
          confidence: 'medium',
        }),
      )
      .mockResolvedValueOnce({
        status: 'success',
        result: buildAgenticReportMarkdown('主代理已汇总 Markdown 子代理结论。'),
      })
      .mockResolvedValueOnce(
        buildAgenticExtractorMockResult({
          summary: '主代理已汇总 Markdown 子代理结论。',
          markdown: buildAgenticReportMarkdown('主代理已汇总 Markdown 子代理结论。'),
        }),
      );

    runGit(tempRepo, ['commit', '-m', 'base']);
    fs.writeFileSync(path.join(tempRepo, 'split-a.ts'), 'export const a = 1;\n');
    runGit(tempRepo, ['add', 'split-a.ts']);

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-markdown-subagent',
      name: 'Repo Markdown Subagent',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-markdown-subagent',
      repository_id: repository.id,
      name: 'Markdown Subagent Review',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      include_full_file_context: false,
      diff_subagent_threshold: 0,
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    expect(result.runs[0]?.run.status).toBe('completed');
    const finalPrompt = String(
      mockRunAgentProcess.mock.calls[2]?.[1]?.prompt?.text || '',
    );
    expect(finalPrompt).toContain('子代理证据摘要');
    expect(finalPrompt).toContain('remaining_checks');
    expect(finalPrompt).toContain('需要主代理确认跨文件调用方是否依赖旧字段');
  });

  it('records out-of-scope file reads from subagent turns', async () => {
    mockRunAgentProcess
      .mockResolvedValueOnce(
        buildAgenticPlanMockResult([
          {
            id: 'task-1',
            title: '审查 a.ts',
            files: ['a.ts'],
            fullFileFiles: [],
          },
        ]),
      )
      .mockImplementationOnce(
        async (
          _group,
          _input,
          onProcess: (proc: unknown, agentLabel: string) => void,
          onOutput: (output: Record<string, unknown>) => Promise<void>,
        ) => {
          onProcess(
            {
              stdin: {
                destroyed: false,
                writableEnded: false,
                end() {
                  this.writableEnded = true;
                },
              },
              killed: false,
              kill() {
                this.killed = true;
                return true;
              },
            },
            'review-agent',
          );
          await onOutput({
            status: 'success',
            result: null,
            turnEvent: {
              type: 'turn.started',
              turnId: 'turn-agentic-subagent',
              timestamp: '2026-04-23T00:00:00.000Z',
            },
          });
          await onOutput({
            status: 'success',
            result: null,
            turnEvent: {
              type: 'item.completed',
              turnId: 'turn-agentic-subagent',
              timestamp: '2026-04-23T00:00:01.000Z',
              item: {
                id: 'tool-read-file',
                type: 'tool_call',
                status: 'completed',
                title: 'read_file',
                argumentsText: '{"path":"other.ts"}',
                resultText: 'export const other = true;',
                timestamp: '2026-04-23T00:00:01.000Z',
              },
            },
          });
          await onOutput({
            status: 'success',
            result: [
              '## 任务范围',
              '- a.ts',
              '',
              '## 已检查内容',
              '- a.ts',
              '',
              '## 确认问题',
              '未发现明确问题。',
              '',
              '## 需要主代理继续确认',
              '- 需要确认 other.ts 是否应纳入后续范围。',
              '',
              '## 结论',
              '进度总结已完成。',
              '置信度：high',
            ].join('\n'),
          });
          await onOutput({
            status: 'success',
            result: null,
            turnEvent: {
              type: 'turn.completed',
              turnId: 'turn-agentic-subagent',
              timestamp: '2026-04-23T00:00:02.000Z',
            },
          });
          return {
            status: 'success' as const,
            result: null,
          };
        },
      )
      .mockResolvedValueOnce({
        status: 'success',
        result: buildAgenticReportMarkdown('主代理已汇总越权读取审计。'),
      })
      .mockResolvedValueOnce(
        buildAgenticExtractorMockResult({
          summary: '主代理已汇总越权读取审计。',
          markdown: buildAgenticReportMarkdown('主代理已汇总越权读取审计。'),
        }),
      );

    runGit(tempRepo, ['commit', '-m', 'base']);
    fs.writeFileSync(path.join(tempRepo, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tempRepo, 'other.ts'), 'export const other = 1;\n');
    runGit(tempRepo, ['add', 'a.ts', 'other.ts']);

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-subagent-audit',
      name: 'Repo Subagent Audit',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-subagent-audit',
      repository_id: repository.id,
      name: 'Subagent Audit Review',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      include_full_file_context: false,
      diff_subagent_threshold: 0,
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    expect(result.runs[0]?.run.status).toBe('completed');
    const finalPrompt = String(
      mockRunAgentProcess.mock.calls[2]?.[1]?.prompt?.text || '',
    );
    expect(finalPrompt).toContain('越权读取');
  });

  it('asks a timed-out subagent for a progress summary before takeover', async () => {
    process.env.NANOCLAW_REVIEW_SUBAGENT_TIMEOUT_MS = '1000';
    process.env.NANOCLAW_REVIEW_SUBAGENT_TIMEOUT_GRACE_MS = '250';
    vi.resetModules();
    {
      const db = await import('../db.js');
      db._initTestDatabase();
    }

    mockRunAgentProcess
      .mockResolvedValueOnce(
        buildAgenticPlanMockResult([
          {
            id: 'task-1',
            title: '审查 timeout-a',
            files: ['timeout-a.ts'],
            fullFileFiles: [],
          },
        ]),
      )
      .mockImplementationOnce(
        async (_group, _input, onProcess) => {
          onProcess(
            {
              stdin: {
                destroyed: false,
                writableEnded: false,
                end() {
                  this.writableEnded = true;
                },
              },
              killed: false,
              kill() {
                this.killed = true;
                return true;
              },
            },
            'review-agent',
          );
          return await new Promise(() => undefined);
        },
      )
      .mockResolvedValueOnce({
        status: 'success',
        result: buildAgenticReportMarkdown('主代理已接管超时子代理。'),
      })
      .mockResolvedValueOnce(
        buildAgenticExtractorMockResult({
          summary: '主代理已接管超时子代理。',
          markdown: buildAgenticReportMarkdown('主代理已接管超时子代理。'),
        }),
      );

    runGit(tempRepo, ['commit', '-m', 'base']);
    fs.writeFileSync(path.join(tempRepo, 'timeout-a.ts'), 'export const a = 1;\n');
    runGit(tempRepo, ['add', 'timeout-a.ts']);

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-timeout-subagent',
      name: 'Repo Timeout Subagent',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-timeout-subagent',
      repository_id: repository.id,
      name: 'Timeout Subagent Review',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      include_full_file_context: false,
      diff_subagent_threshold: 0,
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    expect(result.runs[0]?.run.status).toBe('completed');
    expect(mockSendAgentPrompt).toHaveBeenCalledTimes(1);
    expect(String(mockSendAgentPrompt.mock.calls[0]?.[2]?.text || '')).toContain(
      '当前进度总结',
    );
  });

  it('separates scope limitations from actionable review findings', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'warn',
        summary: '订单规则修复方向正确，但仍需关注兼容风险。',
        findings: [
          {
            severity: 'medium',
            file: 'src/order.ts',
            title: '历史模式兼容分支缺少回归校验',
            detail: '旧模式降级逻辑缺少样本验证。',
            suggestion: '补充历史模式回归测试。',
          },
          {
            severity: 'low',
            file: 'N/A',
            title: '合并提交缺少可核对的父提交差异上下文',
            detail: '仅基于当前分支总 diff，无法确认冲突取舍。',
          },
        ],
        scope_limitations: [
          '仅基于当前分支总 diff，无法确认 merge commit 的冲突取舍过程。',
        ],
        commit_reviews: [
          {
            commit: 'b8b53484',
            title: "Merge remote-tracking branch 'origin/order_rule' into order_rule",
            author: 'zhangsan',
            positives: ['最终结果未见明显冲突残留。'],
            issues: ['仅基于当前分支总 diff，无法确认冲突取舍。'],
          },
        ],
        suggestions: ['补充历史模式回归测试。'],
        recommended_block: false,
      }),
    });

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-scope-limitations',
      name: 'Repo Scope Limitations',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-scope-limitations',
      repository_id: repository.id,
      name: 'Scope Limitation Push',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    const run = result.runs[0]!.run;
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0]?.title).toContain('历史模式兼容分支缺少回归校验');
    expect(run.scopeLimitations).toEqual([
      '仅基于当前分支总 diff，无法确认 merge commit 的冲突取舍过程。',
    ]);
    expect(run.commitReviews[0]?.issues).toEqual([]);

    const completed = service.formatRepoReviewCompletedMessage(
      repository,
      run,
      'ai',
    );
    expect(completed).toContain('审查边界:');
    expect(completed).not.toContain('N/A: 合并提交缺少可核对的父提交差异上下文');
  });

  it('deduplicates actor mentions and target branches during normalization', async () => {
    const service = await import('./repo-review-service.js');

    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-normalize',
      name: 'Repo Normalize',
      local_repo_path: tempRepo,
      actorMentionMappings: [
        {
          actor: 'Alice',
          channel: 'feishu',
          id: 'ou_alice',
          name: '',
        },
        {
          actor: 'alice',
          channel: 'feishu',
          id: 'ou_alice_new',
          name: 'Alice New',
        },
      ],
      enabled: true,
    });

    const profile = await service.upsertRepoReviewProfile({
      id: 'profile-normalize',
      repository_id: repository.id,
      name: 'Normalize Branches',
      stage: 'push',
      source_mode: 'remote',
      blocking_mode: 'soft_fail',
      review_scope: 'commit_range',
      target_branches: ['main', 'main', 'release'],
      enabled: true,
    });

    expect(repository.actorMentionMappings).toEqual([
      {
        actor: 'alice',
        channel: 'feishu',
        id: 'ou_alice',
        name: 'alice',
      },
    ]);
    expect(profile.targetBranches).toEqual(['main', 'release']);
  });

  it('runs scoped full-file review tasks when enabled', async () => {
    runGit(tempRepo, ['commit', '-m', 'base']);
    fs.writeFileSync(
      path.join(tempRepo, 'demo.ts'),
      [
        'export function authenticate(token?: string) {',
        '  if (!token) {',
        '    return "";',
        '  }',
        '  return token.trim();',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    runGit(tempRepo, ['add', 'demo.ts']);

    const finalMarkdown = [
      '代码审查报告',
      '',
      '一、审查总结',
      '分支结论：认证入口 diff 主线无阻断问题，全文补充阶段继续确认测试覆盖。',
      '',
      '二、高风险问题',
      '未发现高风险问题。',
      '',
      '三、中风险问题',
      '未发现中风险问题。',
      '',
      '四、低风险问题',
      '未发现低风险问题。',
      '',
      '五、代码亮点',
      '主审查正文里的代码片段应被保留。',
      '```ts',
      'return token?.trim() ?? "";',
      '```',
      '',
      '六、总结',
      '风险统计：高 0 / 中 0 / 低 0',
    ].join('\n');
    mockRunAgentProcess
      .mockResolvedValueOnce(
        buildAgenticPlanMockResult([
          {
            id: 'task-1',
            title: '审查 demo.ts',
            objective: '确认 demo.ts 的改动是否安全',
            files: ['demo.ts'],
            focus: '认证入口与测试覆盖',
            fullFileFiles: ['demo.ts'],
          },
        ]),
      )
      .mockResolvedValueOnce(
        buildAgenticSubagentMockResult({
          files: ['demo.ts'],
          summary: '该文件在本次改动中承担认证入口逻辑，缺少空 token 场景的回归断言。',
          findings: [
            {
              severity: 'medium',
              title: '缺少空 token 分支的回归测试',
              detail:
                'authenticate 当前直接返回空串，但没有对应单测锁定这一分支行为，后续重构时容易回归。',
              suggestion: '补一条覆盖空 token 输入的单测，并断言返回值语义。',
            },
          ],
          suggestions: ['补一条覆盖空 token 输入的单测，并断言返回值语义。'],
        }),
      )
      .mockResolvedValueOnce({
        status: 'success',
        result: finalMarkdown,
      })
      .mockResolvedValueOnce(
        buildAgenticExtractorMockResult({
          overall: 'warn',
          summary: '认证入口 diff 主线无阻断问题，全文补充阶段继续确认测试覆盖。',
          findings: [
            {
              severity: 'medium',
              file: 'demo.ts',
              title: '缺少空 token 分支的回归测试',
              detail:
                'authenticate 当前直接返回空串，但没有对应单测锁定这一分支行为，后续重构时容易回归。',
              suggestion: '补一条覆盖空 token 输入的单测，并断言返回值语义。',
            },
          ],
          fileReviews: [
            {
              file: 'demo.ts',
              summary: '认证入口逻辑存在回归风险，建议补单测锁定空 token 分支。',
              risks: ['空 token 分支缺少回归覆盖。'],
              suggestions: ['补一条空 token 输入的单测。'],
            },
          ],
          suggestions: ['补一条覆盖空 token 输入的单测，并断言返回值语义。'],
          markdown: finalMarkdown,
        }),
      );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-two-phase-full-file',
      name: 'Repo Two Phase Full File',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-two-phase-full-file',
      repository_id: repository.id,
      name: 'Two Phase Full File',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      include_full_file_context: true,
      diff_subagent_threshold: 0,
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    expect(mockRunAgentProcess).toHaveBeenCalledTimes(3);
    const firstPrompt = String(
      mockRunAgentProcess.mock.calls[0]?.[1]?.prompt?.text || '',
    );
    const secondPrompt = String(
      mockRunAgentProcess.mock.calls[1]?.[1]?.prompt?.text || '',
    );
    expect(firstPrompt).toContain('## 第一轮输出协议');
    expect(firstPrompt).toContain('review_plan');
    expect(firstPrompt).toContain('至少执行一次 `git -C /workspace/extra diff');
    expect(secondPrompt).toContain('## 输出要求');
    expect(secondPrompt).toContain('确认问题');
    expect(secondPrompt).toContain('demo.ts');
    expect(secondPrompt).toContain('不要创建、派发或调用子代理');

    const run = result.runs[0]!.run;
    expect(run.overall).toBe('pass');
    expect(run.summary).toContain('认证入口 diff 主线无阻断问题');
    const supplementalToolItems = run.reviewTurns.flatMap((turn) =>
      turn.items.filter(
        (item) => item.type === 'tool_call' && item.title === 'Agent',
      ),
    );
    expect(supplementalToolItems).toEqual([
      expect.objectContaining({
        type: 'tool_call',
        status: 'completed',
        title: 'Agent',
        argumentsText: expect.stringContaining('文件：demo.ts'),
        resultText: expect.stringContaining('缺少空 token 分支的回归测试'),
      }),
    ]);
    expect(run.fileReviews).toEqual([]);
    expect(run.findings).toEqual([]);
    expect(run.markdownBody).toContain('主审查正文里的代码片段应被保留');
    expect(run.markdownBody).toContain('```ts');
    expect(run.markdownBody).toContain('return token?.trim() ?? ""');
    expect(run.suggestions).toEqual([]);
    expect(run.executionStats).toMatchObject({
      diffFiles: 1,
      extraRepoReadCount: 0,
      plannedSubagentCount: 1,
      delegatedSubagentCount: 1,
      modelCallCount: 3,
    });
    expect(run.executionStats?.fullFileBytesLoaded).toBe(0);
    expect(run.executionStats?.promptBytesBuilt).toBeGreaterThan(0);
  });

  it('uses direct main-agent review below the delegation threshold and still shows tool calls', async () => {
    runGit(tempRepo, ['commit', '-m', 'base']);
    fs.writeFileSync(
      path.join(tempRepo, 'small.ts'),
      'export const smallChange = true;\n',
      'utf8',
    );
    runGit(tempRepo, ['add', 'small.ts']);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    mockRunAgentProcess.mockImplementationOnce(
      async (
        _group,
        _input,
        onProcess: (proc: unknown, agentLabel: string) => void,
        onOutput: (output: Record<string, unknown>) => Promise<void>,
      ) => {
        onProcess(
          {
            stdin: {
              destroyed: false,
              writableEnded: false,
              end() {
                this.writableEnded = true;
              },
            },
          },
          'review-agent',
        );
        await onOutput({
          status: 'success',
          result: null,
          turnEvent: {
            type: 'turn.started',
            turnId: 'turn-direct-review',
            timestamp: '2026-04-23T00:00:00.000Z',
          },
        });
        await onOutput({
          status: 'success',
          result: null,
          turnEvent: {
            type: 'item.completed',
            turnId: 'turn-direct-review',
            timestamp: '2026-04-23T00:00:01.000Z',
            item: {
              id: 'tool-read-file',
              type: 'tool_call',
              status: 'completed',
              title: 'read_file',
              argumentsText: '{"path":"small.ts"}',
              resultText: 'export const smallChange = true;',
              timestamp: '2026-04-23T00:00:01.000Z',
            },
          },
        });
        await onOutput({
          status: 'success',
          result: buildAgenticReportMarkdown('小改动由主代理审查通过。'),
        });
        await onOutput({
          status: 'success',
          result: null,
          turnEvent: {
            type: 'turn.completed',
            turnId: 'turn-direct-review',
            timestamp: '2026-04-23T00:00:02.000Z',
          },
        });
        return {
          status: 'success' as const,
          result: null,
        };
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-main-first-small',
      name: 'Repo Main First Small',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-main-first-small',
      repository_id: repository.id,
      name: 'Main First Small',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      include_full_file_context: true,
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    expect(mockRunAgentProcess).toHaveBeenCalledTimes(1);
    expect(
      mockRunAgentProcess.mock.calls.some((call) =>
        String(call[1]?.runtimeNamespace || '').includes(':subagent:'),
      ),
    ).toBe(false);
    expect(
      setTimeoutSpy.mock.calls.some((call) => Number(call[1]) === 300_000),
    ).toBe(false);
    setTimeoutSpy.mockRestore();
    const prompt = String(mockRunAgentProcess.mock.calls[0]?.[1]?.prompt?.text || '');
    expect(prompt).toContain('必须至少执行一次工具取证');
    expect(prompt).toContain('不要把这些只读命令包进 `bash -lc`');
    expect(prompt).not.toContain('review_plan');
    const run = result.runs[0]!.run;
    expect(run.summary).toContain('小改动由主代理审查通过');
    expect(run.reviewTurns).toHaveLength(1);
    expect(run.reviewTurns[0]?.items[0]).toMatchObject({
      type: 'tool_call',
      title: 'read_file',
    });
    expect(run.executionStats).toMatchObject({
      plannedSubagentCount: 0,
      delegatedSubagentCount: 0,
      modelCallCount: 1,
    });
  });

  it('uses the same direct review path when full-file review is disabled', async () => {
    runGit(tempRepo, ['commit', '-m', 'base']);
    fs.writeFileSync(
      path.join(tempRepo, 'demo.ts'),
      [
        'export function normalizeName(name: string) {',
        '  return name.trim();',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    runGit(tempRepo, ['add', 'demo.ts']);

    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: buildAgenticReportMarkdown('diff-only 审查通过。'),
    });

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-agentic-full-file-disabled',
      name: 'Repo Agentic Full File Disabled',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-agentic-full-file-disabled',
      repository_id: repository.id,
      name: 'Agentic Full File Disabled',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      include_full_file_context: false,
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    expect(mockRunAgentProcess).toHaveBeenCalledTimes(1);
    const firstPrompt = String(
      mockRunAgentProcess.mock.calls[0]?.[1]?.prompt?.text || '',
    );
    expect(firstPrompt).toContain('本次由主代理直接审查');
    expect(firstPrompt).toContain('必须至少执行一次工具取证');
    expect(firstPrompt).not.toContain('review_plan');

    const run = result.runs[0]!.run;
    expect(run.overall).toBe('pass');
    expect(run.executionStats).toMatchObject({
      plannedSubagentCount: 0,
      delegatedSubagentCount: 0,
      modelCallCount: 1,
    });
  });

  it('persists repo review budget stats for direct diff and full-file execution', async () => {
    runGit(tempRepo, ['commit', '-m', 'base']);
    fs.writeFileSync(
      path.join(tempRepo, 'demo.ts'),
      [
        'export function authenticate(token?: string) {',
        '  if (!token) return "";',
        '  return token.trim();',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    runGit(tempRepo, ['add', 'demo.ts']);

    mockRunAgentProcess
      .mockImplementationOnce(
        async (
          _group,
          _input,
          onProcess: (proc: unknown, agentLabel: string) => void,
          onOutput: (output: Record<string, unknown>) => Promise<void>,
        ) => {
          onProcess(
            {
              stdin: {
                destroyed: false,
                writableEnded: false,
                end() {
                  this.writableEnded = true;
                },
              },
            },
            'review-agent',
          );
          await onOutput({
            status: 'success',
            result: null,
            turnEvent: {
              type: 'turn.started',
              turnId: 'turn-budget-review',
              timestamp: '2026-04-23T00:00:00.000Z',
            },
          });
          await onOutput({
            status: 'success',
            result: null,
            turnEvent: {
              type: 'item.completed',
              turnId: 'turn-budget-review',
              timestamp: '2026-04-23T00:00:01.000Z',
              item: {
                id: 'tool-read-file',
                type: 'tool_call',
                status: 'completed',
                title: 'read_file',
                argumentsText: '{"path":"demo.ts"}',
                resultText: 'export function authenticate(token?: string) {}',
                timestamp: '2026-04-23T00:00:01.000Z',
              },
            },
          });
          await onOutput({
            status: 'success',
            result: JSON.stringify({
              overall: 'pass',
              summary: '主线审查完成。',
              findings: [],
              file_reviews: [],
              scope_limitations: [],
              commit_reviews: [],
              suggestions: [],
              recommended_block: false,
            }),
          });
          await onOutput({
            status: 'success',
            result: null,
            turnEvent: {
              type: 'turn.completed',
              turnId: 'turn-budget-review',
              timestamp: '2026-04-23T00:00:02.000Z',
            },
          });
          return {
            status: 'success' as const,
            result: null,
          };
        },
      )
      .mockResolvedValueOnce({
        status: 'success',
        result: JSON.stringify({
          summary: '主代理审查通过。',
          findings: [],
          suggestions: [],
          scope_limitations: [],
          overall_impact: 'none',
          recommended_block: false,
        }),
      });

    const service = await import('./repo-review-service.js');
    const finalMarkdown = buildAgenticReportMarkdown('主代理审查通过。');
    mockRunAgentProcess
      .mockResolvedValueOnce(
        buildAgenticPlanMockResult([
          {
            id: 'task-1',
            title: '审查 demo.ts',
            objective: '确认 demo.ts 的改动是否安全',
            files: ['demo.ts'],
            focus: 'full-file evidence',
            fullFileFiles: ['demo.ts'],
          },
        ]),
      )
      .mockImplementationOnce(
        buildMockReviewProcessWithSubagentResult(
          {
            summary: 'demo.ts 全文补充审查通过。',
            findings: [],
            suggestions: [],
            scope_limitations: [],
            overall_impact: 'none',
            recommended_block: false,
          },
        ),
      )
      .mockResolvedValueOnce({
        status: 'success',
        result: finalMarkdown,
      })
      .mockResolvedValueOnce(
        buildAgenticExtractorMockResult({
          overall: 'pass',
          summary: '主代理审查通过。',
          markdown: finalMarkdown,
        }),
      );
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-budget-stats',
      name: 'Repo Budget Stats',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-budget-stats',
      repository_id: repository.id,
      name: 'Budget Stats',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      include_full_file_context: true,
      diff_subagent_threshold: 0,
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    const run = result.runs[0]!.run;
    expect(run.executionStats).toMatchObject({
      diffFiles: 1,
      extraRepoReadCount: 1,
    });
    expect(run.executionStats?.modelCallCount).toBeGreaterThanOrEqual(1);
    expect(run.executionStats?.diffBytes).toBeGreaterThan(0);
    expect(run.executionStats?.fullFileBytesLoaded).toBe(0);
    expect(run.executionStats?.promptBytesBuilt).toBeGreaterThan(0);
    expect(run.executionStats?.progressSnapshotBytes).toBeGreaterThan(0);
  });
  it('keeps the main review prompt flexible while still carrying inline diff evidence', async () => {
    runGit(tempRepo, ['commit', '-m', 'base']);
    fs.writeFileSync(
      path.join(tempRepo, 'prompt-contract.ts'),
      'export const promptContract = true;\n',
      'utf8',
    );
    runGit(tempRepo, ['add', 'prompt-contract.ts']);

    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: 'prompt ok',
        findings: [],
        file_reviews: [],
        scope_limitations: [],
        commit_reviews: [],
        suggestions: [],
        recommended_block: false,
      }),
    });

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-prompt-contract',
      name: 'Repo Prompt Contract',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-prompt-contract',
      repository_id: repository.id,
      name: 'Prompt Contract',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    const prompt = String(mockRunAgentProcess.mock.calls[0]?.[1]?.prompt?.text || '');
    expect(prompt).toContain('本次由主代理直接审查');
    expect(prompt).toContain('必须至少执行一次工具取证');
    expect(prompt).not.toContain('review_plan');
    expect(prompt).toContain('只读工作区可用于核对直接相关代码和 git 信息');
  });


  it('runs executor-owned full-file tasks without a plan correction loop', async () => {
    runGit(tempRepo, ['commit', '-m', 'base']);
    fs.writeFileSync(
      path.join(tempRepo, 'a.ts'),
      ['export const a = 1;', ''].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempRepo, 'b.ts'),
      ['export const b = 1;', ''].join('\n'),
      'utf8',
    );
    runGit(tempRepo, ['add', 'a.ts', 'b.ts']);

    const finalMarkdown = buildAgenticReportMarkdown('主代理直接完成审查。');
    mockRunAgentProcess
      .mockResolvedValueOnce(
        buildAgenticPlanMockResult([
          {
            id: 'task-1',
            title: '审查 a.ts',
            objective: '确认 a.ts 的改动是否安全',
            files: ['a.ts'],
            focus: '局部全文件审查',
            fullFileFiles: ['a.ts'],
          },
          {
            id: 'task-2',
            title: '审查 b.ts',
            objective: '确认 b.ts 的改动是否安全',
            files: ['b.ts'],
            focus: '局部全文件审查',
            fullFileFiles: ['b.ts'],
          },
        ]),
      )
      .mockResolvedValueOnce(
        buildAgenticSubagentMockResult({
          files: ['a.ts'],
          summary: 'a.ts 全文补充审查通过。',
        }),
      )
      .mockResolvedValueOnce(
        buildAgenticSubagentMockResult({
          files: ['b.ts'],
          summary: 'b.ts 全文补充审查通过。',
        }),
      )
      .mockResolvedValueOnce({
        status: 'success',
        result: finalMarkdown,
      })
      .mockResolvedValueOnce(
        buildAgenticExtractorMockResult({
          overall: 'pass',
          summary: '主代理直接完成审查。',
          markdown: finalMarkdown,
        }),
      );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-two-phase-parallel',
      name: 'Repo Two Phase Parallel',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-two-phase-parallel',
      repository_id: repository.id,
      name: 'Two Phase Parallel',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      include_full_file_context: true,
      diff_subagent_threshold: 0,
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const triggerPromise = service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    await waitForCondition(async () => {
      expect(mockRunAgentProcess).toHaveBeenCalledTimes(4);
    });
    const result = await triggerPromise;

    expect(mockRunAgentProcess).toHaveBeenCalledTimes(4);
    const prompts = mockRunAgentProcess.mock.calls.map((call) =>
      String(call[1]?.prompt?.text || ''),
    );
    expect(prompts[0]).toContain('review_plan');
    expect(prompts[1]).toContain('a.ts');
    expect(prompts[2]).toContain('b.ts');
    expect(
      mockRunAgentProcess.mock.calls.filter((call) =>
        String(call[1]?.runtimeNamespace || '').includes(':main-plan:'),
      ),
    ).toHaveLength(1);
    expect(result.runs[0]?.run.summary).toContain('主代理直接完成审查');
    expect(result.runs[0]?.run.scopeLimitations).toEqual([]);
  });

  it('sends structured feishu mentions for mapped repo review actor', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: '通过',
        findings: [],
        commit_reviews: [],
        suggestions: [],
        recommended_block: false,
      }),
    });

    const service = await import('./repo-review-service.js');
    const sender = vi.fn().mockResolvedValue(undefined);
    service.setRepoReviewMessageSender(sender);

    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-feishu-mention',
      name: 'Repo Feishu Mention',
      local_repo_path: tempRepo,
      reviewChatJid: 'feishu:test-chat',
      actorMentionMappings: [
        {
          actor: 'alice',
          channel: 'feishu',
          id: 'ou_mention_alice',
          name: 'Alice',
        },
      ],
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-feishu-mention',
      repository_id: repository.id,
      name: 'Push Review',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: true,
      enabled: true,
    });

    await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    await waitForCondition(() => {
      expect(sender.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender.mock.calls[0]?.[1]).toMatchObject({
      text: expect.stringContaining('AI 审查开始'),
    });
    expect(sender.mock.calls[0]?.[1]?.mentions).toBeUndefined();

    const mentionPayload = sender.mock.calls.find(
      (call) => call[1]?.mentions?.[0]?.id === 'ou_mention_alice',
    )?.[1];
    expect(mentionPayload).toMatchObject({
      mentions: [
        {
          channel: 'feishu',
          id: 'ou_mention_alice',
          name: 'Alice',
        },
      ],
    });
    expect(String(mentionPayload?.text)).toMatch(/@alice|Alice|审查完成/);
    service.setRepoReviewMessageSender(null);
  });

  it('matches feishu mention mappings by email local-part fallback', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: '通过',
        findings: [],
        commit_reviews: [],
        suggestions: [],
        recommended_block: false,
      }),
    });

    runGit(tempRepo, ['config', '--unset', 'user.name']);
    runGit(tempRepo, ['config', 'user.email', 'zhangsan@example.com']);
    fs.writeFileSync(
      path.join(tempRepo, 'feishu-email-mention.ts'),
      'export const feishuEmailMention = 1;\n',
    );
    runGit(tempRepo, ['add', 'feishu-email-mention.ts']);
    execFileSync(
      'git',
      [
        '-C',
        tempRepo,
        'commit',
        '-m',
        'feishu email mention',
        '--author=zhangsan <zhangsan@example.com>',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    fs.writeFileSync(
      path.join(tempRepo, 'feishu-email-mention.ts'),
      'export const feishuEmailMention = 2;\n',
    );
    runGit(tempRepo, ['add', 'feishu-email-mention.ts']);

    const service = await import('./repo-review-service.js');
    const sender = vi.fn().mockResolvedValue(undefined);
    service.setRepoReviewMessageSender(sender);

    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-feishu-email-mention',
      name: 'Repo Feishu Email Mention',
      local_repo_path: tempRepo,
      reviewChatJid: 'feishu:test-chat',
      actorMentionMappings: [
        {
          actor: 'zhangsan',
          channel: 'feishu',
          id: 'ou_zhangsan',
          name: '张三',
        },
      ],
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-feishu-email-mention',
      repository_id: repository.id,
      name: 'Push Review',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: true,
      enabled: true,
    });

    await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    await waitForCondition(() => {
      expect(
        sender.mock.calls.some(
          (entry) => entry[1]?.mentions?.[0]?.id === 'ou_zhangsan',
        ),
      ).toBe(true);
    });
    const mentionCall = sender.mock.calls.find(
      (entry) => entry[1]?.mentions?.[0]?.id === 'ou_zhangsan',
    );
    expect(mentionCall?.[1]).toMatchObject({
      text: expect.stringContaining('AI 审查完成'),
      mentions: [
        {
          channel: 'feishu',
          id: 'ou_zhangsan',
          name: '张三',
        },
      ],
    });
    service.setRepoReviewMessageSender(null);
  },
    15000,
  );

  it('broadcasts locally persisted repo review chat messages over the web channel', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: '通过',
        findings: [],
        commit_reviews: [],
        suggestions: [],
        recommended_block: false,
      }),
    });

    const notifyMessage = vi.fn();
    mockGetWebChannel.mockReturnValue({
      notifyMessage,
      notifyTurnEvent: vi.fn(),
      sendStreamChunk: vi.fn(),
      notifyApprovalRequest: vi.fn(),
      notifyApprovalResolved: vi.fn(),
    });

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-local-chat-broadcast',
      name: 'Repo Local Chat Broadcast',
      local_repo_path: tempRepo,
      reviewChatJid: `repo-review:repo-local-chat-broadcast`,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-local-chat-broadcast',
      repository_id: repository.id,
      name: 'Push Review',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: true,
      enabled: true,
    });

    await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    expect(notifyMessage).toHaveBeenCalledTimes(1);
    expect(notifyMessage.mock.calls[0]?.[0]).toBe(repository.reviewChatJid);
    expect(notifyMessage.mock.calls[0]?.[1]).toMatchObject({
      content: expect.stringContaining('AI 审查完成'),
      is_bot: true,
      is_from_me: true,
    });
  });

  it('publishes repo-review share links and keeps the summary short', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'fail',
        summary: '登录流程存在高风险问题。',
        findings: [
          {
            severity: 'high',
            file: 'src/auth.ts',
            title: '缺少 token 判空',
            detail:
              '这是一个很长的细节说明，用来证明聊天摘要不应直接复制完整 finding 细节，而应只保留精简结论。',
            suggestion: '先补 token 判空，再补鉴权回归测试。',
          },
        ],
        commit_reviews: [],
        suggestions: ['先补 token 判空，再补鉴权回归测试。'],
        recommended_block: true,
      }),
    });

    const service = await import('./repo-review-service.js');
    const sender = vi.fn().mockResolvedValue(undefined);
    const prepareFeishuCloudDoc = vi.fn().mockResolvedValue({
      documentId: 'doccn123',
      title: 'feature/login 2026-03-27 10:05',
      creationStatus: 'created',
    });
    const continueFeishuCloudDocProvision = vi.fn(async (input) => {
      const runs = await service.listRepoReviewRuns('repo-cloud-doc-success');
      const persistedRun =
        runs.find((entry) => entry.cloudDocToken === 'doccn123') ?? runs[0];
      expect(persistedRun?.cloudDocToken).toBe('doccn123');
      expect(persistedRun?.cloudDocStatus).toBe('created');
      return {
        documentId: 'doccn123',
        url: 'https://tenant.feishu.cn/docx/doccn123',
        title: 'feature/login 2026-03-27 10:05',
        conversationType: 'group',
        creationStatus: 'created',
        populationStatus: 'completed',
        resultStatus: 'success',
        authorizationStrategy: 'chat',
        authorizationStatus: 'complete',
        authorizationWarnings: [],
        targetResults: [],
      };
    });

    service.setRepoReviewMessageSender(sender);
    service.setRepoReviewCloudDocHandlersForTests({
      prepareFeishuCloudDoc,
      continueFeishuCloudDocProvision,
    });

    const originalNow = Date.now;
    Date.now = () => new Date('2026-03-27T10:05:00.000Z').getTime();
    try {
      const db = await import('../db.js');
      await db.storeChatMetadata(
        'feishu:test-chat',
        '2026-03-27T10:00:00.000Z',
        'Repo Review Chat',
        'feishu',
        true,
      );
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-cloud-doc-success',
        name: 'Repo Cloud Doc Success',
        local_repo_path: tempRepo,
        reviewChatJid: 'feishu:test-chat',
        enabled: true,
      });
      await service.upsertRepoReviewProfile({
        id: 'profile-cloud-doc-success',
        repository_id: repository.id,
        name: 'Push Review',
        stage: 'push',
        source_mode: 'local',
        blocking_mode: 'soft_fail',
        review_scope: 'staged_diff',
        write_to_chat: true,
        write_to_platform: false,
        review_output_mode: 'share_link',
        enabled: true,
      });

      const result = await service.triggerLocalRepoReview({
        repositoryId: repository.id,
        stage: 'push',
      });

      const run =
        (await service.getRepoReviewRun(result.runs[0]!.run.id)) ??
        result.runs[0]!.run;
      expect(run.cloudDocToken).toBe('');
      expect(run.cloudDocUrl).toBe('');
      expect(run.cloudDocStatus).toBe('');
      expect(prepareFeishuCloudDoc).not.toHaveBeenCalled();
      expect(continueFeishuCloudDocProvision).not.toHaveBeenCalled();
      expect(sender).toHaveBeenCalledTimes(2);
      expect(sender.mock.calls[1]?.[1]?.text).toContain('完整 CR 报告');
      expect(sender.mock.calls[1]?.[1]?.text).toContain('/share/');
      expect(sender.mock.calls[1]?.[1]?.text).toContain('关键问题:');
      expect(sender.mock.calls[1]?.[1]?.text).not.toContain(
        '这是一个很长的细节说明，用来证明聊天摘要不应直接复制完整 finding 细节',
      );
    } finally {
      Date.now = originalNow;
      service.setRepoReviewMessageSender(null);
      service.setRepoReviewCloudDocHandlersForTests(null);
    }
  },
    45000,
  );

  it('includes final-code evidence in repo-review cloud doc sections when provisioning from a completed run', async () => {
    runGit(tempRepo, ['commit', '-m', 'main base']);
    const baseSha = runGit(tempRepo, ['rev-parse', 'HEAD']);
    runGit(tempRepo, ['checkout', '-b', 'feature/login']);
    fs.writeFileSync(
      path.join(tempRepo, 'demo.ts'),
      [
        'export function authenticate(token?: string) {',
        '  if (!token) {',
        '    throw new Error("token required");',
        '  }',
        '  return token.trim();',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    runGit(tempRepo, ['add', 'demo.ts']);
    runGit(tempRepo, ['commit', '-m', 'feature login']);
    const headSha = runGit(tempRepo, ['rev-parse', 'HEAD']);

    const service = await import('./repo-review-service.js');
    const db = await import('../db.js');
    await db.storeChatMetadata(
      'feishu:test-chat-evidence',
      '2026-03-27T10:00:00.000Z',
      'Repo Review Evidence Chat',
      'feishu',
      true,
    );
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-cloud-doc-evidence',
      name: 'Repo Cloud Doc Evidence',
      local_repo_path: tempRepo,
      reviewChatJid: 'feishu:test-chat-evidence',
      enabled: true,
    });
    const created = await db.createReviewRun({
      id: 'review-run-cloud-doc-evidence',
      repository_id: repository.id,
      source: 'local-hook',
      stage: 'push',
      status: 'completed',
      branch: 'feature/login',
      ref: 'refs/heads/feature/login',
      base_sha: baseSha,
      head_sha: headSha,
      actor: 'alice',
      baseline_source: 'merge-base',
      result_state: 'failed',
      callback_context: {
        commitDetails: [],
      },
    });
    await db.updateReviewRun(created.id, {
      overall: 'fail',
      summary: '登录流程存在高风险问题。',
      findings: [
        {
          severity: 'high',
          file: 'demo.ts',
          title: '缺少 token 判空',
          detail: '空 token 会直接进入后续逻辑。',
          suggestion: '在主流程前先拒绝空 token。',
        },
      ],
      suggestions: ['在主流程前先拒绝空 token。'],
      changed_files: ['demo.ts'],
      completed_at: '2026-03-27T10:05:00.000Z',
    });

    let provisionedSections: Array<{ kind: string; text: string }> = [];
    service.setRepoReviewCloudDocHandlersForTests({
      prepareFeishuCloudDoc: vi.fn().mockResolvedValue({
        documentId: 'doccn-evidence',
        title: 'feature/login 2026-03-27 10:05',
        creationStatus: 'created',
      }),
      continueFeishuCloudDocProvision: vi.fn().mockImplementation(async (input) => {
        provisionedSections = input.sections as Array<{ kind: string; text: string }>;
        return {
          documentId: 'doccn-evidence',
          url: 'https://tenant.feishu.cn/docx/doccn-evidence',
          title: 'feature/login 2026-03-27 10:05',
          conversationType: 'group',
          creationStatus: 'created',
          populationStatus: 'completed',
          resultStatus: 'success',
          authorizationStrategy: 'chat',
          authorizationStatus: 'complete',
          authorizationWarnings: [],
          targetResults: [],
        };
      }),
    });

    try {
      const run = await service.getRepoReviewRun(created.id);
      const provisioned = await service._provisionRepoReviewCloudDocForTests({
        repository,
        run: run!,
      });

      expect(provisioned.run.cloudDocStatus).toBe('success');
      expect(
        provisionedSections.some(
          (section) =>
            section.kind === 'paragraph' && section.text === '**关键证据：**',
        ),
      ).toBe(true);
      expect(
        provisionedSections.some(
          (section) =>
            section.kind === 'code' &&
            !section.text.includes('diff --git') &&
            !section.text.includes('@@') &&
            section.text.includes('if (!token) {') &&
            section.text.includes('throw new Error("token required");'),
        ),
      ).toBe(true);
    } finally {
      service.setRepoReviewCloudDocHandlersForTests(null);
    }
  },
    20000,
  );

  it('anchors final-code evidence to the relevant changed code instead of top-of-file imports', async () => {
    runGit(tempRepo, ['commit', '-m', 'main base']);
    const baseSha = runGit(tempRepo, ['rev-parse', 'HEAD']);
    runGit(tempRepo, ['checkout', '-b', 'feature/timeout-fix']);
    fs.writeFileSync(
      path.join(tempRepo, 'OrderRuleTestController.java'),
      [
        'package com.example;',
        '',
        'import java.util.List;',
        '',
        'public class OrderRuleTestController {',
        '  public String runInVirtualThread() {',
        '    return "ok";',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    runGit(tempRepo, ['add', 'OrderRuleTestController.java']);
    runGit(tempRepo, ['commit', '--amend', '--no-edit']);

    fs.writeFileSync(
      path.join(tempRepo, 'OrderRuleTestController.java'),
      [
        'package com.example;',
        '',
        'import java.util.List;',
        'import java.util.concurrent.CompletableFuture;',
        'import java.util.concurrent.TimeUnit;',
        'import java.util.concurrent.TimeoutException;',
        '',
        'public class OrderRuleTestController {',
        '  public String runInVirtualThread() {',
        '    CompletableFuture<String> future = CompletableFuture.supplyAsync(() -> "ok");',
        '    try {',
        '      return future.get(30, TimeUnit.SECONDS);',
        '    } catch (TimeoutException timeoutException) {',
        '      future.cancel(true);',
        '      throw new IllegalStateException("timeout", timeoutException);',
        '    } catch (Exception exception) {',
        '      throw new IllegalStateException("failed", exception);',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
      );
    runGit(tempRepo, ['add', 'OrderRuleTestController.java']);
    runGit(tempRepo, ['commit', '-m', 'feature timeout fix']);
    const headSha = runGit(tempRepo, ['rev-parse', 'HEAD']);

    const service = await import('./repo-review-service.js');
    const db = await import('../db.js');
    await db.storeChatMetadata(
      'feishu:test-chat-anchor',
      '2026-03-27T10:00:00.000Z',
      'Repo Review Anchor Chat',
      'feishu',
      true,
    );
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-cloud-doc-anchor',
      name: 'Repo Cloud Doc Anchor',
      local_repo_path: tempRepo,
      reviewChatJid: 'feishu:test-chat-anchor',
      enabled: true,
    });
    const created = await db.createReviewRun({
      id: 'review-run-cloud-doc-anchor',
      repository_id: repository.id,
      source: 'local-hook',
      stage: 'push',
      status: 'completed',
      branch: 'feature/timeout-fix',
      ref: 'refs/heads/feature/timeout-fix',
      base_sha: baseSha,
      head_sha: headSha,
      actor: 'alice',
      baseline_source: 'merge-base',
      result_state: 'warned',
      callback_context: {
        commitDetails: [],
      },
    });
    await db.updateReviewRun(created.id, {
      overall: 'warn',
      summary: '超时处理需要继续关注。',
      findings: [
        {
          severity: 'medium',
          file: 'OrderRuleTestController.java',
          title: 'runInVirtualThread 超时后需要取消 future',
          detail: 'runInVirtualThread 当前只返回 timeout，应该显式 cancel future。',
          suggestion: '补充 future.cancel(true)。',
        },
      ],
      suggestions: ['补充 future.cancel(true)。'],
      changed_files: ['OrderRuleTestController.java'],
      completed_at: '2026-03-27T10:05:00.000Z',
    });

    let provisionedSections: Array<{ kind: string; text: string }> = [];
    service.setRepoReviewCloudDocHandlersForTests({
      prepareFeishuCloudDoc: vi.fn().mockResolvedValue({
        documentId: 'doccn-anchor',
        title: 'feature/timeout-fix 2026-03-27 10:05',
        creationStatus: 'created',
      }),
      continueFeishuCloudDocProvision: vi.fn().mockImplementation(async (input) => {
        provisionedSections = input.sections as Array<{ kind: string; text: string }>;
        return {
          documentId: 'doccn-anchor',
          url: 'https://tenant.feishu.cn/docx/doccn-anchor',
          title: 'feature/timeout-fix 2026-03-27 10:05',
          conversationType: 'group',
          creationStatus: 'created',
          populationStatus: 'completed',
          resultStatus: 'success',
          authorizationStrategy: 'chat',
          authorizationStatus: 'complete',
          authorizationWarnings: [],
          targetResults: [],
        };
      }),
    });

    try {
      const run = await service.getRepoReviewRun(created.id);
      await service._provisionRepoReviewCloudDocForTests({
        repository,
        run: run!,
      });

      expect(
        provisionedSections.some(
          (section) =>
            section.kind === 'code' &&
            section.text.includes('future.cancel(true);') &&
            section.text.includes('throw new IllegalStateException("timeout", timeoutException);') &&
            !section.text.startsWith('package com.example;'),
        ),
      ).toBe(true);
    } finally {
      service.setRepoReviewCloudDocHandlersForTests(null);
    }
  });

  it('reuses the persisted repo-review cloud-doc token on continuation retries and adds an explicit authorization warning note', async () => {
    const service = await import('./repo-review-service.js');
    const prepareFeishuCloudDoc = vi.fn().mockResolvedValue({
      documentId: 'doccn-new',
      title: 'feature/login 2026-03-27 10:08',
      creationStatus: 'created',
    });
    const continueFeishuCloudDocProvision = vi.fn().mockResolvedValue({
      documentId: 'doccn-existing',
      url: 'https://tenant.feishu.cn/docx/doccn-existing',
      title: 'feature/login 2026-03-27 10:08',
      conversationType: 'group',
      creationStatus: 'created',
      populationStatus: 'completed',
      resultStatus: 'success_with_authorization_warnings',
      authorizationStrategy: 'users',
      authorizationStatus: 'partial',
      authorizationWarnings: ['chat grant failed; user fallback partially failed'],
      targetResults: [
        {
          targetType: 'user',
          targetId: 'ou_1',
          status: 'failed',
          error: 'rate limited',
        },
      ],
    });

    service.setRepoReviewCloudDocHandlersForTests({
      prepareFeishuCloudDoc,
      continueFeishuCloudDocProvision,
    });

    const originalNow = Date.now;
    Date.now = () => new Date('2026-03-27T10:08:00.000Z').getTime();
    try {
      const db = await import('../db.js');
      await db.storeChatMetadata(
        'feishu:test-chat-retry',
        '2026-03-27T10:00:00.000Z',
        'Repo Review Retry Chat',
        'feishu',
        true,
      );
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-cloud-doc-retry',
        name: 'Repo Cloud Doc Retry',
        local_repo_path: tempRepo,
        reviewChatJid: 'feishu:test-chat-retry',
        enabled: true,
      });
      const dbRun = await db.createReviewRun({
        id: 'review-run-existing-doc',
        repository_id: repository.id,
        source: 'github',
        stage: 'push',
        status: 'completed',
        branch: 'feature/login',
        base_sha: 'base-1',
        head_sha: 'head-1',
        actor: 'alice',
        baseline_source: 'parent-commit',
        result_state: 'warning',
        callback_context: {
          commitDetails: [],
        },
      });
      await db.updateReviewRun(dbRun.id, {
        overall: 'warn',
        summary: '存在中风险兼容性问题。',
        findings: [
          {
            severity: 'medium',
            file: 'src/login.ts',
            title: '错误码映射不稳定',
            detail: '上游超时与鉴权失败共用同一个错误码。',
            suggestion: '拆分错误码并补充回归测试。',
          },
        ],
        suggestions: ['拆分错误码并补充回归测试。'],
        changed_files: ['src/login.ts'],
        cloud_doc_token: 'doccn-existing',
        cloud_doc_title: 'feature/login 2026-03-27 10:08',
        cloud_doc_status: 'created',
      });

      const existingRun = await service.getRepoReviewRun(dbRun.id);
      const provisioned = await service._provisionRepoReviewCloudDocForTests({
        repository,
        run: existingRun!,
      });
      const run = provisioned.run;
      expect(run?.cloudDocToken).toBe('doccn-existing');
      expect(run?.cloudDocUrl).toBe(
        'https://tenant.feishu.cn/docx/doccn-existing',
      );
      expect(run?.cloudDocStatus).toBe('success_with_authorization_warnings');
      expect(prepareFeishuCloudDoc).not.toHaveBeenCalled();
      expect(continueFeishuCloudDocProvision).toHaveBeenCalledTimes(1);
      const summary = service.formatRepoReviewCompletedMessage(
        repository,
        run!,
        'ai',
      );
      expect(summary).toContain('AI 审查完成');
    } finally {
      Date.now = originalNow;
      service.setRepoReviewCloudDocHandlersForTests(null);
    }
  });

  it('falls back to the normal completion summary when repo-review cloud-doc population fails', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'fail',
        summary: '需要先修复高风险问题。',
        findings: [
          {
            severity: 'high',
            file: 'src/auth.ts',
            title: '缺少 token 判空',
            detail: '空 token 会进入后续逻辑。',
            suggestion: '补 token 判空。',
          },
        ],
        commit_reviews: [],
        suggestions: ['补 token 判空。'],
        recommended_block: true,
      }),
    });

    const service = await import('./repo-review-service.js');
    const sender = vi.fn().mockResolvedValue(undefined);

    service.setRepoReviewMessageSender(sender);
    service.setRepoReviewCloudDocHandlersForTests({
      prepareFeishuCloudDoc: vi.fn().mockResolvedValue({
        documentId: 'doccn-failed',
        title: 'feature/login 2026-03-27 10:10',
        creationStatus: 'created',
      }),
      continueFeishuCloudDocProvision: vi.fn().mockResolvedValue({
        documentId: 'doccn-failed',
        url: '',
        title: 'feature/login 2026-03-27 10:10',
        conversationType: 'group',
        creationStatus: 'created',
        populationStatus: 'failed',
        resultStatus: 'content_population_failed',
        authorizationStrategy: 'chat',
        authorizationStatus: 'skipped',
        authorizationWarnings: [],
        targetResults: [],
        lastError: 'doc write failed',
      }),
    });

    const originalNow = Date.now;
    Date.now = () => new Date('2026-03-27T10:10:00.000Z').getTime();
    try {
      const db = await import('../db.js');
      await db.storeChatMetadata(
        'feishu:test-chat-fallback',
        '2026-03-27T10:00:00.000Z',
        'Repo Review Fallback Chat',
        'feishu',
        true,
      );
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-cloud-doc-fallback',
        name: 'Repo Cloud Doc Fallback',
        local_repo_path: tempRepo,
        reviewChatJid: 'feishu:test-chat-fallback',
        enabled: true,
      });
      await service.upsertRepoReviewProfile({
        id: 'profile-cloud-doc-fallback',
        repository_id: repository.id,
        name: 'Push Review',
        stage: 'push',
        source_mode: 'local',
        blocking_mode: 'soft_fail',
        review_scope: 'staged_diff',
        write_to_chat: true,
        write_to_platform: false,
        review_output_mode: 'share_link',
        enabled: true,
      });

      const result = await service.triggerLocalRepoReview({
        repositoryId: repository.id,
        stage: 'push',
      });

      const run =
        (await service.getRepoReviewRun(result.runs[0]!.run.id)) ??
        result.runs[0]!.run;
      expect(run.cloudDocToken).toBe('');
      expect(run.cloudDocStatus).toBe('');
      expect(run.cloudDocUrl).toBe('');
      expect(run.cloudDocLastError).toBe('');
      expect(sender.mock.calls.at(-1)?.[1]?.text).toContain('完整 CR 报告');
      expect(sender.mock.calls.at(-1)?.[1]?.text).toContain('/share/');
      expect(sender.mock.calls.at(-1)?.[1]?.text).toContain('关键问题:');
    } finally {
      Date.now = originalNow;
      service.setRepoReviewMessageSender(null);
      service.setRepoReviewCloudDocHandlersForTests(null);
    }
  },
    45000,
  );

  it('installs and uninstalls managed review hooks', async () => {
    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-hooks',
      name: 'Repo Hooks',
      local_repo_path: tempRepo,
      enabled: true,
    });

    const installResult = await service.installRepoReviewHooks({
      repositoryId: repository.id,
      nanoclawRoot: originalCwd,
    });
    const preCommitPath = path.join(installResult.hooksPath, 'pre-commit');
    expect(fs.readFileSync(preCommitPath, 'utf8')).toContain(
      '--repository-id "repo-hooks" --stage commit',
    );

    await service.uninstallRepoReviewHooks({ repositoryId: repository.id });
    expect(fs.existsSync(preCommitPath)).toBe(false);
  });

  it('runs a local commit review and blocks on hard-fail output', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'fail',
        summary: '发现高风险问题',
        findings: [
          {
            severity: 'high',
            file: 'demo.ts',
            title: '危险改动',
            detail: '需要拦截',
            suggestion: '回滚改动',
          },
        ],
        commit_reviews: [
          {
            commit: 'abc1234',
            title: 'Add risky change',
            author: 'alice',
            positives: ['变更目标明确'],
            issues: ['缺少边界检查'],
          },
        ],
        suggestions: ['修复后再提交'],
        confidence: 'high',
        recommended_block: true,
      }),
    });

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-review',
      name: 'Repo Review',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-commit',
      repository_id: repository.id,
      name: 'Commit Guard',
      stage: 'commit',
      source_mode: 'both',
      blocking_mode: 'hard_fail',
      review_scope: 'staged_diff',
      skill_ids: [],
      mcp_server_ids: [],
      prompt_template: '只看 staged diff。',
      include_globs: [],
      exclude_globs: [],
      max_files: 10,
      max_diff_bytes: 10000,
      write_to_chat: true,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.run.overall).toBe('fail');
    expect(result.runs[0]?.run.commitReviews).toHaveLength(1);
    expect(result.runs[0]?.run.commitReviews[0]?.commit).toBe('abc1234');
    expect(result.runs[0]?.blocked).toBe(true);
    expect(mockRunAgentProcess).toHaveBeenCalledTimes(1);
    expect(mockRunAgentProcess.mock.calls[0]?.[1]).toMatchObject({
      disableDefaultWebSearch: true,
      prompt: expect.objectContaining({
        stableSystemPrompt: expect.stringContaining(
          'final assistant message must be exactly one valid JSON object',
        ),
      }),
    });
  });

  it('waits for the terminal review turn event before closing the single-turn agent stdin', async () => {
    const stdinEnd = vi.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    });
    mockRunAgentProcess.mockImplementation(
      async (
        _group,
        _input,
        onProcess: (proc: unknown, agentLabel: string) => void,
        onOutput: (output: Record<string, unknown>) => Promise<void>,
      ) => {
        const proc = {
          stdin: {
            destroyed: false,
            writableEnded: false,
            end: stdinEnd,
          },
        };
        onProcess(proc as never, 'review-agent');
        await onOutput({
          status: 'success',
          result: null,
          turnEvent: {
            type: 'turn.started',
            turnId: 'turn-review-1',
            timestamp: '2026-03-13T00:00:00.000Z',
          },
        });
        await onOutput({
          status: 'success',
          result: null,
          turnEvent: {
            type: 'item.completed',
            turnId: 'turn-review-1',
            timestamp: '2026-03-13T00:00:01.000Z',
            item: {
              id: 'tool-1',
              type: 'tool_call',
              status: 'completed',
              title: 'read_file',
              argumentsText: '{\"path\":\"demo.ts\"}',
              resultText: 'const a = 1;',
              subagentInfo: {
                agentName: 'backend-worker',
                task: '检查 demo.ts 的实现',
                status: 'completed',
              },
              timestamp: '2026-03-13T00:00:01.000Z',
            },
          },
        });
        await onOutput({
          status: 'success',
          result: JSON.stringify({
            overall: 'pass',
            summary: 'stream ok',
            findings: [],
            suggestions: [],
            recommended_block: false,
          }),
        });
        expect(stdinEnd).not.toHaveBeenCalled();
        await onOutput({
          status: 'success',
          result: null,
          turnEvent: {
            type: 'turn.completed',
            turnId: 'turn-review-1',
            timestamp: '2026-03-13T00:00:02.000Z',
          },
        });
        return {
          status: 'success',
          result: null,
        };
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-stream-review',
      name: 'Repo Stream Review',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-stream-review',
      repository_id: repository.id,
      name: 'Commit Stream Review',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.run.overall).toBe('pass');
    expect(result.runs[0]?.run.reviewTurns).toHaveLength(1);
    expect(result.runs[0]?.run.reviewTurns[0]?.items[0]).toMatchObject({
      type: 'tool_call',
      title: 'read_file',
      subagentInfo: {
        agentName: 'backend-worker',
      },
    });
    expect(mockRequestAgentClose).toHaveBeenCalledTimes(1);
    expect(stdinEnd).toHaveBeenCalledTimes(1);
  });

  it('uses the code review module provider for user-triggered local reviews', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: 'module provider ok',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });

    const service = await import('./repo-review-service.js');
    const { createProvider } = await import('../db/assistants.js');
    const { setTenantConfig } = await import('../tenant/tenant-db.js');

    await createProvider({
      id: 'provider-code-review-user',
      alias: 'User Code Review',
      type: 'openai',
      api_key: 'sk-user',
      base_url: 'https://api.example.com',
      model: 'gpt-4.1-mini',
      extra_config: null,
      is_default: 0,
      user_id: 'test-user',
      visibility: 'private',
      created_by: 'test-user',
      updated_by: 'test-user',
    });
    await setTenantConfig(
      'test-user',
      'DEFAULT_PROVIDER_code_review',
      'provider-code-review-user',
    );

    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-provider-module',
      name: 'Repo Provider Module',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-provider-module',
      repository_id: repository.id,
      name: 'Commit Review',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      skill_ids: [],
      mcp_server_ids: [],
      include_globs: [],
      exclude_globs: [],
      max_files: 20,
      max_diff_bytes: 50000,
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
      userId: 'test-user',
    });

    expect(mockRunAgentProcess).toHaveBeenCalledTimes(1);
    expect(mockRunAgentProcess.mock.calls[0]?.[1]).toMatchObject({
      userId: 'test-user',
      providerOverrideId: 'provider-code-review-user',
    });
  });

  it('completes repo review from final assistant turn text when no result marker is emitted', async () => {
    mockRunAgentProcess.mockImplementation(
      async (_group, _input, onProcess, onOutput) => {
        const stdinEnd = vi.fn();
        onProcess?.({
          stdin: {
            destroyed: false,
            writableEnded: false,
            end: stdinEnd,
          },
        });
        await onOutput?.({
          status: 'success',
          result: null,
          turnEvent: {
            type: 'item.completed',
            turnId: 'turn-review-fallback',
            timestamp: '2026-03-13T00:00:02.000Z',
            item: {
              id: 'turn-review-fallback:assistant:1',
              type: 'assistant_message',
              status: 'completed',
              text: JSON.stringify({
                overall: 'pass',
                summary: 'assistant fallback ok',
                findings: [],
                suggestions: [],
                recommended_block: false,
              }),
              timestamp: '2026-03-13T00:00:02.000Z',
            },
          },
        });
        await onOutput?.({
          status: 'success',
          result: null,
          turnEvent: {
            type: 'turn.completed',
            turnId: 'turn-review-fallback',
            timestamp: '2026-03-13T00:00:03.000Z',
          },
        });
        return {
          status: 'success',
          result: null,
        };
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-turn-fallback',
      name: 'Repo Turn Fallback',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-turn-fallback',
      repository_id: repository.id,
      name: 'Commit Turn Fallback',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.run.overall).toBe('pass');
    expect(result.runs[0]?.run.summary).toBe('assistant fallback ok');
    expect(mockRequestAgentClose).toHaveBeenCalledTimes(1);
  });

  it('closes promptly after a completed final assistant turn before turn.completed arrives', async () => {
    mockRunAgentProcess.mockImplementation(
      async (_group, _input, onProcess, onOutput) => {
        const stdinEnd = vi.fn();
        onProcess?.({
          stdin: {
            destroyed: false,
            writableEnded: false,
            end: stdinEnd,
          },
        });
        await onOutput?.({
          turnEvent: {
            type: 'item.completed',
            turnId: 'turn-review-close-order',
            timestamp: '2026-03-25T01:00:00.000Z',
            item: {
              id: 'turn-review-close-order:assistant:1',
              type: 'assistant_message',
              status: 'completed',
              text: JSON.stringify({
                overall: 'pass',
                summary: 'close ordering ok',
                findings: [],
                suggestions: [],
                recommended_block: false,
              }),
              timestamp: '2026-03-25T01:00:00.000Z',
            },
          },
        });
        expect(mockRequestAgentClose).toHaveBeenCalledTimes(1);
        expect(stdinEnd).toHaveBeenCalledTimes(1);
        await onOutput?.({
          status: 'success',
          result: JSON.stringify({
            overall: 'pass',
            summary: 'close ordering ok',
            findings: [],
            suggestions: [],
            recommended_block: false,
          }),
        });
        expect(mockRequestAgentClose).toHaveBeenCalledTimes(1);
        expect(stdinEnd).toHaveBeenCalledTimes(1);
        await onOutput?.({
          turnEvent: {
            type: 'turn.completed',
            turnId: 'turn-review-close-order',
            timestamp: '2026-03-25T01:00:01.000Z',
          },
        });
        expect(mockRequestAgentClose).toHaveBeenCalledTimes(1);
        expect(stdinEnd).toHaveBeenCalledTimes(1);
        return {
          status: 'success',
          result: null,
        };
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-turn-close-order',
      name: 'Repo Turn Close Order',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-turn-close-order',
      repository_id: repository.id,
      name: 'Commit Close Order',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.run.summary).toBe('close ordering ok');
  });

  it('does not close early for a non-structured assistant progress message', async () => {
    mockRunAgentProcess.mockImplementation(
      async (_group, _input, onProcess, onOutput) => {
        const stdinEnd = vi.fn();
        onProcess?.({
          stdin: {
            destroyed: false,
            writableEnded: false,
            end: stdinEnd,
          },
        });
        await onOutput?.({
          turnEvent: {
            type: 'item.completed',
            turnId: 'turn-review-progress-message',
            timestamp: '2026-05-15T02:25:04.644Z',
            item: {
              id: 'turn-review-progress-message:assistant:1',
              type: 'assistant_message',
              status: 'completed',
              text: 'Now let me read the key files in detail to understand the changes:',
              timestamp: '2026-05-15T02:25:04.644Z',
            },
          },
        });
        expect(mockRequestAgentClose).not.toHaveBeenCalled();
        expect(stdinEnd).not.toHaveBeenCalled();
        await onOutput?.({
          status: 'success',
          result: JSON.stringify({
            overall: 'pass',
            summary: 'final structured result',
            findings: [],
            suggestions: [],
            recommended_block: false,
          }),
        });
        await onOutput?.({
          turnEvent: {
            type: 'turn.completed',
            turnId: 'turn-review-progress-message',
            timestamp: '2026-05-15T02:25:05.662Z',
          },
        });
        return {
          status: 'success',
          result: null,
        };
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-progress-message',
      name: 'Repo Progress Message',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-progress-message',
      repository_id: repository.id,
      name: 'Commit Progress Message',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.run.overall).toBe('pass');
    expect(result.runs[0]?.run.summary).toBe('final structured result');
    expect(mockRequestAgentClose).toHaveBeenCalledTimes(1);
  });

  it('falls back after turn completion when only a non-structured assistant message exists', async () => {
    mockRunAgentProcess.mockImplementation(
      async (_group, _input, onProcess, onOutput) => {
        const stdinEnd = vi.fn();
        onProcess?.({
          stdin: {
            destroyed: false,
            writableEnded: false,
            end: stdinEnd,
          },
        });
        await onOutput?.({
          turnEvent: {
            type: 'item.completed',
            turnId: 'turn-review-progress-fallback',
            timestamp: '2026-05-15T02:25:04.644Z',
            item: {
              id: 'turn-review-progress-fallback:assistant:1',
              type: 'assistant_message',
              status: 'completed',
              text: 'Now let me read the key files in detail to understand the changes:',
              timestamp: '2026-05-15T02:25:04.644Z',
            },
          },
        });
        expect(mockRequestAgentClose).not.toHaveBeenCalled();
        expect(stdinEnd).not.toHaveBeenCalled();
        await onOutput?.({
          turnEvent: {
            type: 'turn.completed',
            turnId: 'turn-review-progress-fallback',
            timestamp: '2026-05-15T02:25:05.662Z',
          },
        });
        expect(mockRequestAgentClose).toHaveBeenCalledTimes(1);
        expect(stdinEnd).toHaveBeenCalledTimes(1);
        return {
          status: 'success',
          result: null,
        };
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-progress-fallback',
      name: 'Repo Progress Fallback',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-progress-fallback',
      repository_id: repository.id,
      name: 'Commit Progress Fallback',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.run.overall).toBe('warn');
    expect(result.runs[0]?.run.summary).toBe(
      '模型输出未完全结构化，已回退展示原始审查结果。',
    );
  });

  it('prefers the final structured repo review result over an earlier assistant turn fallback', async () => {
    mockRunAgentProcess.mockImplementation(
      async (_group, _input, onProcess, onOutput) => {
        const stdinEnd = vi.fn();
        onProcess?.({
          stdin: {
            destroyed: false,
            writableEnded: false,
            end: stdinEnd,
          },
        });
        await onOutput?.({
          turnEvent: {
            type: 'item.completed',
            turnId: 'turn-review-final-result-wins',
            timestamp: '2026-04-22T10:00:00.000Z',
            item: {
              id: 'turn-review-final-result-wins:assistant:1',
              type: 'assistant_message',
              status: 'completed',
              text: JSON.stringify({
                overall: 'warn',
                summary: 'assistant fallback summary',
                findings: [],
                suggestions: [],
                recommended_block: false,
              }),
              timestamp: '2026-04-22T10:00:00.000Z',
            },
          },
        });
        await onOutput?.({
          status: 'success',
          result: [
            JSON.stringify({
              overall: 'fail',
              summary: 'final result summary',
              findings: [
                {
                  severity: 'medium',
                  file: 'src/demo.ts',
                  title: '最终结果问题',
                  detail: '完整 result 比 turn fallback 更可信。',
                  suggestion: '优先采用最终结构化输出。',
                },
              ],
              suggestions: ['修复后重新触发审查。'],
              recommended_block: true,
              raw_report_markdown:
                '这是一段过期的 JSON 内嵌报告，不应覆盖分隔符后的完整正文。',
            }),
            '---REVIEW_BODY---',
            '## 代码审查报告',
            '',
            '### 一、审查总结',
            '完整结果应覆盖 earlier assistant fallback。',
            '',
            '### 三、中风险问题',
            '🟡 [逻辑漏洞] 最终结果问题',
          ].join('\n'),
        });
        await onOutput?.({
          turnEvent: {
            type: 'turn.completed',
            turnId: 'turn-review-final-result-wins',
            timestamp: '2026-04-22T10:00:01.000Z',
          },
        });
        return {
          status: 'success',
          result: null,
        };
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-final-result-wins',
      name: 'Repo Final Result Wins',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-final-result-wins',
      repository_id: repository.id,
      name: 'Commit Final Result Wins',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs[0]?.run.overall).toBe('fail');
    expect(result.runs[0]?.run.summary).toBe('final result summary');
    expect(result.runs[0]?.run.markdownBody).toContain('### 一、审查总结');
    expect(result.runs[0]?.run.markdownBody).toContain('最终结果问题');
    expect(result.runs[0]?.run.markdownBody).not.toContain('过期的 JSON 内嵌报告');
  });

  it('accepts raw_report_markdown inside the final structured repo review result', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'fail',
        summary: 'final result summary',
        findings: [
          {
            severity: 'medium',
            file: 'src/demo.ts',
            title: '最终结果问题',
            detail: '结构化结果中直接携带报告正文。',
            suggestion: '优先消费 raw_report_markdown。',
          },
        ],
        suggestions: ['修复后重新触发审查。'],
        recommended_block: true,
        raw_report_markdown: [
          '## 代码审查报告',
          '',
          '### 一、审查总结',
          '报告正文已经放进 JSON 字段。',
        ].join('\n'),
      }),
    });

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-raw-report-markdown',
      name: 'Repo Raw Report Markdown',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-raw-report-markdown',
      repository_id: repository.id,
      name: 'Commit Raw Report Markdown',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs[0]?.run.summary).toBe('final result summary');
    expect(result.runs[0]?.run.markdownBody).toContain('报告正文已经放进 JSON 字段');
    expect(result.runs[0]?.run.rawModelOutput).toContain('"raw_report_markdown"');
  });

  it('accepts markdown_body inside the final structured repo review result', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'warn',
        summary: 'final result summary',
        findings: [],
        suggestions: ['把 markdown_body 直接作为主报告正文。'],
        recommended_block: false,
        markdown_body: [
          '## 代码审查报告',
          '',
          '### 一、审查总结',
          '报告正文已经放进 markdown_body 字段。',
        ].join('\n'),
      }),
    });

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-markdown-body',
      name: 'Repo Markdown Body',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-markdown-body',
      repository_id: repository.id,
      name: 'Commit Markdown Body',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs[0]?.run.summary).toBe('final result summary');
    expect(result.runs[0]?.run.markdownBody).toContain('markdown_body 字段');
    expect(result.runs[0]?.run.rawModelOutput).toContain('"markdown_body"');
  });

  it('parses raw markdown review output through the extractor fallback', async () => {
    const rawMarkdown = [
      '## 代码审查报告',
      '',
      '### 一、审查总结',
      '发现一个中风险问题，但模型没有按 JSON 协议输出。',
      '',
      '### 三、中风险问题',
      '- `src/demo.ts`: 错误处理分支遗漏。',
      '文件：src/demo.ts',
      '证据：异常分支只记录日志，没有把失败状态返回给调用方。',
      '影响：调用方会把失败流程误判为成功。',
      '',
      'src/demo.ts:10-12',
      '```diff',
      ' try {',
      '-  return await save();',
      '+  return await save().catch(toFailure);',
      ' } catch (err) {',
      '   console.error(err);',
      ' }',
      '```',
      '修复建议：返回显式失败结果或重新抛出异常。',
      '风险等级：中风险',
    ].join('\n');
    mockRunAgentProcess
      .mockResolvedValueOnce(
        buildAgenticPlanMockResult([], {
          shouldDelegate: false,
          delegationReason: '主代理独立完成审查。',
        }),
      )
      .mockResolvedValueOnce({
        status: 'success',
        result: rawMarkdown,
      })
      .mockResolvedValueOnce({
        status: 'success',
        result: rawMarkdown,
      });

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-raw-markdown-fallback',
      name: 'Repo Raw Markdown Fallback',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-raw-markdown-fallback',
      repository_id: repository.id,
      name: 'Commit Raw Markdown Fallback',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      diff_subagent_threshold: 0,
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs[0]?.run.overall).toBe('warn');
    expect(result.runs[0]?.run.summary).toBe(
      '发现一个中风险问题，但模型没有按 JSON 协议输出。',
    );
    expect(result.runs[0]?.run.markdownBody).toContain('### 一、审查总结');
    expect(result.runs[0]?.run.rawModelOutput).toBe(rawMarkdown);
    expect(result.runs[0]?.run.findings[0]).toEqual(
      expect.objectContaining({
        severity: 'medium',
        file: 'src/demo.ts',
        title: '错误处理分支遗漏。',
        detail: expect.stringContaining('证据：异常分支只记录日志'),
      }),
    );
    expect(result.runs[0]?.run.findings[0]?.detail).toContain(
      '影响：调用方会把失败流程误判为成功。',
    );
    expect(result.runs[0]?.run.findings).toHaveLength(1);
    expect(result.runs[0]?.run.findings[0]?.detail).toContain('```diff');
    expect(result.runs[0]?.run.findings[0]?.detail).toContain('-  return await save();');
    expect(mockRunAgentProcess).toHaveBeenCalledTimes(2);
  });

  it('synthesizes a detailed markdown review body when structured output omits raw_report_markdown', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'warn',
        summary: '发现 1 个中风险问题，建议修复后再合并。',
        findings: [
          {
            severity: 'medium',
            file: 'src/demo.ts',
            title: '缓存命中路径漏字段',
            detail: '缓存命中时直接返回旧对象，新增字段没有补齐。',
            suggestion: '缓存写入和命中返回都补齐新增字段。',
          },
        ],
        suggestions: ['先修复缓存字段缺口，再重新触发审查。'],
        commit_reviews: [
          {
            commit: 'abc1234',
            title: 'fix cache path',
            author: 'alice',
            positives: ['修复方向清晰，范围集中。'],
            issues: [],
          },
        ],
        recommended_block: false,
      }),
    });

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-structured-markdown-synth',
      name: 'Repo Structured Markdown Synth',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-structured-markdown-synth',
      repository_id: repository.id,
      name: 'Commit Structured Markdown Synth',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs[0]?.run.summary).toContain('中风险问题');
    expect(result.runs[0]?.run.markdownBody).toContain('代码审查报告');
    expect(result.runs[0]?.run.markdownBody).toContain('一、审查总结');
    expect(result.runs[0]?.run.markdownBody).toContain('三、中风险问题');
    expect(result.runs[0]?.run.markdownBody).toContain('缓存命中路径漏字段');
    expect(result.runs[0]?.run.markdownBody).toContain('五、代码亮点');
  });

  it('keeps structured repo review output internal while surfacing only visible progress events', async () => {
    const notifyTurnEvent = vi.fn();
    const sendStreamChunk = vi.fn();
    mockGetWebChannel.mockReturnValue({
      notifyMessage: vi.fn(),
      notifyTurnEvent,
      sendStreamChunk,
      notifyApprovalRequest: vi.fn(),
      notifyApprovalResolved: vi.fn(),
    });
    mockRunAgentProcess.mockImplementation(
      async (_group, _input, onProcess, onOutput) => {
        const stdinEnd = vi.fn();
        onProcess?.({
          stdin: {
            destroyed: false,
            writableEnded: false,
            end: stdinEnd,
          },
        });
        await onOutput?.({
          turnEvent: {
            type: 'turn.started',
            turnId: 'turn-review-visible-progress',
            timestamp: '2026-03-25T10:03:00.000Z',
          },
        });
        await onOutput?.({
          turnEvent: {
            type: 'item.completed',
            turnId: 'turn-review-visible-progress',
            timestamp: '2026-03-25T10:03:01.000Z',
            item: {
              id: 'turn-review-visible-progress:assistant:1',
              type: 'assistant_message',
              status: 'completed',
              text: JSON.stringify({
                overall: 'fail',
                summary: 'assistant fallback wins',
                findings: [],
                suggestions: [],
                recommended_block: true,
              }),
              timestamp: '2026-03-25T10:03:01.000Z',
            },
          },
        });
        await onOutput?.({
          streamChunk: '{"overall":"fail","summary":"half',
        });
        await onOutput?.({
          status: 'success',
          result: '{"overall":"fail","summary":"half',
        });
        await onOutput?.({
          turnEvent: {
            type: 'turn.failed',
            turnId: 'turn-review-visible-progress',
            timestamp: '2026-03-25T10:03:02.000Z',
            error: 'terminated',
          },
        });
        return {
          status: 'error',
          result: null,
          error: 'Agent exited with code 1: terminated',
        };
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-review-visible-progress',
      name: 'Repo Review Visible Progress',
      local_repo_path: tempRepo,
      reviewChatJid: 'repo-review:repo-review-visible-progress',
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-review-visible-progress',
      repository_id: repository.id,
      name: 'Push Visible Progress',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    expect(result.runs[0]?.run.summary).toBe('assistant fallback wins');
    expect(notifyTurnEvent.mock.calls.map((call) => call[1]?.type)).toEqual([
      'turn.started',
      'item.completed',
      'turn.completed',
    ]);
    expect(notifyTurnEvent.mock.calls[1]?.[1]).toMatchObject({
      type: 'item.completed',
      item: {
        type: 'assistant_message',
        text: expect.stringContaining('AI 审查阶段结果'),
      },
    });
    expect(notifyTurnEvent.mock.calls[1]?.[1]?.item?.text).not.toContain(
      '{"overall"',
    );
    expect(sendStreamChunk).not.toHaveBeenCalled();
  });

  it('finishes repo review when the agent emits a final result before process exit', async () => {
    const stdinEnd = vi.fn();
    const kill = vi.fn();
    mockRunAgentProcess.mockImplementation(
      async (_group, _input, onProcess, onOutput) => {
        onProcess?.({
          killed: false,
          kill,
          stdin: {
            destroyed: false,
            writableEnded: false,
            end: stdinEnd,
          },
        });
        await onOutput?.({
          status: 'success',
          result: JSON.stringify({
            overall: 'pass',
            summary: 'final result arrived before process exit',
            findings: [],
            suggestions: [],
            recommended_block: false,
          }),
        });
        return new Promise(() => {});
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-review-early-final-result',
      name: 'Repo Review Early Final Result',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-review-early-final-result',
      repository_id: repository.id,
      name: 'Push Early Final Result',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    expect(result.runs[0]?.run.status).toBe('completed');
    expect(result.runs[0]?.run.summary).toBe('final result arrived before process exit');
    expect(mockRequestAgentClose).toHaveBeenCalledTimes(1);
    expect(stdinEnd).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('salvages repo review from final assistant turn text even if agent exits with error', async () => {
    mockRunAgentProcess.mockImplementation(
      async (_group, _input, onProcess, onOutput) => {
        const stdinEnd = vi.fn();
        onProcess?.({
          stdin: {
            destroyed: false,
            writableEnded: false,
            end: stdinEnd,
          },
        });
        await onOutput?.({
          status: 'success',
          result: null,
          turnEvent: {
            type: 'item.completed',
            turnId: 'turn-review-error-fallback',
            timestamp: '2026-03-24T09:20:32.000Z',
            item: {
              id: 'turn-review-error-fallback:assistant:1',
              type: 'assistant_message',
              status: 'completed',
              text: JSON.stringify({
                overall: 'pass',
                summary: 'error fallback ok',
                findings: [],
                suggestions: [],
                recommended_block: false,
              }),
              timestamp: '2026-03-24T09:20:32.000Z',
            },
          },
        });
        return {
          status: 'error',
          result: null,
          error: 'Agent exited with code 1: terminated',
        };
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-turn-error-fallback',
      name: 'Repo Turn Error Fallback',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-turn-error-fallback',
      repository_id: repository.id,
      name: 'Commit Turn Error Fallback',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.run.overall).toBe('pass');
    expect(result.runs[0]?.run.summary).toBe('error fallback ok');
    expect(result.runs[0]?.run.status).toBe('completed');
  });

  it('does not mark review failed when the child remains alive after final useful turn output', async () => {
    mockRunAgentProcess.mockImplementation(
      async (_group, _input, onProcess, onOutput) => {
        const stdinEnd = vi.fn(function (this: { writableEnded: boolean }) {
          this.writableEnded = true;
        });
        onProcess?.({
          stdin: {
            destroyed: false,
            writableEnded: false,
            end: stdinEnd,
          },
        });
        await onOutput?.({
          status: 'success',
          result: null,
          turnEvent: {
            type: 'item.completed',
            turnId: 'turn-review-late-close',
            timestamp: '2026-03-25T12:20:32.000Z',
            item: {
              id: 'turn-review-late-close:assistant:1',
              type: 'assistant_message',
              status: 'completed',
              text: JSON.stringify({
                overall: 'pass',
                summary: 'late child shutdown ok',
                findings: [],
                suggestions: [],
                recommended_block: false,
              }),
              timestamp: '2026-03-25T12:20:32.000Z',
            },
          },
        });
        await onOutput?.({
          status: 'success',
          result: null,
          turnEvent: {
            type: 'turn.completed',
            turnId: 'turn-review-late-close',
            timestamp: '2026-03-25T12:20:33.000Z',
          },
        });
        expect(mockRequestAgentClose).toHaveBeenCalledTimes(1);
        expect(stdinEnd).toHaveBeenCalledTimes(1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          status: 'error',
          result: null,
          error: 'Agent exited with code 137: terminated after close request',
        };
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-turn-late-close',
      name: 'Repo Turn Late Close',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-turn-late-close',
      repository_id: repository.id,
      name: 'Commit Late Close',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.run.status).toBe('completed');
    expect(result.runs[0]?.run.overall).toBe('pass');
    expect(result.runs[0]?.run.summary).toBe('late child shutdown ok');
  });

  it('does not salvage an incomplete assistant turn when the review agent exits with error', async () => {
    mockRunAgentProcess.mockImplementation(
      async (_group, _input, onProcess, onOutput) => {
        const stdinEnd = vi.fn();
        onProcess?.({
          stdin: {
            destroyed: false,
            writableEnded: false,
            end: stdinEnd,
          },
        });
        await onOutput?.({
          status: 'success',
          result: null,
          turnEvent: {
            type: 'item.updated',
            turnId: 'turn-review-incomplete-json',
            timestamp: '2026-03-25T08:20:32.000Z',
            item: {
              id: 'turn-review-incomplete-json:assistant:1',
              type: 'assistant_message',
              status: 'in_progress',
              text: '{"overall":"warn","summary":"half',
              timestamp: '2026-03-25T08:20:32.000Z',
            },
          },
        });
        return {
          status: 'error',
          result: null,
          error: 'Agent exited with code 1: terminated',
        };
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-turn-incomplete-json',
      name: 'Repo Turn Incomplete JSON',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-turn-incomplete-json',
      repository_id: repository.id,
      name: 'Commit Turn Incomplete JSON',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.run.status).toBe('error');
    expect(result.runs[0]?.run.overall).toBe('error');
    expect(result.runs[0]?.run.summary).toBe('Review execution failed.');
    expect(result.runs[0]?.run.error).toContain('terminated');
  });

  it('persists compact repo review progress snapshots during execution and full turns on completion', async () => {
    let releaseFinalResult: (() => void) | null = null;
    const finalResultGate = new Promise<void>((resolve) => {
      releaseFinalResult = resolve;
    });
    mockRunAgentProcess.mockImplementation(
      async (_group, _input, onProcess, onOutput) => {
        const stdinEnd = vi.fn();
        onProcess?.({
          stdin: {
            destroyed: false,
            writableEnded: false,
            end: stdinEnd,
          },
        });
        await onOutput?.({
          turnEvent: {
            type: 'turn.started',
            turnId: 'turn-progress',
            timestamp: '2026-03-13T01:00:00.000Z',
          },
        });
        await onOutput?.({
          turnEvent: {
            type: 'item.started',
            turnId: 'turn-progress',
            timestamp: '2026-03-13T01:00:01.000Z',
            item: {
              id: 'msg-1',
              type: 'assistant_message',
              status: 'in_progress',
              text: '正在生成审查结论',
              timestamp: '2026-03-13T01:00:01.000Z',
            },
          },
        });
        await onOutput?.({
          turnEvent: {
            type: 'item.completed',
            turnId: 'turn-progress',
            timestamp: '2026-03-13T01:00:02.000Z',
            item: {
              id: 'msg-1',
              type: 'assistant_message',
              status: 'completed',
              text: '最终审查结论：可以合并。',
              timestamp: '2026-03-13T01:00:02.000Z',
            },
          },
        });
        await finalResultGate;
        await onOutput?.({
          status: 'success',
          result: JSON.stringify({
            overall: 'pass',
            summary: '最终审查结论：可以合并。',
            findings: [],
            suggestions: [],
            recommended_block: false,
          }),
        });
        return {
          status: 'success',
          result: null,
        };
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-progress-update',
      name: 'Repo Progress Update',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-progress-update',
      repository_id: repository.id,
      name: 'Commit Progress Update',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const triggerPromise = service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    const inFlightRuns = await service.listRepoReviewRuns(repository.id);
    expect(inFlightRuns).toHaveLength(1);
    const inFlightRun = await service.getRepoReviewRun(inFlightRuns[0]!.id);
    expect(inFlightRun?.reviewTurns ?? []).toHaveLength(1);
    expect(inFlightRun?.reviewTurns[0]?.items[0]).toMatchObject({
      type: 'assistant_message',
      status: 'completed',
      text: '最终审查结论：可以合并。',
    });
    expect(inFlightRun?.reviewProgress).toMatchObject({
      turnCount: 1,
      latestAssistantText: '最终审查结论：可以合并。',
      latestErrorText: null,
      hasTerminalOutput: true,
    });

    releaseFinalResult?.();
    const result = await triggerPromise;

    expect(result.blocked).toBe(false);
    expect(result.runs).toHaveLength(1);
    const progressRun =
      (await service.getRepoReviewRun(result.runs[0]!.run.id)) ??
      result.runs[0]!.run;
    expect(progressRun.reviewProgress).toMatchObject({
      turnCount: 1,
      latestAssistantText: '最终审查结论：可以合并。',
      latestErrorText: null,
      hasTerminalOutput: true,
    });
    expect(progressRun.reviewTurns[0]?.items[0]).toMatchObject({
      type: 'assistant_message',
      status: 'completed',
      text: '最终审查结论：可以合并。',
    });
  });

  it('persists completed main-agent tool-call turns after review completion', async () => {
    runGit(tempRepo, ['commit', '-m', 'base']);
    fs.writeFileSync(
      path.join(tempRepo, 'tool-call.ts'),
      'export const needsReview = true;\n',
      'utf8',
    );
    runGit(tempRepo, ['add', 'tool-call.ts']);

    mockRunAgentProcess.mockImplementationOnce(
      async (_group, _input, onProcess, onOutput) => {
        onProcess?.({
          stdin: {
            destroyed: false,
            writableEnded: false,
            end() {
              this.writableEnded = true;
            },
          },
        });
        await onOutput?.({
          turnEvent: {
            type: 'turn.started',
            turnId: 'turn-tool-call',
            timestamp: '2026-05-11T10:00:00.000Z',
          },
        });
        await onOutput?.({
          turnEvent: {
            type: 'item.completed',
            turnId: 'turn-tool-call',
            timestamp: '2026-05-11T10:00:01.000Z',
            item: {
              id: 'tool-read-file',
              type: 'tool_call',
              status: 'completed',
              title: 'read_file',
              argumentsText: '{"path":"tool-call.ts"}',
              resultText: 'export const needsReview = true;',
              timestamp: '2026-05-11T10:00:01.000Z',
            },
          },
        });
        await onOutput?.({
          status: 'success',
          result: JSON.stringify({
            overall: 'pass',
            summary: '主代理已完成审查。',
            findings: [],
            suggestions: [],
            recommended_block: false,
            markdown_body: '代码审查报告\n\n一、审查总结\n主代理已完成审查。',
          }),
        });
        await onOutput?.({
          turnEvent: {
            type: 'turn.completed',
            turnId: 'turn-tool-call',
            timestamp: '2026-05-11T10:00:02.000Z',
          },
        });
        return {
          status: 'success' as const,
          result: null,
        };
      },
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-tool-call-persist',
      name: 'Repo Tool Call Persist',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-tool-call-persist',
      repository_id: repository.id,
      name: 'Tool Call Persist',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    const persistedRun =
      (await service.getRepoReviewRun(result.runs[0]!.run.id)) ??
      result.runs[0]!.run;
    expect(persistedRun.reviewTurns).toHaveLength(1);
    expect(persistedRun.reviewTurns[0]?.items[0]).toMatchObject({
      type: 'tool_call',
      status: 'completed',
      title: 'read_file',
      argumentsText: '{"path":"tool-call.ts"}',
      resultText: 'export const needsReview = true;',
    });
  });

  it('matches profiles by target branch and treats empty target branches as all branches', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: '通过',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-branch',
      name: 'Repo Branch',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-all',
      repository_id: repository.id,
      name: 'All Branches',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      target_branches: [],
      prompt_template: '默认全部分支',
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-main',
      repository_id: repository.id,
      name: 'Main Only',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      target_branches: ['main'],
      prompt_template: '仅 main',
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-feature',
      repository_id: repository.id,
      name: 'Feature Only',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      target_branches: ['feature/login'],
      prompt_template: '仅 feature/login',
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.profile.id).toBe('profile-main');
  });

  it('does not block push when pass decision mode is human', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'fail',
        summary: 'AI 建议人工重点复核',
        findings: [
          {
            severity: 'high',
            file: 'demo.ts',
            title: '高风险变更',
            detail: '需要人工确认',
          },
        ],
        suggestions: ['请负责人确认'],
        recommended_block: true,
      }),
    });

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-human',
      name: 'Repo Human',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-human',
      repository_id: repository.id,
      name: 'Push Human Gate',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'hard_fail',
      pass_decision_mode: 'human',
      review_scope: 'staged_diff',
      target_branches: [],
      prompt_template: 'AI 给建议，人工决定',
      enabled: true,
    });

    const result = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    expect(result.blocked).toBe(false);
    expect(result.runs[0]?.run.overall).toBe('fail');
    expect(result.runs[0]?.run.blockingEnforced).toBe(false);
  });

  it('binds repo review conversations to the configured repository path', async () => {
    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-review-binding',
      name: 'Repo Review Binding',
      local_repo_path: tempRepo,
      reviewChatJid: 'repo-review:repo-review-binding',
      enabled: true,
    });

    const binding = await service.getRepoReviewConversationBinding(
      repository.reviewChatJid,
    );
    expect(binding?.repositoryId).toBe(repository.id);
    expect(binding?.group.folder).toBe('review-repo-review-binding');
    expect(binding?.group.agentConfig).toMatchObject({
      allowedDirectories: expect.arrayContaining([tempRepo]),
      strictAllowedDirectories: true,
      projectRoot: tempRepo,
      workingDirectory: tempRepo,
    });

    const existingDb = await import('../db.js');
    existingDb.setRegisteredGroup('web:review-chat', {
      name: 'Existing Review Chat',
      folder: 'web_existing_review_chat',
      trigger: '@NanoClaw',
      added_at: '2026-03-13T00:00:00.000Z',
      requiresTrigger: false,
      agentConfig: {
        allowedDirectories: ['/tmp/legacy'],
        timeout: 120000,
      },
    });
    await service.upsertRepoReviewRepository({
      id: 'repo-review-binding-web',
      name: 'Repo Review Binding Web',
      local_repo_path: tempRepo,
      reviewChatJid: 'web:review-chat',
      enabled: true,
    });
    const webBinding =
      await service.getRepoReviewConversationBinding('web:review-chat');
    expect(webBinding?.group.folder).toBe('web_existing_review_chat');
    expect(webBinding?.group.agentConfig).toMatchObject({
      allowedDirectories: expect.arrayContaining([tempRepo]),
      strictAllowedDirectories: true,
      projectRoot: tempRepo,
      workingDirectory: tempRepo,
      timeout: 120000,
    });
  });

  it('allows binding the same review chat to multiple repositories', async () => {
    const service = await import('./repo-review-service.js');
    const { listReviewConversationBindingsByChatJid } = await import('../db/review.js');

    await service.upsertRepoReviewRepository({
      id: 'repo-binding-a',
      name: 'Repo Binding A',
      local_repo_path: tempRepo,
      reviewChatJid: 'web:shared-review-chat',
      enabled: true,
    });

    await service.upsertRepoReviewRepository({
      id: 'repo-binding-b',
      name: 'Repo Binding B',
      local_repo_path: tempRepo,
      reviewChatJid: 'web:shared-review-chat',
      enabled: true,
    });

    const bindings = await listReviewConversationBindingsByChatJid('web:shared-review-chat');
    expect(bindings).toHaveLength(2);
    const ids = bindings.map((b) => b.repository_id).sort();
    expect(ids).toEqual(['repo-binding-a', 'repo-binding-b']);
  });

  it('allows human reviewers to finalize a push review as pass or fail', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'fail',
        summary: 'AI 建议人工重点复核',
        findings: [
          {
            severity: 'high',
            file: 'demo.ts',
            title: '高风险变更',
            detail: '需要负责人确认',
          },
        ],
        suggestions: ['请负责人确认是否放行'],
        recommended_block: true,
      }),
    });

    const service = await import('./repo-review-service.js');
    const sender = vi.fn().mockResolvedValue(undefined);
    service.setRepoReviewMessageSender(sender);

    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-human-finalize',
      name: 'Repo Human Finalize',
      local_repo_path: tempRepo,
      reviewChatJid: 'feishu:test-chat',
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-human-finalize',
      repository_id: repository.id,
      name: 'Push Human Finalize',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'hard_fail',
      pass_decision_mode: 'human',
      review_scope: 'staged_diff',
      write_to_chat: true,
      write_to_platform: false,
      enabled: true,
    });

    const trigger = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });
    const runId = trigger.runs[0]?.run.id;
    expect(runId).toBeTruthy();

    const passed = await service.decideRepoReviewRunByHuman({
      runId: runId!,
      decision: 'pass',
      decidedBy: 'reviewer-a',
    });
    expect(passed.manualDecision).toBe('pass');
    expect(passed.manualDecisionBy).toBe('reviewer-a');
    expect(passed.manualDecisionAt).toBeTruthy();
    expect(passed.resultState).toBe('manual_passed');
    expect(sender).toHaveBeenCalledWith(
      'feishu:test-chat',
      expect.objectContaining({
        text: expect.stringContaining('最终结论: 人工通过'),
      }),
    );

    const repositoryFail = await service.upsertRepoReviewRepository({
      id: 'repo-human-finalize-fail',
      name: 'Repo Human Finalize Fail',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-human-finalize-fail',
      repository_id: repositoryFail.id,
      name: 'Push Human Finalize Fail',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'hard_fail',
      pass_decision_mode: 'human',
      review_scope: 'staged_diff',
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const triggerFail = await service.triggerLocalRepoReview({
      repositoryId: repositoryFail.id,
      stage: 'push',
    });
    const failed = await service.decideRepoReviewRunByHuman({
      runId: triggerFail.runs[0]!.run.id,
      decision: 'fail',
      decidedBy: 'reviewer-b',
    });
    expect(failed.manualDecision).toBe('fail');
    expect(failed.manualDecisionBy).toBe('reviewer-b');
    expect(failed.resultState).toBe('manual_failed');

    service.setRepoReviewMessageSender(null);
  }, 15000);

  it('restricts manual decisions to configured reviewers', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'fail',
        summary: '需要负责人确认',
        findings: [],
        suggestions: [],
        recommended_block: true,
      }),
    });

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-human-reviewers',
      name: 'Repo Human Reviewers',
      local_repo_path: tempRepo,
      reviewerUsernames: ['lead-a', 'owner-b'],
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-human-reviewers',
      repository_id: repository.id,
      name: 'Push Human Reviewers',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'hard_fail',
      pass_decision_mode: 'human',
      review_scope: 'staged_diff',
      enabled: true,
    });

    const trigger = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'push',
    });

    await expect(
      service.decideRepoReviewRunByHuman({
        runId: trigger.runs[0]!.run.id,
        decision: 'pass',
        decidedBy: 'guest-user',
      }),
    ).rejects.toThrow(service.REPO_REVIEW_PERMISSION_DENIED_MESSAGE);
  });

  it('rejects human final decisions for unsupported runs', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: '通过',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-human-invalid',
      name: 'Repo Human Invalid',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-human-invalid',
      repository_id: repository.id,
      name: 'Commit Profile',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      enabled: true,
    });

    const commitTrigger = await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
    });
    await expect(
      service.decideRepoReviewRunByHuman({
        runId: commitTrigger.runs[0]!.run.id,
        decision: 'pass',
        decidedBy: 'reviewer-a',
      }),
    ).rejects.toThrow('只有 push 阶段支持人工最终判定');

    const repositoryPush = await service.upsertRepoReviewRepository({
      id: 'repo-human-running',
      name: 'Repo Human Running',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-human-running',
      repository_id: repositoryPush.id,
      name: 'Push Human Running',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'hard_fail',
      pass_decision_mode: 'human',
      review_scope: 'staged_diff',
      enabled: true,
    });

    const db = await import('../db.js');
    const runningRecord = await db.createReviewRun({
      id: 'run-human-running',
      repository_id: repositoryPush.id,
      profile_id: 'profile-human-running',
      source: 'local-hook',
      stage: 'push',
      status: 'running',
    });

    await expect(
      service.decideRepoReviewRunByHuman({
        runId: runningRecord.id,
        decision: 'fail',
        decidedBy: 'reviewer-b',
      }),
    ).rejects.toThrow('审查仍在执行中');
  });

  it('persists repository auto sync settings and clears next run when disabled', async () => {
    const service = await import('./repo-review-service.js');

    const enabledRepo = await service.upsertRepoReviewRepository({
      id: 'repo-auto-sync',
      name: 'Repo Auto Sync',
      local_repo_path: tempRepo,
      remote_provider: 'gitea',
      remote_repo_slug: 'team/repo',
      clone_url: 'https://gitea.example.com/team/repo.git',
      platform_token: 'token',
      auto_sync_enabled: true,
      auto_sync_interval_minutes: 15,
      enabled: true,
    });

    expect(enabledRepo.autoSyncEnabled).toBe(true);
    expect(enabledRepo.autoSyncIntervalMinutes).toBe(15);
    expect(enabledRepo.nextAutoSyncAt).not.toBe('');

    const disabledRepo = await service.upsertRepoReviewRepository({
      id: enabledRepo.id,
      name: enabledRepo.name,
      auto_sync_enabled: false,
      enabled: true,
    });

    expect(disabledRepo.autoSyncEnabled).toBe(false);
    expect(disabledRepo.nextAutoSyncAt).toBe('');
  });

  it('deduplicates target branches and actor mention mappings on save', async () => {
    const service = await import('./repo-review-service.js');

    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-normalize',
      name: 'Repo Normalize',
      local_repo_path: tempRepo,
      actorMentionMappings: [
        {
          actor: 'alice',
          channel: 'feishu',
          id: 'ou_first',
          name: 'Alice',
        },
        {
          actor: 'ALICE',
          channel: 'feishu',
          id: 'ou_second',
          name: 'Alice Dup',
        },
        {
          actor: 'bob',
          channel: 'feishu',
          id: 'ou_bob',
          name: '',
        },
      ],
      enabled: true,
    });

    const profile = await service.upsertRepoReviewProfile({
      id: 'profile-normalize',
      repository_id: repository.id,
      name: 'Push Normalize',
      stage: 'push',
      source_mode: 'remote',
      blocking_mode: 'soft_fail',
      target_branches: ['main', 'main', 'release', 'release'],
      skill_ids: ['skill-a', 'skill-a', 'skill-b'],
      include_globs: ['src/**/*.ts', 'src/**/*.ts'],
      exclude_globs: ['**/*.snap', '**/*.snap'],
      enabled: true,
    });

    expect(repository.actorMentionMappings).toEqual([
      {
        actor: 'alice',
        channel: 'feishu',
        id: 'ou_first',
        name: 'Alice',
      },
      {
        actor: 'bob',
        channel: 'feishu',
        id: 'ou_bob',
        name: 'bob',
      },
    ]);
    expect(profile.targetBranches).toEqual(['main', 'release']);
    expect(profile.skillIds).toEqual(['skill-a', 'skill-b']);
    expect(profile.includeGlobs).toEqual(['src/**/*.ts']);
    expect(profile.excludeGlobs).toEqual(['**/*.snap']);
  });

  it('persists review profile provider overrides and prioritizes them over module defaults', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: 'profile provider ok',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });

    const service = await import('./repo-review-service.js');
    const { createProvider } = await import('../db/assistants.js');
    const { setTenantConfig } = await import('../tenant/tenant-db.js');

    await createProvider({
      id: 'provider-profile-override',
      alias: 'Profile Override',
      type: 'openai',
      api_key: 'sk-profile',
      base_url: 'https://api.example.com',
      model: 'gpt-4.1',
      extra_config: null,
      is_default: 0,
      user_id: 'test-user',
      visibility: 'private',
      created_by: 'test-user',
      updated_by: 'test-user',
    });
    await createProvider({
      id: 'provider-module-default',
      alias: 'Module Default',
      type: 'openai',
      api_key: 'sk-module',
      base_url: 'https://api.example.com',
      model: 'gpt-4.1-mini',
      extra_config: null,
      is_default: 0,
      user_id: 'test-user',
      visibility: 'private',
      created_by: 'test-user',
      updated_by: 'test-user',
    });
    await setTenantConfig(
      'test-user',
      'DEFAULT_PROVIDER_code_review',
      'provider-module-default',
    );

    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-profile-provider',
      name: 'Repo Profile Provider',
      local_repo_path: tempRepo,
      enabled: true,
    });
    const profile = await service.upsertRepoReviewProfile({
      id: 'profile-provider-override',
      repository_id: repository.id,
      name: 'Commit Review',
      stage: 'commit',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      review_scope: 'staged_diff',
      skill_ids: [],
      mcp_server_ids: [],
      include_globs: [],
      exclude_globs: [],
      max_files: 20,
      max_diff_bytes: 50000,
      write_to_chat: false,
      write_to_platform: false,
      provider_id: 'provider-profile-override',
      enabled: true,
    });

    expect(profile.provider_id).toBe('provider-profile-override');

    await service.triggerLocalRepoReview({
      repositoryId: repository.id,
      stage: 'commit',
      userId: 'test-user',
    });

    expect(mockRunAgentProcess).toHaveBeenCalledTimes(1);
    expect(mockRunAgentProcess.mock.calls[0]?.[1]).toMatchObject({
      userId: 'test-user',
      providerOverrideId: 'provider-profile-override',
    });
  });

  it('syncs only active remote branches when any push profile targets all branches', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'));
    try {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: '通过',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === 'https://api.github.com/repos/team/repo') {
          return new Response(JSON.stringify({ default_branch: 'main' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (
          url === 'https://api.github.com/repos/team/repo/branches?per_page=100'
        ) {
          return new Response(
            JSON.stringify([
              { name: 'main' },
              { name: 'feature/login' },
              { name: 'legacy/archive' },
            ]),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
        if (
          url ===
            'https://api.github.com/repos/team/repo/commits?sha=main&per_page=1' ||
          url ===
            'https://api.github.com/repos/team/repo/commits?sha=feature%2Flogin&per_page=1' ||
          url ===
            'https://api.github.com/repos/team/repo/commits?sha=legacy%2Farchive&per_page=1' ||
          url ===
            'https://api.github.com/repos/team/repo/commits?sha=main&per_page=10' ||
          url ===
            'https://api.github.com/repos/team/repo/commits?sha=feature%2Flogin&per_page=10' ||
          url ===
            'https://api.github.com/repos/team/repo/commits?sha=legacy%2Farchive&per_page=10'
        ) {
          const branch = url.includes('feature%2Flogin')
            ? 'feature/login'
            : url.includes('legacy%2Farchive')
              ? 'legacy/archive'
              : 'main';
          return new Response(
            JSON.stringify([
              {
                sha:
                  branch === 'main'
                    ? '1111111111111111111111111111111111111111'
                    : branch === 'feature/login'
                      ? '2222222222222222222222222222222222222222'
                      : '3333333333333333333333333333333333333333',
                parents: [
                  {
                    sha:
                      branch === 'main'
                        ? '0000000000000000000000000000000000000000'
                        : branch === 'feature/login'
                          ? '1111111111111111111111111111111111111111'
                          : '2222222222222222222222222222222222222222',
                  },
                ],
                author: { login: 'alice' },
                commit: {
                  message:
                    branch === 'main'
                      ? 'main commit'
                      : branch === 'feature/login'
                        ? 'feature login commit'
                        : 'legacy archive commit',
                  author: {
                    name: 'alice',
                    date:
                      branch === 'legacy/archive'
                        ? '2020-01-01T10:00:00Z'
                        : '2026-04-22T10:00:00Z',
                  },
                },
              },
            ]),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
        if (
          url.includes(
            '/compare/0000000000000000000000000000000000000000...1111111111111111111111111111111111111111',
          ) ||
          url.includes(
            '/compare/1111111111111111111111111111111111111111...1111111111111111111111111111111111111111',
          ) ||
          url.includes(
            '/compare/1111111111111111111111111111111111111111...2222222222222222222222222222222222222222',
          )
        ) {
          return new Response(
            JSON.stringify({
              files: [
                {
                  filename: 'demo.ts',
                  patch: '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;',
                },
              ],
              commits: [],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
        if (url.includes('/contents/')) {
          return new Response('', { status: 404 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-remote-all-branches',
      name: 'Repo Remote All Branches',
      local_repo_path: tempRepo,
      remote_provider: 'github',
      remote_repo_slug: 'team/repo',
      platform_token: 'token',
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-remote-all',
      repository_id: repository.id,
      name: 'Remote All Branches',
      stage: 'push',
      source_mode: 'remote',
      blocking_mode: 'soft_fail',
      target_branches: [],
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-remote-main',
      repository_id: repository.id,
      name: 'Remote Main Only',
      stage: 'push',
      source_mode: 'remote',
      blocking_mode: 'soft_fail',
      target_branches: ['main'],
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    const result = await service.syncRemoteRepoReview({
      repositoryId: repository.id,
    });

    expect(result.branches).toHaveLength(3);
    expect(result.branches.map((entry) => entry.branch).sort()).toEqual([
      'feature/login',
      'legacy/archive',
      'main',
    ]);
    expect(
      result.branches
        .filter((entry) => entry.status === 'triggered')
        .map((entry) => entry.branch),
    ).toEqual(['main', 'feature/login']);
    expect(
      result.branches.find((entry) => entry.branch === 'legacy/archive'),
    ).toMatchObject({
      status: 'skipped',
      reason: '该分支不在最近 14 天活跃窗口内',
    });
    expect(result.summary).toMatchObject({
      triggered: 2,
      skipped: 1,
      failed: 0,
      activeWindowDays: 14,
    });
    } finally {
    vi.useRealTimers();
    }
  });

  it('syncs remote reviews through local git without platform api access', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: '本地 git 远端审查通过',
        findings: [],
        suggestions: ['关注异常处理'],
        recommended_block: false,
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          'fetch should not be called when local git fallback is available',
        );
      }),
    );

    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-remote-bare-'),
    );
    try {
      runGit(remoteBare, ['init', '--bare']);

      runGit(tempRepo, ['commit', '-m', 'main base']);
      fs.writeFileSync(
        path.join(tempRepo, 'demo.ts'),
        'const a = 2;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'demo.ts']);
      runGit(tempRepo, ['commit', '-m', 'main second']);
      runGit(tempRepo, ['remote', 'add', 'company', remoteBare]);
      runGit(tempRepo, ['push', 'company', 'main']);
      runGit(remoteBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      runGit(tempRepo, ['checkout', '-b', 'feature/login']);
      fs.writeFileSync(
        path.join(tempRepo, 'feature.ts'),
        'export const login = true;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'feature.ts']);
      runGit(tempRepo, ['commit', '-m', 'feature login']);
      runGit(tempRepo, ['push', 'company', 'feature/login']);
      runGit(tempRepo, ['checkout', 'main']);
      runGit(tempRepo, ['fetch', '--prune', 'company']);

      const service = await import('./repo-review-service.js');
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-local-remote-fallback',
        name: 'Repo Local Remote Fallback',
        local_repo_path: tempRepo,
        remote_provider: 'gitlab',
        clone_url: normalizeGitLocalPath(remoteBare),
        default_target_branch: 'main',
        enabled: true,
        auto_sync_enabled: true,
      });
      await service.upsertRepoReviewProfile({
        id: 'profile-local-remote-fallback',
        repository_id: repository.id,
        name: 'Remote Fallback',
        stage: 'push',
        source_mode: 'remote',
        blocking_mode: 'soft_fail',
        target_branches: [],
        write_to_chat: false,
        write_to_platform: false,
        enabled: true,
      });

      const branches = await service.listRepoReviewRemoteBranches(
        repository.id,
        { force: true },
      );
      expect(branches.map((entry) => entry.name).sort()).toEqual([
        'feature/login',
        'main',
      ]);
      expect(branches.every((entry) => !!entry.latestCommitAt)).toBe(true);

      const result = await service.syncRemoteRepoReview({
        repositoryId: repository.id,
      });
      expect(result.branches).toHaveLength(2);
      expect(result.branches.map((entry) => entry.branch).sort()).toEqual([
        'feature/login',
        'main',
      ]);
      expect(
        result.branches.every((entry) => entry.status === 'triggered'),
      ).toBe(true);

      const runs = await service.listRepoReviewRuns(repository.id);
      expect(runs).toHaveLength(2);
      expect(runs.every((run) => run.status === 'completed')).toBe(true);
      const workspaceMounts = mockRunAgentProcess.mock.calls
        .map((call) => String(call[1]?.extraMounts?.[0]?.hostPath || ''))
        .filter(Boolean);
      expect(workspaceMounts).not.toHaveLength(0);
      expect(
        workspaceMounts.every((workspacePath) =>
          workspacePath.includes(`${path.sep}review-workspaces${path.sep}`),
        ),
      ).toBe(true);
      expect(
        workspaceMounts.some((workspacePath) =>
          path.basename(workspacePath).startsWith('nanoclaw-review-remote-'),
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(remoteBare, { recursive: true, force: true });
    }
  }, 30000);

  it('caches remote branch summaries between repeated list requests', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === 'https://api.github.com/repos/owner/repo') {
        return new Response(JSON.stringify({ default_branch: 'main' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (
        url === 'https://api.github.com/repos/owner/repo/branches?per_page=100'
      ) {
        return new Response(
          JSON.stringify([{ name: 'main' }, { name: 'feature/login' }]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (
        url ===
        'https://api.github.com/repos/owner/repo/commits?sha=main&per_page=1'
      ) {
        return new Response(
          JSON.stringify([
            {
              sha: 'aaaaaaaaaaaaaaaa',
              parents: [{ sha: '9999999999999999' }],
              author: { login: 'alice' },
              commit: {
                message: 'main commit',
                author: { name: 'Alice', date: '2026-03-17T10:00:00.000Z' },
              },
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (
        url ===
        'https://api.github.com/repos/owner/repo/commits?sha=feature%2Flogin&per_page=1'
      ) {
        return new Response(
          JSON.stringify([
            {
              sha: 'bbbbbbbbbbbbbbbb',
              parents: [{ sha: 'aaaaaaaaaaaaaaaa' }],
              author: { login: 'bob' },
              commit: {
                message: 'feature commit',
                author: { name: 'Bob', date: '2026-03-17T11:00:00.000Z' },
              },
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-remote-branch-cache',
      name: 'Repo Remote Branch Cache',
      remote_provider: 'github',
      remote_repo_slug: 'owner/repo',
      platform_token: 'github_pat_test',
      enabled: true,
    });

    const first = await service.listRepoReviewRemoteBranches(repository.id);
    const second = await service.listRepoReviewRemoteBranches(repository.id);
    const db = await import('../db.js');
    const persistedCache = await db.getReviewRemoteBranchCache(repository.id);

    expect(first.map((entry) => entry.name)).toEqual(['main', 'feature/login']);
    expect(second.map((entry) => entry.name)).toEqual([
      'main',
      'feature/login',
    ]);
    expect(persistedCache).toBeTruthy();
    expect(
      (await db.parseReviewRemoteBranchCacheRecord(persistedCache!)).branches.map(
        (entry) => (entry as { name?: string }).name,
      ),
    ).toEqual(['main', 'feature/login']);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await service.listRepoReviewRemoteBranches(repository.id, { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('reuses cached remote branch summaries for manual single-branch review triggers', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === 'https://api.github.com/repos/owner/repo') {
        return new Response(JSON.stringify({ default_branch: 'main' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (
        url === 'https://api.github.com/repos/owner/repo/branches?per_page=100'
      ) {
        return new Response(
          JSON.stringify([{ name: 'main' }, { name: 'feature/login' }]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (
        url ===
        'https://api.github.com/repos/owner/repo/commits?sha=main&per_page=1'
      ) {
        return new Response(
          JSON.stringify([
            {
              sha: 'aaaaaaaaaaaaaaaa',
              parents: [{ sha: '9999999999999999' }],
              author: { login: 'alice' },
              commit: {
                message: 'main commit',
                author: { name: 'Alice', date: '2026-03-17T10:00:00.000Z' },
              },
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (
        url ===
        'https://api.github.com/repos/owner/repo/commits?sha=feature%2Flogin&per_page=1'
      ) {
        return new Response(
          JSON.stringify([
            {
              sha: 'bbbbbbbbbbbbbbbb',
              parents: [{ sha: 'aaaaaaaaaaaaaaaa' }],
              author: { login: 'bob' },
              commit: {
                message: 'feature commit',
                author: { name: 'Bob', date: '2026-03-17T11:00:00.000Z' },
              },
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-manual-trigger-cache-hit',
      name: 'Repo Manual Trigger Cache Hit',
      remote_provider: 'github',
      remote_repo_slug: 'owner/repo',
      platform_token: 'github_pat_test',
      enabled: true,
    });
    const autoProfiles = await service.listRepoReviewProfiles(repository.id);
    for (const profile of autoProfiles) {
      await service.removeRepoReviewProfile(profile.id);
    }

    await service.listRepoReviewRemoteBranches(repository.id);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const result = await service.triggerRemoteBranchReview({
      repositoryId: repository.id,
      branch: 'feature/login',
    });

    expect(result.usedCachedBranchSummary).toBe(true);
    expect(result.run.status).toBe('skipped');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reuses gitlab branch list commit payloads for remote branch summaries', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (
        url ===
        'https://gitlab.example.com/api/v4/projects/group%2Frepo/repository/branches?per_page=100'
      ) {
        return new Response(
          JSON.stringify([
            {
              name: 'main',
              default: true,
              commit: {
                id: 'aaaaaaaaaaaaaaaa',
                parent_ids: ['9999999999999999'],
                author_name: 'Alice',
                title: 'main commit',
                committed_date: '2026-03-17T10:00:00.000Z',
              },
            },
            {
              name: 'feature/login',
              default: false,
              commit: {
                id: 'bbbbbbbbbbbbbbbb',
                parent_ids: ['aaaaaaaaaaaaaaaa'],
                author_name: 'Bob',
                title: 'feature commit',
                committed_date: '2026-03-17T11:00:00.000Z',
              },
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-gitlab-branch-summary-cache',
      name: 'Repo GitLab Branch Summary Cache',
      remote_provider: 'gitlab',
      remote_repo_slug: 'group/repo',
      remote_base_url: 'https://gitlab.example.com',
      platform_token: 'gitlab_pat_test',
      enabled: true,
    });

    const first = await service.listRepoReviewRemoteBranches(repository.id);
    const second = await service.listRepoReviewRemoteBranches(repository.id);

    expect(first.map((entry) => entry.name)).toEqual(['main', 'feature/login']);
    expect(first[0]).toMatchObject({
      name: 'main',
      headSha: 'aaaaaaaaaaaaaaaa',
      parentSha: '9999999999999999',
      actor: 'Alice',
      title: 'main commit',
      defaultBranch: true,
    });
    expect(first[1]).toMatchObject({
      name: 'feature/login',
      headSha: 'bbbbbbbbbbbbbbbb',
      parentSha: 'aaaaaaaaaaaaaaaa',
      actor: 'Bob',
      title: 'feature commit',
      defaultBranch: false,
    });
    expect(second.map((entry) => entry.name)).toEqual([
      'main',
      'feature/login',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await service.listRepoReviewRemoteBranches(repository.id, { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('posts a gitlab commit comment for push-based remote reviews', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'warn',
        summary: '需要关注数据库配置变更',
        findings: [
          {
            severity: 'medium',
            file: 'bootstrap.yml',
            title: '配置风险',
            detail: '生产配置调整需要复核。',
            suggestion: '确认变更范围。',
          },
        ],
        commit_reviews: [],
        suggestions: [],
        recommended_block: false,
      }),
    });

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method || 'GET').toUpperCase();
      if (
        url ===
        'https://gitlab.example.com/api/v4/projects/group%2Frepo/repository/branches?per_page=100'
      ) {
        return new Response(
          JSON.stringify([
            {
              name: 'main',
              default: true,
              commit: {
                id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                parent_ids: ['9999999999999999999999999999999999999999'],
                author_name: 'Alice',
                title: 'main baseline',
                committed_date: '2026-03-24T09:00:00.000Z',
              },
            },
            {
              name: 'feature/review',
              default: false,
              commit: {
                id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                parent_ids: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
                author_name: 'Bob',
                title: 'feature change',
                committed_date: '2026-03-24T09:10:00.000Z',
              },
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (
        url ===
          'https://gitlab.example.com/api/v4/projects/group%2Frepo/repository/compare?from=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&to=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' &&
        method === 'GET'
      ) {
        return new Response(
          JSON.stringify({
            diffs: [
              {
                new_path: 'bootstrap.yml',
                old_path: 'bootstrap.yml',
                diff: '@@ -1 +1 @@\n-old\n+new',
              },
            ],
            commits: [
              {
                id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                title: 'feature change',
                message: 'feature change',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (
        url.includes('/repository/files/') &&
        method === 'GET'
      ) {
        return new Response('not found', { status: 404 });
      }
      if (
        url ===
          'https://gitlab.example.com/api/v4/projects/group%2Frepo/statuses/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' &&
        method === 'POST'
      ) {
        return new Response('{}', {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (
        url ===
          'https://gitlab.example.com/api/v4/projects/group%2Frepo/repository/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/comments' &&
        method === 'POST'
      ) {
        return new Response(
          JSON.stringify({
            id: 42,
            url: 'https://gitlab.example.com/group/repo/-/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#note_42',
          }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-gitlab-push-comment',
      name: 'Repo GitLab Push Comment',
      remote_provider: 'gitlab',
      remote_repo_slug: 'group/repo',
      remote_base_url: 'https://gitlab.example.com',
      platform_token: 'gitlab_pat_test',
      enabled: true,
    });
    await service.upsertRepoReviewProfile({
      id: 'profile-gitlab-push-comment',
      repository_id: repository.id,
      name: 'Push Remote Review',
      stage: 'push',
      source_mode: 'remote',
      blocking_mode: 'soft_fail',
      review_scope: 'commit_range',
      write_to_chat: false,
      write_to_platform: true,
      enabled: true,
    });

    await service.listRepoReviewRemoteBranches(repository.id);
    const result = await service.triggerRemoteBranchReview({
      repositoryId: repository.id,
      branch: 'feature/review',
    });

    expect(result.run.status).toBe('completed');
    expect(result.run.overall).toBe('warn');
    expect(result.run.platformStatusDeliveryStatus).toBe('delivered');
    expect(result.run.platformCommentDeliveryStatus).toBe('delivered');
    expect(result.run.platformCommentId).toBe('42');
    expect(result.run.platformCommentUrl).toContain('#note_42');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.example.com/api/v4/projects/group%2Frepo/repository/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/comments',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('deduplicates github branch summary detail requests by shared head sha', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === 'https://api.github.com/repos/owner/shared') {
        return new Response(JSON.stringify({ default_branch: 'main' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (
        url === 'https://api.github.com/repos/owner/shared/branches?per_page=100'
      ) {
        return new Response(
          JSON.stringify([
            { name: 'main', commit: { sha: 'aaaaaaaaaaaaaaaa' } },
            { name: 'release', commit: { sha: 'aaaaaaaaaaaaaaaa' } },
            { name: 'feature/login', commit: { sha: 'bbbbbbbbbbbbbbbb' } },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (
        url ===
        'https://api.github.com/repos/owner/shared/commits?sha=aaaaaaaaaaaaaaaa&per_page=1'
      ) {
        return new Response(
          JSON.stringify([
            {
              sha: 'aaaaaaaaaaaaaaaa',
              parents: [{ sha: '9999999999999999' }],
              author: { login: 'alice' },
              commit: {
                message: 'main commit',
                author: { name: 'Alice', date: '2026-03-17T10:00:00.000Z' },
              },
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (
        url ===
        'https://api.github.com/repos/owner/shared/commits?sha=bbbbbbbbbbbbbbbb&per_page=1'
      ) {
        return new Response(
          JSON.stringify([
            {
              sha: 'bbbbbbbbbbbbbbbb',
              parents: [{ sha: 'aaaaaaaaaaaaaaaa' }],
              author: { login: 'bob' },
              commit: {
                message: 'feature commit',
                author: { name: 'Bob', date: '2026-03-17T11:00:00.000Z' },
              },
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = await import('./repo-review-service.js');
    const repository = await service.upsertRepoReviewRepository({
      id: 'repo-github-shared-heads',
      name: 'Repo GitHub Shared Heads',
      remote_provider: 'github',
      remote_repo_slug: 'owner/shared',
      platform_token: 'github_pat_test',
      enabled: true,
    });

    const branches = await service.listRepoReviewRemoteBranches(repository.id);

    expect(branches.map((entry) => entry.name)).toEqual([
      'main',
      'feature/login',
      'release',
    ]);
    expect(
      branches.filter((entry) => entry.headSha === 'aaaaaaaaaaaaaaaa'),
    ).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('batches local remote branch summaries without per-branch git log calls', async () => {
    vi.resetModules();
    const actualChildProcess =
      await vi.importActual<typeof import('child_process')>('child_process');
    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-remote-batch-'),
    );
    runGit(remoteBare, ['init', '--bare']);
    runGit(tempRepo, ['remote', 'add', 'origin', remoteBare]);
    const execFileSyncMock = vi.fn(
      (
        command: string,
        args?: readonly string[],
        options?: { cwd?: string; encoding?: BufferEncoding },
      ) => {
        if (command !== 'git') {
          return actualChildProcess.execFileSync(command, args, options);
        }
        const gitArgs = Array.isArray(args) ? [...args] : [];
        if (gitArgs[0] === 'rev-parse' && gitArgs[1] === '--git-dir') {
          return '.git';
        }
        if (gitArgs[0] === 'remote' && gitArgs[1] === '-v') {
          return [
            'origin https://example.com/team/repo.git (fetch)',
            'origin https://example.com/team/repo.git (push)',
          ].join('\n');
        }
        if (gitArgs[0] === 'for-each-ref') {
          return [
            'origin/main\x00aaaaaaaaaaaaaaaa\x00alice\x00main commit\x002026-03-17T10:00:00+00:00\x009999999999999999',
            'origin/feature/login\x00bbbbbbbbbbbbbbbb\x00bob\x00feature commit\x002026-03-17T11:00:00+00:00\x00aaaaaaaaaaaaaaaa',
            'origin/HEAD\x00cccccccccccccccc\x00bot\x00HEAD\x002026-03-17T09:00:00+00:00\x000000000000000000',
          ].join('\n');
        }
        throw new Error(`Unexpected git command: ${gitArgs.join(' ')}`);
      },
    );

    vi.doMock('child_process', () => ({
      ...actualChildProcess,
      execFileSync: execFileSyncMock,
    }));

    try {
      const db = await import('../db.js');
      db._initTestDatabase();
      const service = await import('./repo-review-service.js');
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-local-branch-batch',
        name: 'Repo Local Branch Batch',
        local_repo_path: tempRepo,
        remote_provider: 'gitlab',
        clone_url: 'https://example.com/team/repo.git',
        default_target_branch: 'main',
        enabled: true,
      });
      execFileSyncMock.mockClear();

      const branches = await service.listRepoReviewRemoteBranches(
        repository.id,
        { force: true },
      );
      const gitCommands = execFileSyncMock.mock.calls
        .filter(([command]) => command === 'git')
        .map(([, args]) => (Array.isArray(args) ? args.join(' ') : ''));

      expect(branches).toEqual([
        expect.objectContaining({
          name: 'main',
          headSha: 'aaaaaaaaaaaaaaaa',
          parentSha: '9999999999999999',
          actor: 'alice',
          title: 'main commit',
          defaultBranch: true,
        }),
        expect.objectContaining({
          name: 'feature/login',
          headSha: 'bbbbbbbbbbbbbbbb',
          parentSha: 'aaaaaaaaaaaaaaaa',
          actor: 'bob',
          title: 'feature commit',
          defaultBranch: false,
        }),
      ]);
      expect(
        gitCommands.filter((command) =>
          command.includes(
            '--format=%(refname:short)%00%(objectname)%00%(authorname)%00%(subject)%00%(authordate:iso-strict)%00%(parent)',
          ),
        ),
      ).toHaveLength(1);
      expect(
        gitCommands.filter((command) => command === 'remote -v'),
      ).toHaveLength(1);
      expect(
        gitCommands.some((command) => command.includes('log -1')),
      ).toBe(false);
    } finally {
      vi.doUnmock('child_process');
      vi.resetModules();
      fs.rmSync(remoteBare, { recursive: true, force: true });
    }
  });

  it('ignores repeated manual single-branch review triggers while the same head is already running', async () => {
    let resolveAgentResult:
      | ((value: { status: string; result: string }) => void)
      | undefined;
    mockRunAgentProcess.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAgentResult = resolve as (
            value: { status: string; result: string },
          ) => void;
        }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          'fetch should not be called when local git fallback is available',
        );
      }),
    );

    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-manual-repeat-'),
    );

    try {
      runGit(remoteBare, ['init', '--bare']);

      runGit(tempRepo, ['commit', '-m', 'main base']);
      runGit(tempRepo, ['remote', 'add', 'company', remoteBare]);
      runGit(tempRepo, ['push', 'company', 'main']);
      runGit(remoteBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      runGit(tempRepo, ['checkout', '-b', 'feature/manual-repeat']);
      fs.writeFileSync(
        path.join(tempRepo, 'manual-repeat.ts'),
        'export const manualRepeat = true;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'manual-repeat.ts']);
      runGit(tempRepo, ['commit', '-m', 'manual repeat']);
      runGit(tempRepo, ['push', 'company', 'feature/manual-repeat']);
      runGit(tempRepo, ['checkout', 'main']);
      runGit(tempRepo, ['fetch', '--prune', 'company']);

      const service = await import('./repo-review-service.js');
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-manual-repeat',
        name: 'Repo Manual Repeat',
        local_repo_path: tempRepo,
        remote_provider: 'gitlab',
        clone_url: normalizeGitLocalPath(remoteBare),
        default_target_branch: 'main',
        enabled: true,
      });
      await service.upsertRepoReviewProfile({
        id: 'profile-manual-repeat',
        repository_id: repository.id,
        name: 'Manual Repeat Push',
        stage: 'push',
        source_mode: 'remote',
        blocking_mode: 'soft_fail',
        review_scope: 'commit_range',
        target_branches: ['feature/manual-repeat'],
        write_to_chat: false,
        write_to_platform: false,
        enabled: true,
      });

      const firstPromise = service.triggerRemoteBranchReview({
        repositoryId: repository.id,
        branch: 'feature/manual-repeat',
      });

      await waitForCondition(async () => {
        const runs = await service.listRepoReviewRuns(repository.id);
        expect(runs).toHaveLength(1);
        expect(['queued', 'running']).toContain(runs[0]?.status);
        expect(mockRunAgentProcess).toHaveBeenCalledTimes(1);
      });

      const secondResult = await service.triggerRemoteBranchReview({
        repositoryId: repository.id,
        branch: 'feature/manual-repeat',
      });

      expect(secondResult.reused).toBe(true);
      expect(secondResult.reuseReason).toBe(
        '该分支已有审查任务执行中，重复点击已忽略。',
      );
      expect(await service.listRepoReviewRuns(repository.id)).toHaveLength(1);

      resolveAgentResult?.({
        status: 'success',
        result: JSON.stringify({
          overall: 'pass',
          summary: '通过',
          findings: [],
          suggestions: [],
          recommended_block: false,
        }),
      });
      await firstPromise;
    } finally {
      fs.rmSync(remoteBare, { recursive: true, force: true });
    }
  }, 30000);

  it('allows cancelling a running remote branch review and re-queueing the same head', async () => {
    let firstRunPending = true;
    mockRunAgentProcess
      .mockImplementationOnce(
        () =>
          new Promise(() => {
            firstRunPending = true;
          }),
      )
      .mockResolvedValueOnce({
        status: 'success',
        result: JSON.stringify({
          overall: 'pass',
          summary: 'retry ok',
          findings: [],
          suggestions: [],
          recommended_block: false,
        }),
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          'fetch should not be called when local git fallback is available',
        );
      }),
    );

    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-manual-cancel-'),
    );

    try {
      runGit(remoteBare, ['init', '--bare']);

      runGit(tempRepo, ['commit', '-m', 'main base']);
      runGit(tempRepo, ['remote', 'add', 'company', remoteBare]);
      runGit(tempRepo, ['push', 'company', 'main']);
      runGit(remoteBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      runGit(tempRepo, ['checkout', '-b', 'feature/manual-cancel']);
      fs.writeFileSync(
        path.join(tempRepo, 'manual-cancel.ts'),
        'export const manualCancel = true;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'manual-cancel.ts']);
      runGit(tempRepo, ['commit', '-m', 'manual cancel']);
      runGit(tempRepo, ['push', 'company', 'feature/manual-cancel']);
      runGit(tempRepo, ['checkout', 'main']);
      runGit(tempRepo, ['fetch', '--prune', 'company']);

      const service = await import('./repo-review-service.js');
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-manual-cancel',
        name: 'Repo Manual Cancel',
        local_repo_path: tempRepo,
        remote_provider: 'gitlab',
        clone_url: normalizeGitLocalPath(remoteBare),
        default_target_branch: 'main',
        enabled: true,
      });
      await service.upsertRepoReviewProfile({
        id: 'profile-manual-cancel',
        repository_id: repository.id,
        name: 'Manual Cancel Push',
        stage: 'push',
        source_mode: 'remote',
        blocking_mode: 'soft_fail',
        review_scope: 'commit_range',
        target_branches: ['feature/manual-cancel'],
        write_to_chat: false,
        write_to_platform: false,
        enabled: true,
      });

      const firstQueued = await service.queueRemoteBranchReview({
        repositoryId: repository.id,
        branch: 'feature/manual-cancel',
      });
      expect(firstQueued.queued).toBe(true);
      expect(firstQueued.runId).toBeTruthy();

      await waitForCondition(async () => {
        const run = await service.getRepoReviewRun(firstQueued.runId!);
        expect(run?.status).toBe('running');
      });
      await waitForCondition(async () => {
        expect(mockRunAgentProcess).toHaveBeenCalledTimes(1);
      });

      const cancelledRun = await service.cancelRepoReviewRun({
        runId: firstQueued.runId!,
        cancelledBy: 'alice',
      });
      expect(cancelledRun).toMatchObject({
        id: firstQueued.runId,
        status: 'error',
        overall: 'error',
        summary: 'Review execution cancelled.',
      });
      expect(cancelledRun.error).toContain('alice');
      expect(mockRequestAgentClose).toHaveBeenCalledWith(
        'review-repo-manual-cancel',
        firstQueued.runId,
      );
      expect(firstRunPending).toBe(true);

      await waitForCondition(async () => {
        const terminal = await service.getRepoReviewRun(firstQueued.runId!);
        expect(terminal?.status).toBe('error');
      });

      const secondQueued = await service.queueRemoteBranchReview({
        repositoryId: repository.id,
        branch: 'feature/manual-cancel',
      });
      expect(secondQueued.queued).toBe(true);
      expect(secondQueued.runId).toBeTruthy();
      expect(secondQueued.runId).not.toBe(firstQueued.runId);

      await waitForCondition(async () => {
        const retryRun = await service.getRepoReviewRun(secondQueued.runId!);
        expect(retryRun).toMatchObject({
          id: secondQueued.runId,
          status: 'completed',
          overall: 'pass',
          summary: 'retry ok',
        });
      });
    } finally {
      fs.rmSync(remoteBare, { recursive: true, force: true });
    }
  }, 30000);

  it('allows repeating a manual branch review on the same head with the last baseline', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: 'manual rerun ok',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          'fetch should not be called when local git fallback is available',
        );
      }),
    );

    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-manual-repeat-bare-'),
    );
    try {
      runGit(remoteBare, ['init', '--bare']);

      runGit(tempRepo, ['commit', '-m', 'main base']);
      const mainHead = runGit(tempRepo, ['rev-parse', 'HEAD']);
      runGit(tempRepo, ['remote', 'add', 'company', remoteBare]);
      runGit(tempRepo, ['push', 'company', 'main']);
      runGit(remoteBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      runGit(tempRepo, ['checkout', '-b', 'feature/manual-repeat']);
      fs.writeFileSync(
        path.join(tempRepo, 'manual-repeat.ts'),
        'export const manualRepeat = true;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'manual-repeat.ts']);
      runGit(tempRepo, ['commit', '-m', 'manual repeat']);
      const featureHead = runGit(tempRepo, ['rev-parse', 'HEAD']);
      runGit(tempRepo, ['push', 'company', 'feature/manual-repeat']);
      runGit(tempRepo, ['checkout', 'main']);
      runGit(tempRepo, ['fetch', '--prune', 'company']);

      const service = await import('./repo-review-service.js');
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-manual-repeat',
        name: 'Repo Manual Repeat',
        local_repo_path: tempRepo,
        remote_provider: 'gitlab',
        clone_url: normalizeGitLocalPath(remoteBare),
        default_target_branch: 'main',
        enabled: true,
      });
      await service.upsertRepoReviewProfile({
        id: 'profile-manual-repeat',
        repository_id: repository.id,
        name: 'Manual Repeat Push',
        stage: 'push',
        source_mode: 'remote',
        blocking_mode: 'soft_fail',
        review_scope: 'commit_range',
        target_branches: ['feature/manual-repeat'],
        write_to_chat: false,
        write_to_platform: false,
        enabled: true,
      });

      const firstQueued = await service.queueRemoteBranchReview({
        repositoryId: repository.id,
        branch: 'feature/manual-repeat',
      });
      expect(firstQueued).toMatchObject({
        queued: true,
        branch: 'feature/manual-repeat',
      });

      await waitForCondition(async () => {
        const run = await service.getRepoReviewRun(firstQueued.runId!);
        expect(run).toMatchObject({
          id: firstQueued.runId,
          status: 'completed',
          overall: 'pass',
          headSha: featureHead,
          baseSha: mainHead,
          baselineSource: 'default-branch-head',
        });
      });

      const secondQueued = await service.queueRemoteBranchReview({
        repositoryId: repository.id,
        branch: 'feature/manual-repeat',
        baselineMode: 'last_reviewed',
        allowRepeat: true,
      });
      expect(secondQueued).toMatchObject({
        queued: true,
        branch: 'feature/manual-repeat',
      });
      expect(secondQueued.runId).not.toBe(firstQueued.runId);

      await waitForCondition(async () => {
        const rerun = await service.getRepoReviewRun(secondQueued.runId!);
        expect(rerun).toMatchObject({
          id: secondQueued.runId,
          status: 'completed',
          overall: 'pass',
          headSha: featureHead,
          baseSha: mainHead,
          baselineSource: 'manual-last-baseline',
        });
        expect(rerun?.baselineLabel).toContain('上次基线');
      });

      expect(mockRunAgentProcess).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(remoteBare, { recursive: true, force: true });
    }
  }, 30000);

  it('supports manual history-run and full-review baselines for branch review', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: 'manual baseline mode ok',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          'fetch should not be called when local git fallback is available',
        );
      }),
    );

    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-manual-baseline-bare-'),
    );
    try {
      runGit(remoteBare, ['init', '--bare']);

      runGit(tempRepo, ['commit', '-m', 'main base']);
      const mainHead = runGit(tempRepo, ['rev-parse', 'HEAD']);
      runGit(tempRepo, ['remote', 'add', 'company', remoteBare]);
      runGit(tempRepo, ['push', 'company', 'main']);
      runGit(remoteBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      runGit(tempRepo, ['checkout', '-b', 'feature/manual-history']);
      fs.writeFileSync(
        path.join(tempRepo, 'manual-history.ts'),
        'export const manualHistory = 1;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'manual-history.ts']);
      runGit(tempRepo, ['commit', '-m', 'manual history first']);
      const firstFeatureHead = runGit(tempRepo, ['rev-parse', 'HEAD']);
      runGit(tempRepo, ['push', 'company', 'feature/manual-history']);
      runGit(tempRepo, ['checkout', 'main']);
      runGit(tempRepo, ['fetch', '--prune', 'company']);

      const service = await import('./repo-review-service.js');
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-manual-history',
        name: 'Repo Manual History',
        local_repo_path: tempRepo,
        remote_provider: 'gitlab',
        clone_url: normalizeGitLocalPath(remoteBare),
        default_target_branch: 'main',
        enabled: true,
      });
      await service.upsertRepoReviewProfile({
        id: 'profile-manual-history',
        repository_id: repository.id,
        name: 'Manual History Push',
        stage: 'push',
        source_mode: 'remote',
        blocking_mode: 'soft_fail',
        review_scope: 'commit_range',
        target_branches: ['feature/manual-history'],
        write_to_chat: false,
        write_to_platform: false,
        enabled: true,
      });

      const firstQueued = await service.queueRemoteBranchReview({
        repositoryId: repository.id,
        branch: 'feature/manual-history',
      });
      await waitForCondition(async () => {
        const run = await service.getRepoReviewRun(firstQueued.runId!);
        expect(run).toMatchObject({
          id: firstQueued.runId,
          status: 'completed',
          overall: 'pass',
          headSha: firstFeatureHead,
          baseSha: mainHead,
        });
      });

      runGit(tempRepo, ['checkout', 'feature/manual-history']);
      fs.writeFileSync(
        path.join(tempRepo, 'manual-history.ts'),
        'export const manualHistory = 2;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'manual-history.ts']);
      runGit(tempRepo, ['commit', '-m', 'manual history second']);
      const secondFeatureHead = runGit(tempRepo, ['rev-parse', 'HEAD']);
      runGit(tempRepo, ['push', 'company', 'feature/manual-history']);
      runGit(tempRepo, ['checkout', 'main']);
      runGit(tempRepo, ['fetch', '--prune', 'company']);

      const branchCommits = await service.listRepoReviewRemoteBranchCommits(
        repository.id,
        'feature/manual-history',
        { limit: 20 },
      );
      expect(branchCommits[0]).toMatchObject({
        sha: secondFeatureHead,
      });
      expect(branchCommits[0]?.commit.startsWith(secondFeatureHead.slice(0, 8))).toBe(
        true,
      );
      expect(
        branchCommits.some((commit) => commit.sha === firstFeatureHead),
      ).toBe(true);

      const historyQueued = await service.queueRemoteBranchReview({
        repositoryId: repository.id,
        branch: 'feature/manual-history',
        baselineMode: 'history_run',
        baselineRunId: firstQueued.runId,
        allowRepeat: true,
      });
      expect(historyQueued.queued).toBe(true);

      await waitForCondition(async () => {
        const run = await service.getRepoReviewRun(historyQueued.runId!);
        expect(run).toMatchObject({
          id: historyQueued.runId,
          status: 'completed',
          overall: 'pass',
          headSha: secondFeatureHead,
          baseSha: firstFeatureHead,
          baselineSource: 'manual-history-run-head',
        });
        expect(run?.baselineLabel).toContain('历史审查点');
      });

      const commitBaselineQueued = await service.queueRemoteBranchReview({
        repositoryId: repository.id,
        branch: 'feature/manual-history',
        baselineMode: 'commit_sha',
        baselineSha: firstFeatureHead,
        allowRepeat: true,
      });
      expect(commitBaselineQueued.queued).toBe(true);

      await waitForCondition(async () => {
        const run = await service.getRepoReviewRun(commitBaselineQueued.runId!);
        expect(run).toMatchObject({
          id: commitBaselineQueued.runId,
          status: 'completed',
          overall: 'pass',
          headSha: secondFeatureHead,
          baseSha: firstFeatureHead,
          baselineSource: 'manual-selected-commit',
        });
        expect(run?.baselineLabel).toContain('指定提交');
      });

      const fullQueued = await service.queueRemoteBranchReview({
        repositoryId: repository.id,
        branch: 'feature/manual-history',
        baselineMode: 'default_branch',
        reviewMode: 'full',
        allowRepeat: true,
      });
      expect(fullQueued.queued).toBe(true);

      await waitForCondition(async () => {
        const run = await service.getRepoReviewRun(fullQueued.runId!);
        expect(run).toMatchObject({
          id: fullQueued.runId,
          status: 'completed',
          overall: 'pass',
          headSha: secondFeatureHead,
          baseSha: mainHead,
          baselineSource: 'manual-default-branch-head',
        });
        expect(run?.baselineLabel).toContain('整体审查基线');
      });
    } finally {
      fs.rmSync(remoteBare, { recursive: true, force: true });
    }
  }, 30000);

  it('allows manual branch review to fallback to repository push profile outside target branches', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: 'manual branch fallback ok',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          'fetch should not be called when local git fallback is available',
        );
      }),
    );

    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-manual-profile-fallback-'),
    );
    try {
      runGit(remoteBare, ['init', '--bare']);

      runGit(tempRepo, ['commit', '-m', 'main base']);
      runGit(tempRepo, ['remote', 'add', 'company', remoteBare]);
      runGit(tempRepo, ['push', 'company', 'main']);
      runGit(remoteBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      runGit(tempRepo, ['checkout', '-b', 'feature/manual-fallback']);
      fs.writeFileSync(
        path.join(tempRepo, 'manual-fallback.ts'),
        'export const manualFallback = true;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'manual-fallback.ts']);
      runGit(tempRepo, ['commit', '-m', 'manual fallback']);
      runGit(tempRepo, ['push', 'company', 'feature/manual-fallback']);
      runGit(tempRepo, ['checkout', 'main']);
      runGit(tempRepo, ['fetch', '--prune', 'company']);

      const service = await import('./repo-review-service.js');
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-manual-profile-fallback',
        name: 'Repo Manual Profile Fallback',
        local_repo_path: tempRepo,
        remote_provider: 'gitlab',
        clone_url: normalizeGitLocalPath(remoteBare),
        default_target_branch: 'main',
        enabled: true,
      });
      await service.upsertRepoReviewProfile({
        id: 'profile-manual-profile-fallback',
        repository_id: repository.id,
        name: 'Manual Profile Fallback Push',
        stage: 'push',
        source_mode: 'remote',
        blocking_mode: 'soft_fail',
        review_scope: 'commit_range',
        target_branches: ['release-only'],
        write_to_chat: false,
        write_to_platform: false,
        enabled: true,
      });

      const queued = await service.queueRemoteBranchReview({
        repositoryId: repository.id,
        branch: 'feature/manual-fallback',
      });
      expect(queued.queued).toBe(true);

      await waitForCondition(async () => {
        const run = await service.getRepoReviewRun(queued.runId!);
        expect(run).toMatchObject({
          id: queued.runId,
          status: 'completed',
          overall: 'pass',
          summary: 'manual branch fallback ok',
          branch: 'feature/manual-fallback',
        });
      });
    } finally {
      fs.rmSync(remoteBare, { recursive: true, force: true });
    }
  }, 30000);

  it('triggers selected remote branches immediately after saving a push profile', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: '通过',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          'fetch should not be called when local git fallback is available',
        );
      }),
    );

    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-profile-save-'),
    );
    try {
      runGit(remoteBare, ['init', '--bare']);

      runGit(tempRepo, ['commit', '-m', 'main base']);
      runGit(tempRepo, ['remote', 'add', 'company', remoteBare]);
      runGit(tempRepo, ['push', 'company', 'main']);
      runGit(remoteBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      runGit(tempRepo, ['checkout', '-b', 'feature/save-trigger']);
      fs.writeFileSync(
        path.join(tempRepo, 'save-trigger.ts'),
        'export const saveTrigger = true;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'save-trigger.ts']);
      runGit(tempRepo, ['commit', '-m', 'save trigger']);
      runGit(tempRepo, ['push', 'company', 'feature/save-trigger']);
      runGit(tempRepo, ['checkout', 'main']);
      runGit(tempRepo, ['fetch', '--prune', 'company']);

      const service = await import('./repo-review-service.js');
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-profile-save-trigger',
        name: 'Repo Profile Save Trigger',
        local_repo_path: tempRepo,
        remote_provider: 'gitlab',
        clone_url: normalizeGitLocalPath(remoteBare),
        default_target_branch: 'main',
        enabled: true,
      });

      const result = await service.saveRepoReviewProfileConfig({
        id: 'profile-save-trigger',
        repository_id: repository.id,
        name: 'Push Save Trigger',
        stage: 'push',
        source_mode: 'remote',
        blocking_mode: 'soft_fail',
        target_branches: ['feature/save-trigger'],
        write_to_chat: false,
        write_to_platform: false,
        enabled: true,
      });

      expect(result.profile.targetBranches).toEqual(['feature/save-trigger']);
    } finally {
      fs.rmSync(remoteBare, { recursive: true, force: true });
    }
  }, 30000);

  it('refreshes stale local refs before executing queued webhook reviews', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: 'webhook review ok',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          'fetch should not be called when local git fallback is available',
        );
      }),
    );

    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-webhook-stale-bare-'),
    );
    const reviewerRepo = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-webhook-stale-local-'),
    );
    try {
      runGit(remoteBare, ['init', '--bare']);

      runGit(tempRepo, ['commit', '-m', 'main base']);
      runGit(tempRepo, ['remote', 'add', 'company', remoteBare]);
      runGit(tempRepo, ['push', 'company', 'main']);
      runGit(remoteBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      execFileSync('git', ['clone', remoteBare, reviewerRepo], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      runGit(tempRepo, ['checkout', '-b', 'feature/webhook-stale']);
      fs.writeFileSync(
        path.join(tempRepo, 'stale.ts'),
        'export const webhookStale = true;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'stale.ts']);
      runGit(tempRepo, ['commit', '-m', 'feature webhook stale']);
      const baseSha = runGit(tempRepo, ['rev-parse', 'HEAD^']);
      const headSha = runGit(tempRepo, ['rev-parse', 'HEAD']);
      runGit(tempRepo, ['push', 'company', 'feature/webhook-stale']);
      runGit(tempRepo, ['checkout', 'main']);

      const service = await import('./repo-review-service.js');
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-webhook-stale-refresh',
        name: 'Repo Webhook Stale Refresh',
        local_repo_path: reviewerRepo,
        remote_provider: 'gitlab',
        clone_url: normalizeGitLocalPath(remoteBare),
        default_target_branch: 'main',
        enabled: true,
      });
      await service.upsertRepoReviewProfile({
        id: 'profile-webhook-stale-refresh',
        repository_id: repository.id,
        name: 'Webhook Stale Refresh',
        stage: 'push',
        source_mode: 'remote',
        blocking_mode: 'soft_fail',
        review_scope: 'commit_range',
        target_branches: ['feature/webhook-stale'],
        write_to_chat: false,
        write_to_platform: false,
        enabled: true,
      });

      const queued = await service.enqueueRemoteRepoReview({
        source: 'gitlab',
        stage: 'push',
        repositoryId: repository.id,
        ref: 'refs/heads/feature/webhook-stale',
        branch: 'feature/webhook-stale',
        baseSha,
        headSha,
        actor: 'alice',
        blockingExpected: false,
        callbackContext: {
          commitSummaryLines: ['feature webhook stale'],
        },
      });
      expect(queued.queued).toBe(true);

      await waitForCondition(async () => {
        const run = await service.getRepoReviewRun(queued.runId!);
        expect(run).toMatchObject({
          id: queued.runId,
          status: 'completed',
          overall: 'pass',
          summary: 'webhook review ok',
          branch: 'feature/webhook-stale',
        });
        expect(run?.changedFiles).toContain('stale.ts');
      });
    } finally {
      fs.rmSync(remoteBare, { recursive: true, force: true });
      fs.rmSync(reviewerRepo, { recursive: true, force: true });
    }
  }, 30000);

  it('falls back to the scm compare API when queued webhook local diff resolution is empty', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: 'webhook compare fallback ok',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (
        url ===
        'https://gitlab.example.com/api/v4/projects/group%2Frepo/repository/compare?from=BASE_SHA&to=HEAD_SHA'
      ) {
        return new Response(
          JSON.stringify({
            diffs: [
              {
                new_path: 'stale.ts',
                old_path: 'stale.ts',
                diff: '@@ -0,0 +1 @@\n+export const webhookStale = true;',
              },
            ],
            commits: [
              {
                id: 'HEAD_SHA',
                title: 'feature webhook stale',
                message: 'feature webhook stale',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-webhook-fallback-bare-'),
    );
    const reviewerRepo = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-webhook-fallback-local-'),
    );
    try {
      runGit(remoteBare, ['init', '--bare']);

      runGit(tempRepo, ['commit', '-m', 'main base']);
      runGit(tempRepo, ['remote', 'add', 'company', remoteBare]);
      runGit(tempRepo, ['push', 'company', 'main']);
      runGit(remoteBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      execFileSync('git', ['clone', remoteBare, reviewerRepo], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      runGit(reviewerRepo, ['remote', 'set-url', 'origin', 'invalid://origin']);

      runGit(tempRepo, ['checkout', '-b', 'feature/webhook-fallback']);
      fs.writeFileSync(
        path.join(tempRepo, 'stale.ts'),
        'export const webhookStale = true;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'stale.ts']);
      runGit(tempRepo, ['commit', '-m', 'feature webhook stale']);
      const baseSha = runGit(tempRepo, ['rev-parse', 'HEAD^']);
      const headSha = runGit(tempRepo, ['rev-parse', 'HEAD']);
      runGit(tempRepo, ['push', 'company', 'feature/webhook-fallback']);
      runGit(tempRepo, ['checkout', 'main']);

      const service = await import('./repo-review-service.js');
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-webhook-compare-fallback',
        name: 'Repo Webhook Compare Fallback',
        local_repo_path: reviewerRepo,
        remote_provider: 'gitlab',
        remote_repo_slug: 'group/repo',
        remote_base_url: 'https://gitlab.example.com',
        platform_token: 'gitlab_pat_test',
        clone_url: normalizeGitLocalPath(remoteBare),
        default_target_branch: 'main',
        enabled: true,
      });
      await service.upsertRepoReviewProfile({
        id: 'profile-webhook-compare-fallback',
        repository_id: repository.id,
        name: 'Webhook Compare Fallback',
        stage: 'push',
        source_mode: 'remote',
        blocking_mode: 'soft_fail',
        review_scope: 'commit_range',
        target_branches: ['feature/webhook-fallback'],
        write_to_chat: false,
        write_to_platform: false,
        enabled: true,
      });

      const queued = await service.enqueueRemoteRepoReview({
        source: 'gitlab',
        stage: 'push',
        repositoryId: repository.id,
        ref: 'refs/heads/feature/webhook-fallback',
        branch: 'feature/webhook-fallback',
        baseSha: 'BASE_SHA',
        headSha: 'HEAD_SHA',
        actor: 'alice',
        blockingExpected: false,
        callbackContext: {
          commitSummaryLines: ['feature webhook stale'],
        },
      });
      expect(queued.queued).toBe(true);

      await waitForCondition(async () => {
        const run = await service.getRepoReviewRun(queued.runId!);
        expect(run).toMatchObject({
          id: queued.runId,
          status: 'completed',
          overall: 'pass',
          summary: 'webhook compare fallback ok',
          branch: 'feature/webhook-fallback',
        });
        expect(run?.changedFiles).toContain('stale.ts');
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/group%2Frepo/repository/compare?from=BASE_SHA&to=HEAD_SHA',
        expect.objectContaining({
          headers: { 'PRIVATE-TOKEN': 'gitlab_pat_test' },
        }),
      );
    } finally {
      fs.rmSync(remoteBare, { recursive: true, force: true });
      fs.rmSync(reviewerRepo, { recursive: true, force: true });
    }
  }, 30000);

  it('retries the same remote head after an earlier review run errored', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          'fetch should not be called when local git fallback is available',
        );
      }),
    );

    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-remote-retry-bare-'),
    );
    try {
      runGit(remoteBare, ['init', '--bare']);
      runGit(tempRepo, ['commit', '-m', 'main base']);
      fs.writeFileSync(
        path.join(tempRepo, 'demo.ts'),
        'const a = 2;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'demo.ts']);
      runGit(tempRepo, ['commit', '-m', 'main second']);
      runGit(tempRepo, ['remote', 'add', 'company', remoteBare]);
      runGit(tempRepo, ['push', 'company', 'main']);
      runGit(remoteBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      runGit(tempRepo, ['fetch', '--prune', 'company']);

      const service = await import('./repo-review-service.js');
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-local-remote-retry',
        name: 'Repo Local Remote Retry',
        local_repo_path: tempRepo,
        remote_provider: 'gitlab',
        clone_url: normalizeGitLocalPath(remoteBare),
        default_target_branch: 'main',
        enabled: true,
        auto_sync_enabled: true,
      });
      await service.upsertRepoReviewProfile({
        id: 'profile-local-remote-retry',
        repository_id: repository.id,
        name: 'Remote Retry',
        stage: 'push',
        source_mode: 'remote',
        blocking_mode: 'soft_fail',
        target_branches: ['main'],
        diff_subagent_threshold: 0,
        write_to_chat: false,
        write_to_platform: false,
        enabled: true,
      });

      mockRunAgentProcess
        .mockResolvedValueOnce(
          buildAgenticPlanMockResult([], {
            shouldDelegate: false,
            delegationReason: '主代理独立完成审查。',
          }),
        )
        .mockResolvedValueOnce({
          status: 'error',
          result: null,
          error: 'first run failed',
        })
        .mockResolvedValueOnce(
          buildAgenticPlanMockResult([], {
            shouldDelegate: false,
            delegationReason: '主代理独立完成审查。',
          }),
        )
        .mockResolvedValueOnce({
          status: 'success',
          result: buildAgenticReportMarkdown('retry ok'),
        })
        .mockResolvedValueOnce(
          buildAgenticExtractorMockResult({
            overall: 'pass',
            summary: 'retry ok',
            markdown: buildAgenticReportMarkdown('retry ok'),
          }),
        );

      const first = await service.syncRemoteRepoReview({
        repositoryId: repository.id,
      });
      expect(first.branches).toHaveLength(1);
      expect(first.branches[0]?.status).toBe('triggered');
      await waitForCondition(async () => {
        const runs = await service.listRepoReviewRuns(repository.id);
        expect(runs.some((run) => run.overall === 'error')).toBe(true);
      });

      const second = await service.syncRemoteRepoReview({
        repositoryId: repository.id,
      });
      expect(second.branches).toHaveLength(1);
      expect(second.branches[0]?.status).toBe('triggered');

      const runs = await service.listRepoReviewRuns(repository.id);
      expect(runs).toHaveLength(2);
      expect(runs[0]?.overall).toBe('pass');
      expect(runs[1]?.overall).toBe('error');
    } finally {
      fs.rmSync(remoteBare, { recursive: true, force: true });
    }
  }, 30000);

  it('preserves queued remote review user context when replaying provider selection', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: 'queued provider ok',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          'fetch should not be called when local git fallback is available',
        );
      }),
    );

    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-provider-queued-bare-'),
    );
    try {
      runGit(remoteBare, ['init', '--bare']);

      runGit(tempRepo, ['commit', '-m', 'main base']);
      runGit(tempRepo, ['remote', 'add', 'company', remoteBare]);
      runGit(tempRepo, ['push', 'company', 'main']);
      runGit(remoteBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      runGit(tempRepo, ['checkout', '-b', 'feature/provider-queued']);
      fs.writeFileSync(
        path.join(tempRepo, 'provider.ts'),
        'export const providerQueued = true;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'provider.ts']);
      runGit(tempRepo, ['commit', '-m', 'provider queued']);
      const baseSha = runGit(tempRepo, ['rev-parse', 'HEAD^']);
      const headSha = runGit(tempRepo, ['rev-parse', 'HEAD']);
      runGit(tempRepo, ['push', 'company', 'feature/provider-queued']);
      runGit(tempRepo, ['checkout', 'main']);
      runGit(tempRepo, ['fetch', '--prune', 'company']);

      const service = await import('./repo-review-service.js');
      const { createProvider } = await import('../db/assistants.js');
      const { setTenantConfig } = await import('../tenant/tenant-db.js');

      await createProvider({
        id: 'provider-queued-user',
        alias: 'Queued User Provider',
        type: 'openai',
        api_key: 'sk-queued',
        base_url: 'https://api.example.com',
        model: 'gpt-4.1-mini',
        extra_config: null,
        is_default: 0,
        user_id: 'test-user',
        visibility: 'private',
        created_by: 'test-user',
        updated_by: 'test-user',
      });
      await setTenantConfig(
        'test-user',
        'DEFAULT_PROVIDER_code_review',
        'provider-queued-user',
      );

      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-provider-queued',
        name: 'Repo Provider Queued',
        local_repo_path: tempRepo,
        remote_provider: 'gitlab',
        clone_url: normalizeGitLocalPath(remoteBare),
        default_target_branch: 'main',
        enabled: true,
      });
      await service.upsertRepoReviewProfile({
        id: 'profile-provider-queued',
        repository_id: repository.id,
        name: 'Remote Push Review',
        stage: 'push',
        source_mode: 'remote',
        blocking_mode: 'soft_fail',
        review_scope: 'commit_range',
        target_branches: ['feature/provider-queued'],
        write_to_chat: false,
        write_to_platform: false,
        enabled: true,
      });

      const queued = await service.enqueueRemoteRepoReview({
        source: 'gitlab',
        stage: 'push',
        repositoryId: repository.id,
        userId: 'test-user',
        ref: 'refs/heads/feature/provider-queued',
        branch: 'feature/provider-queued',
        baseSha,
        headSha,
        actor: 'alice',
        blockingExpected: false,
        callbackContext: {
          commitSummaryLines: ['provider queued'],
        },
      });
      expect(queued.queued).toBe(true);

      await waitForCondition(async () => {
        const run = await service.getRepoReviewRun(queued.runId!);
        expect(run).toMatchObject({
          id: queued.runId,
          status: 'completed',
          overall: 'pass',
          summary: 'queued provider ok',
        });
      });

      expect(mockRunAgentProcess).toHaveBeenCalledTimes(1);
      expect(mockRunAgentProcess.mock.calls[0]?.[1]).toMatchObject({
        userId: 'test-user',
        providerOverrideId: 'provider-queued-user',
      });
    } finally {
      fs.rmSync(remoteBare, { recursive: true, force: true });
    }
  }, 30000);

  it('recovers stale running remote runs and reviews branch changes against the baseline branch diff', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: 'delta ok',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          'fetch should not be called when local git fallback is available',
        );
      }),
    );

    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-remote-stale-bare-'),
    );
    try {
      runGit(remoteBare, ['init', '--bare']);

      runGit(tempRepo, ['commit', '-m', 'main base']);
      fs.writeFileSync(
        path.join(tempRepo, 'demo.ts'),
        'const a = 2;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'demo.ts']);
      runGit(tempRepo, ['commit', '-m', 'main second']);
      const mainHead = runGit(tempRepo, ['rev-parse', 'HEAD']);
      runGit(tempRepo, ['remote', 'add', 'company', remoteBare]);
      runGit(tempRepo, ['push', 'company', 'main']);
      runGit(remoteBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      runGit(tempRepo, ['checkout', '-b', 'feature/login']);
      fs.writeFileSync(
        path.join(tempRepo, 'feature.ts'),
        'export const login = true;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'feature.ts']);
      runGit(tempRepo, ['commit', '-m', 'feature login']);
      const featureHead = runGit(tempRepo, ['rev-parse', 'HEAD']);
      runGit(tempRepo, ['push', 'company', 'feature/login']);
      runGit(tempRepo, ['checkout', 'main']);
      runGit(tempRepo, ['fetch', '--prune', 'company']);

      const service = await import('./repo-review-service.js');
      const db = await import('../db.js');
      const repository = await service.upsertRepoReviewRepository({
        id: 'repo-local-remote-stale',
        name: 'Repo Local Remote Stale',
        local_repo_path: tempRepo,
        remote_provider: 'gitlab',
        clone_url: normalizeGitLocalPath(remoteBare),
        default_target_branch: 'main',
        enabled: true,
        auto_sync_enabled: true,
      });
      await service.upsertRepoReviewProfile({
        id: 'profile-local-remote-stale',
        repository_id: repository.id,
        name: 'Remote Feature Review',
        stage: 'push',
        source_mode: 'remote',
        blocking_mode: 'soft_fail',
        target_branches: ['feature/login'],
        write_to_chat: false,
        write_to_platform: false,
        enabled: true,
      });

      await db.createReviewRun({
        id: 'run-stale-feature',
        repository_id: repository.id,
        profile_id: 'profile-local-remote-stale',
        source: 'gitlab',
        stage: 'push',
        status: 'running',
        ref: 'refs/heads/feature/login',
        branch: 'feature/login',
        base_sha: mainHead,
        head_sha: featureHead,
        actor: 'alice',
      });
      await db.updateReviewRun('run-stale-feature', {
        started_at: '2026-03-13T01:00:00.000Z',
      });

      const result = await service.syncRemoteRepoReview({
        repositoryId: repository.id,
      });

      const featureBranchResult = result.branches.find(
        (entry) => entry.branch === 'feature/login',
      );
      expect(featureBranchResult).toMatchObject({
        branch: 'feature/login',
        headSha: featureHead,
        status: 'triggered',
      });

      const runs = await service.listRepoReviewRuns(repository.id);
      const latestRun = runs.find(
        (run) =>
          run.id !== 'run-stale-feature' && run.branch === 'feature/login',
      );
      const staleRun = runs.find((run) => run.id === 'run-stale-feature');

      expect(staleRun).toMatchObject({
        status: 'error',
        overall: 'error',
      });
      expect(String(staleRun?.error)).toMatch(
        /marked stale after runtime recovery|标记为过期|超时窗口内未完成/,
      );

      expect(latestRun).toMatchObject({
        status: 'completed',
        branch: 'feature/login',
        headSha: featureHead,
      });
      expect(latestRun?.baseSha).toBe(mainHead);
      expect(latestRun?.baselineSource).toBe('default-branch-head');
      expect(latestRun?.commitDetails).toHaveLength(1);
      expect(latestRun?.commitDetails[0]).toMatchObject({
        title: 'feature login',
      });
    } finally {
      fs.rmSync(remoteBare, { recursive: true, force: true });
    }
  }, 30000);

  it('marks interrupted active runs as error during startup recovery', async () => {
    const db = await import('../db.js');
    await db.saveReviewRepository({
      id: 'repo-startup-recovery',
      name: 'Repo Startup Recovery',
      local_repo_path: tempRepo,
      enabled: true,
    });
    await db.saveReviewProfile({
      id: 'profile-startup-recovery',
      repository_id: 'repo-startup-recovery',
      name: 'Push Review',
      stage: 'push',
      source_mode: 'local',
      blocking_mode: 'soft_fail',
      pass_decision_mode: 'ai',
      review_scope: 'staged_diff',
      target_branches: [],
      skill_ids: [],
      mcp_server_ids: [],
      include_globs: [],
      exclude_globs: [],
      max_files: 80,
      max_diff_bytes: 200000,
      write_to_chat: false,
      write_to_platform: false,
      enabled: true,
    });

    await db.createReviewRun({
      id: 'run-interrupted-startup',
      repository_id: 'repo-startup-recovery',
      profile_id: 'profile-startup-recovery',
      source: 'local-hook',
      stage: 'push',
      status: 'running',
      result_state: 'running',
      ref: 'refs/heads/main',
      branch: 'main',
      head_sha: 'head-startup',
      actor: 'alice',
    });
    await db.upsertReviewBranchState({
      repository_id: 'repo-startup-recovery',
      stage: 'push',
      branch: 'main',
      last_run_id: 'run-interrupted-startup',
      head_sha: 'head-startup',
      result_state: 'running',
      status: 'running',
      actor: 'alice',
      summary: 'still running',
    });

    const service = await import('./repo-review-service.js');
    service._resetRepoReviewAutoSyncLoopForTests();

    try {
      service.startRepoReviewAutoSyncLoop();

      await waitForCondition(async () => {
        const recoveredRuns = await service.listRepoReviewRuns(
          'repo-startup-recovery',
        );
        const recoveredRun = recoveredRuns.find(
          (entry) => entry.id === 'run-interrupted-startup',
        );
        expect(recoveredRun?.status).toBe('error');
        expect(recoveredRun?.overall).toBe('error');
      });

      const recoveredRuns = await service.listRepoReviewRuns(
        'repo-startup-recovery',
      );
      const recoveredRun = recoveredRuns.find(
        (entry) => entry.id === 'run-interrupted-startup',
      );
      const branchStates = await service.listRepoReviewBranchStatesForRepository(
        'repo-startup-recovery',
        'push',
      );
      const branchState = branchStates.find((entry) => entry.branch === 'main');

      expect(recoveredRun).toMatchObject({
        id: 'run-interrupted-startup',
        status: 'error',
        overall: 'error',
        resultState: 'error',
      });
      expect(String(recoveredRun?.error)).toMatch(
        /NanoClaw restarted|NanoClaw 重启|重启而被中断/,
      );
      expect(branchState).toMatchObject({
        branch: 'main',
        status: 'error',
        resultState: 'error',
      });
    } finally {
      service._resetRepoReviewAutoSyncLoopForTests();
    }
  });

  it('replays persisted queued remote runs during startup recovery', async () => {
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        overall: 'pass',
        summary: 'queued replay ok',
        findings: [],
        suggestions: [],
        recommended_block: false,
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          'fetch should not be called when local git fallback is available',
        );
      }),
    );

    const remoteBare = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-review-remote-queued-bare-'),
    );
    try {
      runGit(remoteBare, ['init', '--bare']);

      runGit(tempRepo, ['commit', '-m', 'main base']);
      fs.writeFileSync(
        path.join(tempRepo, 'demo.ts'),
        'const a = 2;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'demo.ts']);
      runGit(tempRepo, ['commit', '-m', 'main second']);
      const mainHead = runGit(tempRepo, ['rev-parse', 'HEAD']);
      runGit(tempRepo, ['remote', 'add', 'company', remoteBare]);
      runGit(tempRepo, ['push', 'company', 'main']);
      runGit(remoteBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

      runGit(tempRepo, ['checkout', '-b', 'feature/login']);
      fs.writeFileSync(
        path.join(tempRepo, 'feature.ts'),
        'export const login = true;\n',
        'utf8',
      );
      runGit(tempRepo, ['add', 'feature.ts']);
      runGit(tempRepo, ['commit', '-m', 'feature login']);
      const featureHead = runGit(tempRepo, ['rev-parse', 'HEAD']);
      runGit(tempRepo, ['push', 'company', 'feature/login']);
      runGit(tempRepo, ['checkout', 'main']);
      runGit(tempRepo, ['fetch', '--prune', 'company']);

      const db = await import('../db.js');
      await db.saveReviewRepository({
        id: 'repo-startup-queued',
        name: 'Repo Startup Queued',
        local_repo_path: tempRepo,
        remote_provider: 'gitlab',
        clone_url: normalizeGitLocalPath(remoteBare),
        default_target_branch: 'main',
        auto_sync_enabled: false,
        enabled: true,
      });
      await db.saveReviewProfile({
        id: 'profile-startup-queued',
        repository_id: 'repo-startup-queued',
        name: 'Remote Feature Review',
        stage: 'push',
        source_mode: 'remote',
        blocking_mode: 'soft_fail',
        pass_decision_mode: 'ai',
        review_scope: 'commit_range',
        target_branches: ['feature/login'],
        skill_ids: [],
        mcp_server_ids: [],
        include_globs: [],
        exclude_globs: [],
        max_files: 80,
        max_diff_bytes: 200000,
        write_to_chat: false,
        write_to_platform: false,
        enabled: true,
      });
      await db.createReviewRun({
        id: 'run-startup-queued',
        repository_id: 'repo-startup-queued',
        profile_id: 'profile-startup-queued',
        source: 'gitlab',
        stage: 'push',
        status: 'queued',
        result_state: 'queued',
        ref: 'refs/heads/feature/login',
        branch: 'feature/login',
        base_sha: mainHead,
        head_sha: featureHead,
        actor: 'alice',
        callback_context: {
          queuedRemoteReview: {
            replayEligible: true,
            blockingExpected: false,
          },
          trigger: 'manual-sync',
          baseBranch: 'main',
          baselineSource: 'default-branch-head',
        },
      });
      await db.upsertReviewBranchState({
        repository_id: 'repo-startup-queued',
        stage: 'push',
        branch: 'feature/login',
        last_run_id: 'run-startup-queued',
        head_sha: featureHead,
        baseline_sha: mainHead,
        baseline_source: 'default-branch-head',
        result_state: 'queued',
        status: 'queued',
        actor: 'alice',
        summary: 'queued before restart',
      });

      const service = await import('./repo-review-service.js');
      service._resetRepoReviewAutoSyncLoopForTests();

      try {
        service.startRepoReviewAutoSyncLoop();

        await waitForCondition(async () => {
          const recoveredRuns = await service.listRepoReviewRuns(
            'repo-startup-queued',
          );
          const recoveredRun = recoveredRuns.find(
            (entry) => entry.id === 'run-startup-queued',
          );
          expect(recoveredRun).toMatchObject({
            status: 'completed',
            overall: 'pass',
            summary: 'queued replay ok',
            headSha: featureHead,
          });
        });

        const branchStates = await service.listRepoReviewBranchStatesForRepository(
          'repo-startup-queued',
          'push',
        );
        const branchState = branchStates.find(
          (entry) => entry.branch === 'feature/login',
        );
        expect(branchState).toMatchObject({
          branch: 'feature/login',
          status: 'completed',
          resultState: 'passed',
        });
      } finally {
        service._resetRepoReviewAutoSyncLoopForTests();
      }
    } finally {
      fs.rmSync(remoteBare, { recursive: true, force: true });
    }
  }, 30000);
});
