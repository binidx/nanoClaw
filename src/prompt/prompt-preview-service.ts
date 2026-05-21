import { buildConversationSoulSystemPrompt } from '../assistant/assistant-runtime.js';
import { buildRepoDescriptionPrompt } from '../code-intelligence/code-map-description.js';
import { buildParserPrompt } from './requirement-parser.js';
import { resolveDigestPrompt } from '../repo-review/repo-review-digest-service.js';
import {
  resolveRepoReviewAgenticExtractorPrompt,
  resolveRepoReviewAgenticFinalPrompt,
  resolveRepoReviewAgenticPlanPrompt,
  resolveRepoReviewAgenticSubagentPrompt,
  resolveReviewPrompt,
  resolveSupplementalFileReviewPrompt,
} from '../repo-review/repo-review-run-executor.js';
import { renderPromptTemplate, resolvePromptText } from './prompt-service.js';
import type {
  RepoReviewEvent,
  RepoReviewProfile,
  RepoReviewRepository,
  RepoReviewRunFinding,
  ReviewPreparedContext,
} from '../repo-review/repo-review-model.js';
import {
  buildAiSummaryPrompt,
  buildMarketReviewPrompt,
  buildNewsIntelPrompt,
  buildNewsIntelSnippetPrompt,
  type AiSummaryPromptParams,
  type MarketReviewPromptParams,
  type NewsIntelPromptFocus,
  type NewsIntelPromptParams,
  type NewsIntelSnippetPromptParams,
} from '../stock-analysis/stock-analysis-prompts.js';
import { buildPromptPreviewEnvelope } from './prompt-service.js';
import { buildSoulPrompt } from '../soul/soul-service.js';
import { buildRunnerPromptPreview } from './runner-prompt-runtime.js';
import type { PromptLayer, PromptPreviewEnvelope, PromptSegment } from '../types/prompt.js';
import { t } from '../i18n/index.js';
import { getPromptDefinition } from './prompt-registry.js';

export interface PromptPreviewScenario {
  id: string;
  title: string;
  description: string;
  featureScope: string;
  promptKey?: string;
  kind: 'conversation' | 'runtime_prompt';
  targetUserMode?: 'none' | 'optional' | 'required';
  defaultVariables?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function segmentForPrompt(
  promptKey: string,
  label: string,
  content: string,
  source: PromptSegment['source'] = 'builtin',
  layer?: PromptLayer,
): PromptSegment {
  return {
    id: promptKey,
    label,
    promptKey,
    layer:
      layer ||
      (promptKey === 'conversation.companion.mode_hint'
        ? 'system_policy'
        : promptKey.startsWith('assistant.soul.') || promptKey.startsWith('soul.')
        ? 'system_persona'
        : promptKey.startsWith('assistant.profile.')
          ? 'system_persona'
          : promptKey.startsWith('conversation.')
            ? 'context_runtime'
            : promptKey.startsWith('repo_review.') ||
                promptKey.startsWith('stock_analysis.') ||
                promptKey.startsWith('requirement_parser.') ||
                promptKey.startsWith('user_mcp.') ||
                promptKey.startsWith('runtime_customization.')
              ? 'task_payload'
              : promptKey.startsWith('code_map.')
                ? 'task_payload'
              : 'user_input'),
    source,
    content,
  };
}

function buildSampleRepoReviewRepository(
  value: Record<string, unknown>,
): RepoReviewRepository {
  return {
    id: asString(value.id, 'repo-preview'),
    name: asString(value.name, 'preview-repository'),
    language: asString(value.language, 'TypeScript'),
    localRepoPath: asString(value.localRepoPath, '/workspace/extra'),
    remoteProvider: '' as any,
    remoteRepoSlug: '',
    remoteBaseUrl: '',
    cloneUrl: '',
    defaultTargetBranch: asString(value.defaultTargetBranch, 'main'),
    reviewChatJid: asString(value.reviewChatJid, 'web:repo-review-preview'),
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
    digestDailyHour: 9,
    digestWeeklyDay: 1,
    digestWeeklyHour: 9,
    lastDigestDailyAt: '',
    nextDigestDailyAt: '',
    lastDigestWeeklyAt: '',
    nextDigestWeeklyAt: '',
    enabled: true,
    allowAiFix: false,
    hasWebhookSecret: false,
    hasPlatformToken: false,
  };
}

function buildSampleRepoReviewProfile(
  value: Record<string, unknown>,
): RepoReviewProfile {
  return {
    id: asString(value.id, 'profile-preview'),
    repositoryId: asString(value.repositoryId, 'repo-preview'),
    name: asString(value.name, '默认审查配置'),
    stage: (asString(value.stage, 'push') as any),
    sourceMode: (asString(value.sourceMode, 'local') as any),
    blockingMode: (asString(value.blockingMode, 'off') as any),
    passDecisionMode: (asString(value.passDecisionMode, 'ai') as any),
    reviewScope: (asString(value.reviewScope, 'branch') as any),
    targetBranches: asStringArray(value.targetBranches),
    skillIds: asStringArray(value.skillIds),
    mcpServerIds: asStringArray(value.mcpServerIds),
    promptTemplate: asString(value.promptTemplate, ''),
    includeGlobs: asStringArray(value.includeGlobs),
    excludeGlobs: asStringArray(value.excludeGlobs),
    includeFullFileContext: Boolean(value.includeFullFileContext),
    maxFiles: Number(value.maxFiles || 30),
    maxDiffBytes: Number(value.maxDiffBytes || 120000),
    writeToChat: false,
    writeToPlatform: false,
    reviewOutputMode: (asString(value.reviewOutputMode, 'message') as any),
    diffSubagentThreshold: Number(value.diffSubagentThreshold || 15),
    enabled: true,
  };
}

function buildSampleRepoReviewEvent(
  value: Record<string, unknown>,
): RepoReviewEvent {
  return {
    repositoryId: asString(value.repositoryId, 'repo-preview'),
    source: (asString(value.source, 'local-hook') as any),
    stage: (asString(value.stage, 'push') as any),
    blockingExpected: Boolean(value.blockingExpected),
    userId: asString(value.userId, '') || undefined,
    idempotencyKey: asString(value.idempotencyKey, '') || undefined,
    actor: asString(value.actor, 'preview-user'),
    branch: asString(value.branch, 'main'),
    ref: asString(value.ref, 'refs/heads/main'),
    changedFiles: asStringArray(value.changedFiles),
    baseSha: asString(value.baseSha, ''),
    headSha: asString(value.headSha, ''),
    diffText: asString(value.diffText, ''),
    callbackContext: asRecord(value.callbackContext),
    profileId: asString(value.profileId, '') || undefined,
  };
}

function buildSampleReviewPreparedContext(
  value: Record<string, unknown>,
): ReviewPreparedContext {
  return {
    diffText: asString(
      value.diffText,
      'diff --git a/src/demo.ts b/src/demo.ts\n+export const demo = true;',
    ),
    changedFiles: asStringArray(value.changedFiles).length > 0
      ? asStringArray(value.changedFiles)
      : ['src/demo.ts'],
    baseSha: asString(value.baseSha, '(none)'),
    headSha: asString(value.headSha, 'preview-head-sha'),
    branch: asString(value.branch, 'main'),
    ref: asString(value.ref, 'refs/heads/main'),
    actor: asString(value.actor, 'preview-user'),
    commitSummaryLines: asStringArray(value.commitSummaryLines),
    commitDetails: [],
    projectContextBlocks: asStringArray(value.projectContextBlocks),
  };
}

function buildSampleRepoReviewFindings(value: unknown): RepoReviewRunFinding[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .map((item) => ({
      severity: (asString(item.severity, 'medium') as 'high' | 'medium' | 'low'),
      file: asString(item.file, ''),
      title: asString(item.title, ''),
      detail: asString(item.detail, ''),
      suggestion: asString(item.suggestion, ''),
    }))
    .filter((item) => item.title);
}

const PROMPT_PREVIEW_SCENARIOS: PromptPreviewScenario[] = [
  {
    id: 'conversation.runtime',
    title: t('errors.auto_3b334e', {}, undefined),
    description: t('errors.auto_f730c0', {}, undefined),
    featureScope: 'conversation',
    kind: 'conversation',
    targetUserMode: 'optional',
    defaultVariables: {
      chatJid: 'web:demo',
      messageText: t('errors.auto_ec0a83', {}, undefined),
      senderName: 'preview-user',
    },
  },
  {
    id: 'soul.runtime',
    title: t('errors.auto_d3065a', {}, undefined),
    description: t('errors.auto_8d5a69', {}, undefined),
    featureScope: 'soul',
    promptKey: 'soul.runtime',
    kind: 'runtime_prompt',
    targetUserMode: 'required',
    defaultVariables: {
      chatJid: 'web:preview',
      currentMessages: t('errors.auto_69da9d', {}, undefined),
    },
  },
  {
    id: 'runner.codex_runtime',
    title: 'Runner Codex runtime',
    description: 'Codex runner stable system prompt preview.',
    featureScope: 'runner',
    promptKey: 'runner.preview.codex_runtime',
    kind: 'runtime_prompt',
    defaultVariables: {
      projectDir: '/workspace/group',
      managedSkillIds: ['imagegen'],
    },
  },
  {
    id: 'runner.codex_scheduled_runtime',
    title: 'Runner Codex scheduled runtime',
    description: 'Codex scheduled task lightweight runtime prompt preview.',
    featureScope: 'runner',
    promptKey: 'runner.preview.codex_scheduled_runtime',
    kind: 'runtime_prompt',
    defaultVariables: {
      projectDir: '/workspace/group',
      managedSkillIds: ['imagegen'],
    },
  },
  {
    id: 'runner.claude_runtime',
    title: 'Runner Claude runtime',
    description: 'Claude runner stable system prompt preview.',
    featureScope: 'runner',
    promptKey: 'runner.preview.claude_runtime',
    kind: 'runtime_prompt',
    defaultVariables: {
      projectDir: '/workspace/group',
      managedSkillIds: ['imagegen'],
    },
  },
  {
    id: 'runner.claude_scheduled_runtime',
    title: 'Runner Claude scheduled runtime',
    description: 'Claude scheduled task lightweight runtime prompt preview.',
    featureScope: 'runner',
    promptKey: 'runner.preview.claude_scheduled_runtime',
    kind: 'runtime_prompt',
    defaultVariables: {
      projectDir: '/workspace/group',
      managedSkillIds: ['imagegen'],
    },
  },
  {
    id: 'repo_review.primary',
    title: 'Repo Review primary',
    description: '主审查 prompt 预览。',
    featureScope: 'repo_review',
    promptKey: 'repo_review.primary',
    kind: 'runtime_prompt',
    defaultVariables: {
      repository: {
        name: 'nanoclaw',
        language: 'TypeScript',
        defaultTargetBranch: 'main',
        reviewChatJid: 'web:repo-review-preview',
      },
      profile: {
        name: '默认审查配置',
        stage: 'push',
        sourceMode: 'local',
        blockingMode: 'off',
        passDecisionMode: 'ai',
        reviewScope: 'branch',
        promptTemplate: '',
        includeFullFileContext: false,
        maxFiles: 30,
        maxDiffBytes: 120000,
        reviewOutputMode: 'message',
        diffSubagentThreshold: 15,
      },
      event: {
        source: 'local-hook',
        stage: 'push',
        actor: 'alice',
        branch: 'main',
        ref: 'refs/heads/main',
      },
      prepared: {
        diffText: 'diff --git a/src/demo.ts b/src/demo.ts\n+export const demo = true;',
        changedFiles: ['src/demo.ts'],
        baseSha: '(none)',
        headSha: 'preview-head-sha',
        branch: 'main',
        ref: 'refs/heads/main',
        actor: 'alice',
        commitSummaryLines: ['preview commit'],
        projectContextBlocks: ['TypeScript monorepo.'],
      },
    },
  },
  {
    id: 'repo_review.agentic_plan',
    title: 'Repo Review main plan',
    description: 'Agentic 主计划 prompt 预览。',
    featureScope: 'repo_review',
    promptKey: 'repo_review.agentic_plan',
    kind: 'runtime_prompt',
    defaultVariables: {
      repository: {
        name: 'nanoclaw',
        language: 'TypeScript',
        defaultTargetBranch: 'main',
        reviewChatJid: 'web:repo-review-preview',
      },
      profile: {
        name: '默认审查配置',
        stage: 'push',
        sourceMode: 'local',
        blockingMode: 'off',
        passDecisionMode: 'ai',
        reviewScope: 'branch',
        promptTemplate: '',
        includeFullFileContext: false,
        maxFiles: 30,
        maxDiffBytes: 120000,
        reviewOutputMode: 'message',
        diffSubagentThreshold: 15,
      },
      event: {
        source: 'local-hook',
        stage: 'push',
        actor: 'alice',
        branch: 'main',
        ref: 'refs/heads/main',
      },
      prepared: {
        changedFiles: ['src/demo.ts'],
        baseSha: '(none)',
        headSha: 'preview-head-sha',
        branch: 'main',
        ref: 'refs/heads/main',
        actor: 'alice',
        commitSummaryLines: ['preview commit'],
      },
    },
  },
  {
    id: 'repo_review.agentic_subagent',
    title: 'Repo Review subagent',
    description: 'Agentic 子代理 prompt 预览。',
    featureScope: 'repo_review',
    promptKey: 'repo_review.agentic_subagent',
    kind: 'runtime_prompt',
    defaultVariables: {
      repository: {
        name: 'nanoclaw',
        language: 'TypeScript',
        defaultTargetBranch: 'main',
        reviewChatJid: 'web:repo-review-preview',
      },
      profile: {
        name: '默认审查配置',
        stage: 'push',
        sourceMode: 'local',
        blockingMode: 'off',
        passDecisionMode: 'ai',
        reviewScope: 'branch',
        promptTemplate: '',
        includeFullFileContext: true,
        maxFiles: 30,
        maxDiffBytes: 120000,
        reviewOutputMode: 'message',
        diffSubagentThreshold: 15,
      },
      prepared: {
        changedFiles: ['src/demo.ts'],
        baseSha: '(none)',
        headSha: 'preview-head-sha',
        branch: 'main',
        ref: 'refs/heads/main',
        actor: 'alice',
      },
      taskId: 'task-1',
      taskTitle: '审查 demo.ts',
      taskObjective: '确认 demo.ts 的改动是否安全',
      taskFocus: '接口和测试覆盖',
      taskFiles: ['src/demo.ts'],
      fullFileFiles: ['src/demo.ts'],
      diffSlice: 'diff --git a/src/demo.ts b/src/demo.ts\n+export const demo = true;',
    },
  },
  {
    id: 'repo_review.agentic_final',
    title: 'Repo Review final report',
    description: 'Agentic 最终报告 prompt 预览。',
    featureScope: 'repo_review',
    promptKey: 'repo_review.agentic_final',
    kind: 'runtime_prompt',
    defaultVariables: {
      repository: {
        name: 'nanoclaw',
        language: 'TypeScript',
        defaultTargetBranch: 'main',
        reviewChatJid: 'web:repo-review-preview',
      },
      profile: {
        name: '默认审查配置',
        stage: 'push',
        sourceMode: 'local',
        blockingMode: 'off',
        passDecisionMode: 'ai',
        reviewScope: 'branch',
        promptTemplate: '',
        includeFullFileContext: false,
        maxFiles: 30,
        maxDiffBytes: 120000,
        reviewOutputMode: 'message',
        diffSubagentThreshold: 15,
      },
      event: {
        source: 'local-hook',
        stage: 'push',
        actor: 'alice',
        branch: 'main',
        ref: 'refs/heads/main',
      },
      prepared: {
        changedFiles: ['src/demo.ts'],
        baseSha: '(none)',
        headSha: 'preview-head-sha',
        branch: 'main',
        ref: 'refs/heads/main',
        actor: 'alice',
        commitSummaryLines: ['preview commit'],
      },
      reviewPlan: {
        review_plan: {
          should_delegate: true,
          delegation_reason: '预览任务分发',
          tasks: [
            {
              id: 'task-1',
              title: '审查 demo.ts',
              objective: '确认 demo.ts 的改动是否安全',
              files: ['src/demo.ts'],
              focus: '接口和测试覆盖',
              full_file_files: ['src/demo.ts'],
            },
          ],
          full_file_review_files: ['src/demo.ts'],
          risk_areas: ['接口边界'],
          notes: ['预览'],
        },
      },
      subagentResults: [
        {
          task: {
            id: 'task-1',
            title: '审查 demo.ts',
            objective: '确认 demo.ts 的改动是否安全',
            files: ['src/demo.ts'],
            focus: '接口和测试覆盖',
            fullFileFiles: ['src/demo.ts'],
          },
          checked_files: ['src/demo.ts'],
          read_evidence: [
            {
              file: 'src/demo.ts',
              evidence: 'export const demo = true;',
              lines: '1-1',
            },
          ],
          findings: [],
          file_reviews: [],
          scope_limitations: [],
          confidence: 'high',
          failed: false,
        },
      ],
    },
  },
  {
    id: 'repo_review.agentic_extractor',
    title: 'Repo Review structured extractor',
    description: 'Agentic 结构化提取 prompt 预览。',
    featureScope: 'repo_review',
    promptKey: 'repo_review.agentic_extractor',
    kind: 'runtime_prompt',
    defaultVariables: {
      mainReportMarkdown: '代码审查报告\n\n一、审查总结\n分支结论：通过',
      subagentResults: '[]',
    },
  },
  {
    id: 'repo_review.supplemental_file',
    title: 'Repo Review supplemental file',
    description: '全文件补充审查的单文件 prompt 预览。',
    featureScope: 'repo_review',
    promptKey: 'repo_review.supplemental_file',
    kind: 'runtime_prompt',
    defaultVariables: {
      repository: {
        name: 'nanoclaw',
        language: 'TypeScript',
        defaultTargetBranch: 'main',
        reviewChatJid: 'web:repo-review-preview',
      },
      profile: {
        name: '默认审查配置',
        stage: 'push',
        sourceMode: 'local',
        blockingMode: 'off',
        passDecisionMode: 'ai',
        reviewScope: 'branch',
        promptTemplate: '',
        includeFullFileContext: true,
        maxFiles: 30,
        maxDiffBytes: 120000,
        reviewOutputMode: 'message',
        diffSubagentThreshold: 15,
      },
      prepared: {
        diffText: 'diff --git a/src/demo.ts b/src/demo.ts\n+export const demo = true;',
        changedFiles: ['src/demo.ts'],
        baseSha: '(none)',
        headSha: 'preview-head-sha',
        branch: 'main',
        ref: 'refs/heads/main',
        actor: 'alice',
      },
      filePath: 'src/demo.ts',
      fileDiff: 'diff --git a/src/demo.ts b/src/demo.ts\n+export const demo = true;',
      fileContent: 'export const demo = true;\n',
      relatedFindings: [],
      primarySummary: '主审查未发现明确阻断风险。',
    },
  },
  {
    id: 'repo_review.digest',
    title: 'Repo Review digest',
    description: '代码日报 / 周报 prompt 预览。',
    featureScope: 'repo_review',
    promptKey: 'repo_review.digest',
    kind: 'runtime_prompt',
    defaultVariables: {
      data: {
        repositoryName: 'nanoclaw',
        periodStart: '2026-04-28T00:00:00.000Z',
        periodEnd: '2026-04-29T00:00:00.000Z',
        type: 'daily',
        branches: [],
        totalCommits: 2,
        totalContributors: ['alice'],
        sampledCommits: [],
        defaultBranch: 'main',
      },
    },
  },
  {
    id: 'stock_analysis.news_intel',
    title: t('errors.auto_04c5d9', {}, undefined),
    description: t('errors.auto_eba644', {}, undefined),
    featureScope: 'stock_analysis',
    promptKey: 'stock_analysis.news_intel',
    kind: 'runtime_prompt',
    defaultVariables: {
      params: {
        stockCode: '600519',
        stockName: t('errors.auto_cfcab0', {}, undefined),
        market: 'cn',
        strategy: {
          id: 'trend',
          label: t('errors.auto_b35610', {}, undefined),
          description: t('errors.auto_26ff9c', {}, undefined),
        },
        metrics: {
          currentPrice: 1688,
          changePct: 1.2,
          ma5: 1670,
          ma10: 1650,
          ma20: 1620,
          ma60: 1580,
          maAligned: true,
          macdDiff: 1.1,
          macdSignal: 0.9,
          macdState: 'golden_cross',
          rsi14: 58,
          rsiState: 'neutral',
          volumeState: 'normal',
          trendState: 'uptrend',
        },
        newsLookbackDays: 7,
        newsMaxReferences: 3,
      },
      focus: 'stock_news',
    },
  },
  {
    id: 'stock_analysis.ai_summary',
    title: t('errors.auto_c03de1', {}, undefined),
    description: t('errors.auto_e34ac2', {}, undefined),
    featureScope: 'stock_analysis',
    promptKey: 'stock_analysis.ai_summary',
    kind: 'runtime_prompt',
    defaultVariables: {
      params: {
        stockCode: '600519',
        stockName: t('errors.auto_cfcab0', {}, undefined),
        market: 'cn',
        metrics: {
          trendState: 'uptrend',
          maAligned: true,
          volumeState: 'normal',
          macdState: 'golden_cross',
          rsiState: 'neutral',
        },
        strategy: {
          id: 'trend',
          label: t('errors.auto_b35610', {}, undefined),
          description: t('errors.auto_26ff9c', {}, undefined),
        },
        aiSummaryStyle: 'professional',
        heuristic: {
          score: 78,
          trend: 'uptrend',
          recommendation: 'wait_breakout',
          riskSignals: [t('errors.auto_281c75', {}, undefined)],
          catalystSignals: [t('errors.auto_60b7ce', {}, undefined)],
        },
        factorScores: [],
        tradePlan: {},
        newsIntel: {},
      },
    },
  },
  {
    id: 'stock_analysis.market_review',
    title: t('errors.auto_511317', {}, undefined),
    description: t('errors.auto_03ff35', {}, undefined),
    featureScope: 'stock_analysis',
    promptKey: 'stock_analysis.market_review',
    kind: 'runtime_prompt',
    defaultVariables: {
      params: {
        reviewData: {
          marketScope: 'cn',
          overview: t('errors.auto_b76484', {}, undefined),
          leadingSectors: [t('errors.auto_5c6b24', {}, undefined), t('errors.auto_7798d3', {}, undefined)],
        },
      },
    },
  },
  {
    id: 'requirement_parser.base',
    title: t('errors.auto_afaafb', {}, undefined),
    description: t('errors.auto_a87b45', {}, undefined),
    featureScope: 'requirement_parser',
    promptKey: 'requirement_parser.base',
    kind: 'runtime_prompt',
    defaultVariables: {
      rawInput: t('errors.auto_db48c6', {}, undefined),
    },
  },
];

export function getPromptPreviewScenarios(): PromptPreviewScenario[] {
  return PROMPT_PREVIEW_SCENARIOS;
}

export function getPromptPreviewScenario(
  id: string,
): PromptPreviewScenario | undefined {
  return PROMPT_PREVIEW_SCENARIOS.find((scenario) => scenario.id === id);
}

export async function buildPromptPreviewFromRuntime(input: {
  promptKey: string;
  targetUserId?: string | null;
  variables?: Record<string, unknown>;
}): Promise<PromptPreviewEnvelope | null> {
  const promptKey = input.promptKey;
  const vars = input.variables || {};

  if (promptKey === 'assistant.soul.primary_policy_wrapper') {
    const text = await buildConversationSoulSystemPrompt(
      asString(vars.soulPrompt, t('errors.auto_93263c', {}, undefined)),
    );
    return buildPromptPreviewEnvelope({
      traceKind: 'direct_provider',
      featureScope: 'conversation',
      promptKey,
      targetUserId: input.targetUserId || null,
      systemPromptText: text,
      userPromptText: '',
      providerInputText: '',
      segments: [segmentForPrompt(promptKey, t('errors.auto_5dafe8', {}, undefined), text)],
      resolution: [],
    });
  }

  if (promptKey === 'soul.runtime') {
    const targetUserId = input.targetUserId?.trim();
    if (!targetUserId) return null;
    const text = await buildSoulPrompt(
      targetUserId,
      asString(vars.chatJid, 'web:preview'),
      asString(vars.currentMessages, t('errors.auto_7eca68', {}, undefined)),
    );
    return buildPromptPreviewEnvelope({
      traceKind: 'direct_provider',
      featureScope: 'soul',
      promptKey,
      targetUserId,
      systemPromptText: text,
      userPromptText: '',
      providerInputText: '',
      segments: [segmentForPrompt(promptKey, t('errors.auto_e5b79c', {}, undefined), text)],
      resolution: [],
    });
  }

  if (
    promptKey === 'runner.preview.codex_runtime' ||
    promptKey === 'runner.preview.claude_runtime' ||
    promptKey === 'runner.preview.codex_scheduled_runtime' ||
    promptKey === 'runner.preview.claude_scheduled_runtime'
  ) {
    return buildRunnerPromptPreview({
      providerType:
        promptKey === 'runner.preview.codex_runtime' ||
        promptKey === 'runner.preview.codex_scheduled_runtime'
          ? 'codex'
          : 'claude',
      systemPromptProfile:
        promptKey === 'runner.preview.codex_scheduled_runtime' ||
        promptKey === 'runner.preview.claude_scheduled_runtime'
          ? 'scheduled_lightweight'
          : 'default_agent',
      targetUserId: input.targetUserId || null,
      projectDir: asString(vars.projectDir, '/workspace/group'),
      managedSkillIds: asStringArray(vars.managedSkillIds),
      userSkillIds: asStringArray(vars.userSkillIds),
      extraDirectories: Array.isArray(vars.extraDirectories)
        ? vars.extraDirectories
            .map((entry) => asRecord(entry))
            .map((entry, index) => ({
              label: asString(entry.label, `extra-${index + 1}`),
              hostPath: asString(entry.hostPath, ''),
            }))
            .filter((entry) => entry.hostPath)
        : [],
    });
  }

  if (promptKey === 'requirement_parser.base') {
    const text = buildParserPrompt(
      asString(vars.rawInput, t('errors.auto_cdaf62', {}, undefined)),
    );
    return buildPromptPreviewEnvelope({
      traceKind: 'direct_provider',
      featureScope: 'requirement_parser',
      promptKey,
      targetUserId: input.targetUserId || null,
      userPromptText: text,
      providerInputText: text,
      segments: [segmentForPrompt(promptKey, t('errors.auto_03f28f', {}, undefined), text)],
      resolution: [],
    });
  }

  if (promptKey === 'im.ai_invocation') {
    const text = renderPromptTemplate(
      getPromptDefinition(promptKey)?.defaultTemplate || '',
      {
        transcript: asString(
          vars.transcript,
          'Alice: 先看一下今天的异常\nBot: 已记录\nAlice: 帮我总结重点',
        ),
        requestedBy: asString(vars.requestedBy, 'alice'),
        request: asString(vars.request, '帮我总结重点'),
      },
    );
    return buildPromptPreviewEnvelope({
      traceKind: 'direct_provider',
      featureScope: 'im',
      promptKey,
      targetUserId: input.targetUserId || null,
      userPromptText: asString(vars.request, '帮我总结重点'),
      providerInputText: text,
      segments: [segmentForPrompt(promptKey, 'IM AI invocation', text)],
      resolution: [],
    });
  }

  if (promptKey.startsWith('stock_analysis.')) {
    if (promptKey === 'stock_analysis.news_intel') {
      const params = asRecord(vars.params) as unknown as NewsIntelPromptParams;
      const text = await buildNewsIntelPrompt(
        params.stockCode
          ? params
          : {
              stockCode: '600519',
              stockName: t('errors.auto_cfcab0', {}, undefined),
              market: 'cn' as any,
              metrics: {
                currentPrice: 1688,
                changePct: 1.2,
                ma5: 1670,
                ma10: 1650,
                ma20: 1620,
                ma60: 1580,
                maAligned: true,
                macdDiff: 1.1,
                macdSignal: 0.9,
                macdState: 'golden_cross',
                rsi14: 58,
                rsiState: 'neutral',
                volumeState: 'normal',
                trendState: 'uptrend',
              } as any,
              strategy: {
                id: 'trend',
                label: t('errors.auto_b35610', {}, undefined),
                description: t('errors.auto_26ff9c', {}, undefined),
              } as any,
              newsLookbackDays: 7,
              newsMaxReferences: 3,
            },
        (asString(vars.focus, 'stock_news') as NewsIntelPromptFocus),
      );
      return buildPromptPreviewEnvelope({
        traceKind: 'direct_provider',
        featureScope: 'stock_analysis',
        promptKey,
        targetUserId: input.targetUserId || null,
        userPromptText: text,
        providerInputText: text,
        segments: [segmentForPrompt(promptKey, t('errors.auto_c1b7ff', {}, undefined), text)],
        resolution: [],
      });
    }
    if (promptKey === 'stock_analysis.news_intel_snippet') {
      const params = asRecord(vars.params) as unknown as NewsIntelSnippetPromptParams;
      const text = await buildNewsIntelSnippetPrompt(
        params.stockCode
          ? params
          : {
              stockCode: '600519',
              stockName: t('errors.auto_cfcab0', {}, undefined),
              market: 'cn' as any,
              metrics: {
                currentPrice: 1688,
                changePct: 1.2,
                maAligned: true,
                macdState: 'golden_cross',
                rsiState: 'neutral',
                volumeState: 'normal',
                trendState: 'uptrend',
              } as any,
              strategy: {
                id: 'trend',
                label: t('errors.auto_b35610', {}, undefined),
                description: t('errors.auto_26ff9c', {}, undefined),
              } as any,
              newsLookbackDays: 7,
              newsMaxReferences: 3,
              sourceLabel: 'preview-snippets',
              snippets: [
                {
                  title: t('errors.auto_c8d79e', {}, undefined),
                  source: t('errors.auto_4be0ef', {}, undefined),
                  publishedAt: '2026-04-29',
                  summary: t('errors.auto_bd54ba', {}, undefined),
                  url: null,
                },
              ] as any,
            },
      );
      return buildPromptPreviewEnvelope({
        traceKind: 'direct_provider',
        featureScope: 'stock_analysis',
        promptKey,
        targetUserId: input.targetUserId || null,
        userPromptText: text,
        providerInputText: text,
        segments: [segmentForPrompt(promptKey, t('errors.auto_8433ca', {}, undefined), text)],
        resolution: [],
      });
    }
    if (promptKey === 'stock_analysis.ai_summary') {
      const params = asRecord(vars.params) as unknown as AiSummaryPromptParams;
      const text = await buildAiSummaryPrompt(
        params.stockCode
          ? params
          : {
              stockCode: '600519',
              stockName: t('errors.auto_cfcab0', {}, undefined),
              market: 'cn' as any,
              metrics: { trendState: 'uptrend', maAligned: true, volumeState: 'normal', macdState: 'golden_cross', rsiState: 'neutral' } as any,
              strategy: { id: 'trend', label: t('errors.auto_b35610', {}, undefined), description: t('errors.auto_26ff9c', {}, undefined) } as any,
              aiSummaryStyle: 'professional',
              heuristic: {
                score: 78,
                trend: 'uptrend',
                recommendation: 'wait_breakout',
                riskSignals: [t('errors.auto_281c75', {}, undefined)],
                catalystSignals: [t('errors.auto_60b7ce', {}, undefined)],
              },
              factorScores: [] as any,
              tradePlan: {} as any,
              newsIntel: {} as any,
            },
      );
      return buildPromptPreviewEnvelope({
        traceKind: 'direct_provider',
        featureScope: 'stock_analysis',
        promptKey,
        targetUserId: input.targetUserId || null,
        userPromptText: text,
        providerInputText: text,
        segments: [segmentForPrompt(promptKey, t('errors.auto_277e78', {}, undefined), text)],
        resolution: [],
      });
    }
    if (promptKey === 'stock_analysis.market_review') {
      const params = asRecord(vars.params) as unknown as MarketReviewPromptParams;
      const text = await buildMarketReviewPrompt(
        params.reviewData
          ? params
          : {
              reviewData: {
                marketScope: 'cn',
                overview: t('errors.auto_b76484', {}, undefined),
                leadingSectors: [t('errors.auto_5c6b24', {}, undefined), t('errors.auto_7798d3', {}, undefined)],
              },
            },
      );
      return buildPromptPreviewEnvelope({
        traceKind: 'direct_provider',
        featureScope: 'stock_analysis',
        promptKey,
        targetUserId: input.targetUserId || null,
        userPromptText: text,
        providerInputText: text,
        segments: [segmentForPrompt(promptKey, t('errors.auto_d3c3aa', {}, undefined), text)],
        resolution: [],
      });
    }
  }

  if (promptKey.startsWith('repo_review.')) {
    if (promptKey === 'repo_review.digest') {
      const data = asRecord(vars.data);
      const resolved = await resolveDigestPrompt({
        repositoryName: asString(data.repositoryName, 'nanoclaw'),
        periodStart: asString(data.periodStart, '2026-04-28T00:00:00.000Z'),
        periodEnd: asString(data.periodEnd, '2026-04-29T00:00:00.000Z'),
        type: (asString(data.type, 'daily') as any),
        branches: Array.isArray(data.branches) ? (data.branches as any) : [],
        totalCommits: Number(data.totalCommits || 2),
        totalContributors: asStringArray(data.totalContributors).length > 0
          ? asStringArray(data.totalContributors)
          : ['alice'],
        sampledCommits: Array.isArray(data.sampledCommits) ? (data.sampledCommits as any) : [],
        categorySummary: {} as any,
        defaultBranch: asString(data.defaultBranch, 'main'),
      });
      const text = resolved.text;
      return buildPromptPreviewEnvelope({
        traceKind: 'direct_provider',
        featureScope: 'repo_review',
        promptKey,
        targetUserId: input.targetUserId || null,
        userPromptText: text,
        providerInputText: text,
        segments: [segmentForPrompt(promptKey, 'Repo Review digest', text, resolved.resolution.source)],
        resolution: [resolved.resolution],
      });
    }

    const repository = buildSampleRepoReviewRepository(asRecord(vars.repository));
    const profile = buildSampleRepoReviewProfile(asRecord(vars.profile));
    const event = buildSampleRepoReviewEvent(asRecord(vars.event));
    const prepared = buildSampleReviewPreparedContext(asRecord(vars.prepared));

  if (promptKey === 'repo_review.primary') {
      const resolved = await resolveReviewPrompt({
        repository,
        profile,
        event,
        prepared,
        targetUserId: input.targetUserId || undefined,
      });
      const text = resolved.text;
      return buildPromptPreviewEnvelope({
        traceKind: 'direct_provider',
        featureScope: 'repo_review',
        promptKey,
        targetUserId: input.targetUserId || null,
        userPromptText: text,
        providerInputText: text,
        segments: [segmentForPrompt(promptKey, 'Repo Review primary', text, resolved.resolution.source)],
        resolution: [resolved.resolution],
      });
    }

    if (promptKey === 'repo_review.agentic_plan') {
      const budget = {
        maxSubagents: 2,
        delegationFileThreshold: 15,
        fullFileReviewEnabled: profile.includeFullFileContext,
        maxFullFileBytesPerFile: 64000,
        maxTotalReadBytes: 240000,
        maxReviewRounds: 2,
        extractorEnabled: true,
      };
      const resolved = await resolveRepoReviewAgenticPlanPrompt({
        repository,
        profile: profile as any,
        event,
        prepared,
        budget: budget as any,
        targetUserId: input.targetUserId || undefined,
      });
      const text = resolved.text;
      return buildPromptPreviewEnvelope({
        traceKind: 'direct_provider',
        featureScope: 'repo_review',
        promptKey,
        targetUserId: input.targetUserId || null,
        userPromptText: text,
        providerInputText: text,
        segments: [segmentForPrompt(promptKey, 'Repo Review main plan', text, resolved.resolution.source)],
        resolution: [resolved.resolution],
      });
    }

    if (promptKey === 'repo_review.worker') {
      const resolved = await resolvePromptText({
        promptKey,
        targetUserId: input.targetUserId || undefined,
        variables: {
          repositoryName: repository.name,
          primaryLanguageBlock: repository.language ? `主要语言：${repository.language}` : '',
          stage: event.stage,
          source: event.source,
          actor: prepared.actor || '(unknown)',
          branch: prepared.branch || '(unknown)',
          baseSha: prepared.baseSha || '(none)',
          headSha: prepared.headSha || '(none)',
          diffRange: prepared.baseSha && prepared.headSha ? `${prepared.baseSha}..${prepared.headSha}` : 'HEAD',
          workerId: 'worker_chunk_1',
          workerTitle: 'Worker 1/1',
          workerFiles: prepared.changedFiles.map((file) => `- ${file}`).join('\n') || '- (none)',
          workerEvidence: prepared.changedFiles.length > 0
            ? prepared.changedFiles.map((file) => `### ${file}\n- diff bytes: ${Buffer.byteLength(prepared.diffText || '', 'utf8')}`).join('\n\n')
            : '(no evidence)',
          customPromptBlock: repository && (profile.promptTemplate || '').trim()
            ? `附加审查要求：\n${profile.promptTemplate.trim()}`
            : '',
        },
      });
      const text = resolved.text;
      return buildPromptPreviewEnvelope({
        traceKind: 'direct_provider',
        featureScope: 'repo_review',
        promptKey,
        targetUserId: input.targetUserId || null,
        userPromptText: text,
        providerInputText: text,
        segments: [segmentForPrompt(promptKey, 'Repo Review worker', text, resolved.resolution.source)],
        resolution: [resolved.resolution],
      });
    }

    if (promptKey === 'repo_review.reducer') {
      const resolved = await resolvePromptText({
        promptKey,
        targetUserId: input.targetUserId || undefined,
        variables: {
          repositoryName: repository.name,
          primaryLanguageBlock: repository.language ? `主要语言：${repository.language}` : '',
          stage: event.stage,
          source: event.source,
          actor: prepared.actor || '(unknown)',
          branch: prepared.branch || '(unknown)',
          baseSha: prepared.baseSha || '(none)',
          headSha: prepared.headSha || '(none)',
          diffRange: prepared.baseSha && prepared.headSha ? `${prepared.baseSha}..${prepared.headSha}` : 'HEAD',
          changedFiles: prepared.changedFiles.map((file) => `- ${file}`).join('\n') || '- (none)',
          workerResults: '[]',
          customPromptBlock: repository && (profile.promptTemplate || '').trim()
            ? `附加审查要求：\n${profile.promptTemplate.trim()}`
            : '',
        },
      });
      const text = resolved.text;
      return buildPromptPreviewEnvelope({
        traceKind: 'direct_provider',
        featureScope: 'repo_review',
        promptKey,
        targetUserId: input.targetUserId || null,
        userPromptText: text,
        providerInputText: text,
        segments: [segmentForPrompt(promptKey, 'Repo Review reducer', text, resolved.resolution.source)],
        resolution: [resolved.resolution],
      });
    }

    if (promptKey === 'repo_review.agentic_subagent') {
      const budget = {
        maxSubagents: 2,
        delegationFileThreshold: 15,
        fullFileReviewEnabled: profile.includeFullFileContext,
        maxFullFileBytesPerFile: 64000,
        maxTotalReadBytes: 240000,
        maxReviewRounds: 2,
        extractorEnabled: true,
      };
      const resolved = await resolveRepoReviewAgenticSubagentPrompt({
        repository,
        profile: profile as any,
        event,
        prepared,
        budget: budget as any,
        task: {
          id: asString(vars.taskId, 'task-1'),
          title: asString(vars.taskTitle, '审查 demo.ts'),
          objective: asString(vars.taskObjective, '确认 demo.ts 的改动是否安全'),
          files: asStringArray(vars.taskFiles).length > 0 ? asStringArray(vars.taskFiles) : ['src/demo.ts'],
          focus: asString(vars.taskFocus, '接口和测试覆盖'),
          fullFileFiles: asStringArray(vars.fullFileFiles).length > 0 ? asStringArray(vars.fullFileFiles) : ['src/demo.ts'],
        },
        targetUserId: input.targetUserId || undefined,
      });
      const text = resolved.text;
      return buildPromptPreviewEnvelope({
        traceKind: 'direct_provider',
        featureScope: 'repo_review',
        promptKey,
        targetUserId: input.targetUserId || null,
        userPromptText: text,
        providerInputText: text,
        segments: [segmentForPrompt(promptKey, 'Repo Review subagent', text, resolved.resolution.source)],
        resolution: [resolved.resolution],
      });
    }

    if (promptKey === 'repo_review.agentic_final') {
      const budget = {
        maxSubagents: 2,
        delegationFileThreshold: 15,
        fullFileReviewEnabled: profile.includeFullFileContext,
        maxFullFileBytesPerFile: 64000,
        maxTotalReadBytes: 240000,
        maxReviewRounds: 2,
        extractorEnabled: true,
      };
      const resolved = await resolveRepoReviewAgenticFinalPrompt({
        repository,
        profile: profile as any,
        event,
        prepared,
        budget: budget as any,
        plan: {
          shouldDelegate: true,
          delegationReason: '预览任务分发',
          tasks: [
            {
              id: 'task-1',
              title: '审查 demo.ts',
              objective: '确认 demo.ts 的改动是否安全',
              files: ['src/demo.ts'],
              focus: '接口和测试覆盖',
              fullFileFiles: ['src/demo.ts'],
            },
          ],
          fullFileReviewFiles: ['src/demo.ts'],
          riskAreas: ['接口边界'],
          notes: ['预览'],
          rawPlan: { review_plan: { should_delegate: true, tasks: [] } },
        } as any,
        subagentResults: [
          {
            task: {
              id: 'task-1',
              title: '审查 demo.ts',
              objective: '确认 demo.ts 的改动是否安全',
              files: ['src/demo.ts'],
              focus: '接口和测试覆盖',
              fullFileFiles: ['src/demo.ts'],
            },
            checkedFiles: ['src/demo.ts'],
            readEvidence: [
              {
                file: 'src/demo.ts',
                evidence: 'export const demo = true;',
                lines: '1-1',
              },
            ],
            findings: [],
            fileReviews: [],
            scopeLimitations: [],
            confidence: 'high',
            failed: false,
            rawOutput: '',
          } as any,
        ],
        targetUserId: input.targetUserId || undefined,
      });
      const text = resolved.text;
      return buildPromptPreviewEnvelope({
        traceKind: 'direct_provider',
        featureScope: 'repo_review',
        promptKey,
        targetUserId: input.targetUserId || null,
        userPromptText: text,
        providerInputText: text,
        segments: [segmentForPrompt(promptKey, 'Repo Review final report', text, resolved.resolution.source)],
        resolution: [resolved.resolution],
      });
    }

    if (promptKey === 'repo_review.agentic_extractor') {
      const resolved = await resolveRepoReviewAgenticExtractorPrompt({
        mainReportMarkdown: asString(vars.mainReportMarkdown, '代码审查报告'),
        subagentResults: [],
        subagentResultsText: asString(vars.subagentResults, '[]'),
        targetUserId: input.targetUserId || undefined,
      });
      const text = resolved.text;
      return buildPromptPreviewEnvelope({
        traceKind: 'direct_provider',
        featureScope: 'repo_review',
        promptKey,
        targetUserId: input.targetUserId || null,
        userPromptText: text,
        providerInputText: text,
        segments: [segmentForPrompt(promptKey, 'Repo Review structured extractor', text, resolved.resolution.source)],
        resolution: [resolved.resolution],
      });
    }

    if (promptKey === 'repo_review.supplemental_file') {
      const resolved = await resolveSupplementalFileReviewPrompt({
        repository,
        profile,
        prepared,
        filePath: asString(vars.filePath, 'src/demo.ts'),
        fileDiff: asString(
          vars.fileDiff,
          'diff --git a/src/demo.ts b/src/demo.ts\n+export const demo = true;',
        ),
        fileContent: asString(vars.fileContent, 'export const demo = true;\n'),
        relatedFindings: buildSampleRepoReviewFindings(vars.relatedFindings),
        primarySummary: asString(vars.primarySummary, '主审查未发现明确阻断风险。'),
        targetUserId: input.targetUserId || undefined,
      });
      const text = resolved.text;
      return buildPromptPreviewEnvelope({
        traceKind: 'direct_provider',
        featureScope: 'repo_review',
        promptKey,
        targetUserId: input.targetUserId || null,
        userPromptText: text,
        providerInputText: text,
        segments: [segmentForPrompt(promptKey, 'Repo Review supplemental file', text, resolved.resolution.source)],
        resolution: [resolved.resolution],
      });
    }
  }

  if (promptKey === 'code_map.repo_description') {
    const snapshot = asRecord(vars.snapshot);
    const text = buildRepoDescriptionPrompt(
      {
        repositoryId: asString(snapshot.repositoryId, 'preview-repo'),
        branch: asString(snapshot.branch, 'main'),
        manifestHash: '',
        stats: {
          fileCount: Number(snapshot.fileCount || 2),
          symbolCount: Number(snapshot.symbolCount || 10),
          edgeCount: Number(snapshot.edgeCount || 8),
          totalLines: Number(snapshot.totalLines || 120),
        },
        files: [],
      } as any,
      asString(vars.rootDir, process.cwd()),
    );
    return buildPromptPreviewEnvelope({
      traceKind: 'direct_provider',
      featureScope: 'code_map',
      promptKey,
      targetUserId: input.targetUserId || null,
      userPromptText: text,
      providerInputText: text,
      segments: [segmentForPrompt(promptKey, t('errors.auto_d9da13', {}, undefined), text)],
      resolution: [],
    });
  }

  return null;
}

export async function buildPromptPreviewFromScenario(input: {
  scenarioId: string;
  targetUserId?: string | null;
  variables?: Record<string, unknown>;
}): Promise<PromptPreviewEnvelope | null> {
  const scenario = getPromptPreviewScenario(input.scenarioId);
  if (!scenario) return null;
  if (!scenario.promptKey) return null;
  const mergedVariables = {
    ...(scenario.defaultVariables || {}),
    ...(input.variables || {}),
  };
  return buildPromptPreviewFromRuntime({
    promptKey: scenario.promptKey,
    targetUserId: input.targetUserId,
    variables: mergedVariables,
  });
}
