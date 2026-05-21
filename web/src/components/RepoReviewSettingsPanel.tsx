import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AppHeroHeader,
  Drawer,
  LibraryCard,
  NcSelect,
  NcToggle,
  SearchPill,
  TabBar,
} from './common';
import { Pagination } from './common/Pagination';
import { AppSelect, type AppSelectOption } from './AppSelect';
import {
  IconChat,
  IconCheck,
  IconChevronDown,
  IconFolder,
  IconRefresh,
  IconSearch,
  IconUsers,
  IconX,
} from './AppIcons';
import { RepoReviewActorMentionEditor } from './repo-review/RepoReviewActorMentionEditor';
import {
  fetchRepoReviewChatMembers,
  fetchRepoReviewDigestRunDetail,
  fetchRepoReviewDigestRuns,
  fetchRepoReviewRepositories,
  fetchRepoReviewRepositoryDetail,
  fetchRepoReviewRemoteBranches,
  fetchRepoReviewRunDetail,
  fetchRepoReviewRunSummaries,
  readRepoReviewJson,
  cancelRepoReviewRun,
  rerunRepoReviewRun,
  triggerRepoReviewManualBranch,
} from './repo-review/api';
import type {
  RepoReviewManualReviewMode,
  RepoReviewManualReviewRequest,
  RepoReviewBranchStateItem,
  RepoReviewOverview,
  RepoReviewRepositoryDetectionResponse,
  RepoReviewSingleBranchSyncResponse,
} from './repo-review/types';
import { RepoReviewBranchStatusModal } from './repo-review/RepoReviewBranchStatusModal';
import { RepoReviewProfileSection } from './repo-review/RepoReviewProfileSection';
import { RepoReviewDigestRunDetailModal } from './repo-review/RepoReviewDigestRunDetailModal';
import { RepoReviewRunDetailModal } from './repo-review/RepoReviewRunDetailModal';
import {
  buildReviewProgressEntries,
  filterReviewProgressEntriesForList,
  hasRepoReviewVisibleProgress,
  ReviewProgressTimeline,
} from './repo-review/ReviewProgressTimeline';
import {
  applyRepoReviewRealtimeEventToRun,
  getRepoReviewRunChatJid,
  mergeFetchedRepoReviewRunSnapshot,
  mergeRepoReviewRunListSnapshots,
  mergeRepoReviewRunSnapshot,
  sortRepoReviewRunsByLatestActivity,
} from './repo-review/run-list-helpers';
import { useRepoReviewBranchCache } from './repo-review/useRepoReviewBranchCache';
import type {
  ActorMentionDraftRow,
  ProfileDraft,
  RepositoryDraft,
} from './repo-review/draft-types';
import type {
  Conversation,
  RepoReviewDigestRun,
  RepoReviewBranchSummary,
  RepoReviewChatMember,
  RepoReviewRepositoryDetection,
  RepoReviewRepositoryRemoteOption,
  RepoReviewProfile,
  RepoReviewRepository,
  RepoReviewRun,
  SshKeyInfo,
} from '../app-types';
import { normalizeConversationRealtimeEvent } from '../conversation-realtime';
import { useWebSocket } from '../hooks/useWebSocket';
import i18n from '../i18n';
import type { CodeMapStats } from './code-map/code-map-api';
import { fetchCodeMapStats, rebuildCodeMap } from './code-map/code-map-api';
import { RepositoryRelationshipsPanel } from './repository/RepositoryRelationshipsPanel';
import { ProjectGraphPanel } from './repository/ProjectGraphPanel';
import { CodeMapPage } from '../pages/CodeMapPage';
import '../pages/WorkteamPage.css';

function CodeMapDrawerEntry({
  apiBase,
  repositoryId,
  defaultBranch,
  onOpen,
}: {
  apiBase: string;
  repositoryId: string;
  repositoryName: string;
  defaultBranch: string;
  onOpen: (branch: string) => void;
}) {
  const { t } = useTranslation('repoReview');
  const [branch, setBranch] = useState(defaultBranch);
  const [stats, setStats] = useState<CodeMapStats | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchCodeMapStats(apiBase, repositoryId, branch)
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiBase, repositoryId, branch]);

  const handleBuild = async () => {
    setRebuilding(true);
    setError('');
    try {
      await rebuildCodeMap(apiBase, repositoryId, branch);
      const s = await fetchCodeMapStats(apiBase, repositoryId, branch);
      setStats(s);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.codemap.buildFailed'),
      );
    } finally {
      setRebuilding(false);
    }
  };

  const isBuilt = stats && stats.status !== 'missing';

  return (
    <div className="repo-review-codemap-empty">
      <svg
        className="repo-review-codemap-icon"
        width="44"
        height="44"
        viewBox="0 0 48 48"
        fill="none"
      >
        <rect
          x="6"
          y="6"
          width="36"
          height="36"
          rx="4"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path d="M6 18h36M18 18v24" stroke="currentColor" strokeWidth="2" />
        <circle cx="30" cy="30" r="4" stroke="currentColor" strokeWidth="2" />
      </svg>
      <div className="repo-review-codemap-copy">
        <NcSelect
          className="repo-review-codemap-branch-select"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        >
          <option value={defaultBranch}>{defaultBranch}</option>
        </NcSelect>
        {isBuilt && stats ? (
          <div className="repo-review-codemap-stat-line">
            <span>
              {t('repoReview.codemap.built', {
                fileCount: stats.fileCount,
                symbolCount: stats.symbolCount,
                edgeCount: stats.edgeCount,
              })}
            </span>
          </div>
        ) : (
          <div className="repo-review-codemap-stat-line">
            {t('repoReview.codemap.notBuilt')}
          </div>
        )}
      </div>
      {error ? <div className="repo-review-codemap-error">{error}</div> : null}
      <div className="repo-review-codemap-actions">
        {!isBuilt ? (
          <button
            type="button"
            className="btn btn-primary repo-review-codemap-btn"
            onClick={handleBuild}
            disabled={rebuilding}
          >
            {rebuilding
              ? t('repoReview.codemap.building')
              : t('repoReview.codemap.build')}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary repo-review-codemap-btn"
          onClick={() => onOpen(branch)}
        >
          {t('repoReview.codemap.openFull')}
        </button>
      </div>
    </div>
  );
}

type RepoReviewSettingsPanelProps = {
  apiBase: string;
  pickNativeDirectory: () => Promise<string | null>;
  conversations: Conversation[];
  initialRepositoryId?: string;
  initialDetailTab?: RepoReviewPanelTab;
  onRepositoryRouteChange?: (
    repositoryId: string | null,
    tab?: RepoReviewPanelTab,
  ) => void;
  hideRepositoryList?: boolean;
  embedded?: boolean;
};

type RepoReviewPanelTab =
  | 'overview'
  | 'profile'
  | 'runs'
  | 'project-graph'
  | 'config'
  | 'codemap';

function stripBranchStateVisibility(
  item: RepoReviewBranchStateItem & { visible: boolean },
): RepoReviewBranchStateItem {
  return {
    name: item.name,
    defaultBranch: item.defaultBranch,
    headSha: item.headSha,
    actor: item.actor,
    title: item.title,
    latestCommitAt: item.latestCommitAt,
    isReviewing: item.isReviewing,
    lastRun: item.lastRun,
    targetProfiles: item.targetProfiles,
  };
}

type ActorMentionParseIssue = {
  level: 'error' | 'warning';
  line: number;
  message: string;
};

type ReviewIdentityCandidate = {
  actor: string;
  sources: string[];
  mappedMemberName: string;
};

type RepoReviewWorkspaceCardAction =
  | 'repository-source'
  | 'repository-delivery'
  | 'repository-autosync'
  | 'profile';

function renderWorkspaceCardIcon(
  action: RepoReviewWorkspaceCardAction,
): ReactNode {
  switch (action) {
    case 'repository-source':
      return <IconFolder />;
    case 'repository-delivery':
      return <IconChat />;
    case 'repository-autosync':
      return <IconRefresh />;
    case 'profile':
      return <IconUsers />;
    default:
      return <IconCheck />;
  }
}

function RepoReviewWorkspaceDetailSurface({
  embedded,
  open,
  onClose,
  children,
}: {
  embedded: boolean;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (embedded) {
    return <>{children}</>;
  }

  return (
    <Drawer open={open} onClose={onClose} width="min(100vw, 960px)">
      {children}
    </Drawer>
  );
}

type RepositoryEditorSection =
  | 'all'
  | 'source'
  | 'delivery'
  | 'autosync'
  | 'credentials';

type RepoReviewConfirmDialogState = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  tone: 'danger' | 'primary' | 'warning';
  pending: boolean;
  onConfirm: (() => Promise<void>) | null;
};

const AUTO_REVIEW_CHAT_VALUE = '__auto__';
const CUSTOM_REVIEW_CHAT_VALUE = '__custom__';
const REPO_REVIEW_ACTIVE_BRANCH_WINDOW_DAYS = 14;
const COMMON_LANGUAGES = [
  'TypeScript',
  'JavaScript',
  'Java',
  'Go',
  'Python',
  'Rust',
  'Kotlin',
  'C#',
  'C++',
  'Ruby',
  'PHP',
];
const EMPTY_REPOSITORY_DRAFT: RepositoryDraft = {
  name: '',
  language: 'TypeScript',
  localRepoPath: '',
  remoteProvider: '',
  remoteRepoSlug: '',
  remoteBaseUrl: '',
  cloneUrl: '',
  defaultTargetBranch: 'main',
  reviewChatJid: '',
  webhookSecret: '',
  platformToken: '',
  actorMentionDraftRows: [],
  actorMentionMappingsText: '',
  autoSyncEnabled: false,
  autoSyncIntervalMinutes: 30,
  digestDailyEnabled: false,
  digestWeeklyEnabled: false,
  digestDailyHour: 18,
  digestWeeklyDay: 5,
  digestWeeklyHour: 18,
  enabled: true,
  allowAiFix: false,
  sshKeyId: '',
};

const EMPTY_PROFILE_DRAFT: ProfileDraft = {
  repositoryId: '',
  name: '',
  stage: 'push',
  sourceMode: 'both',
  blockingMode: 'hard_fail',
  passDecisionMode: 'ai',
  reviewScope: 'commit_range',
  targetBranches: [],
  skillIds: [],
  promptTemplate: '',
  includeGlobsText: '',
  excludeGlobsText: '',
  includeFullFileContext: false,
  maxFiles: 80,
  maxDiffBytes: 200000,
  writeToChat: true,
  writeToPlatform: true,
  reviewOutputMode: 'share_link',
  diffSubagentThreshold: 15,
  subagentTimeoutSeconds: 420,
  enabled: true,
};

const EMPTY_CONFIRM_DIALOG: RepoReviewConfirmDialogState = {
  open: false,
  title: '',
  message: '',
  confirmLabel: i18n.t('repoReview.confirm.defaultConfirm'),
  tone: 'primary',
  pending: false,
  onConfirm: null,
};

function splitGlobs(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function joinGlobs(value: string[]): string {
  return value.join('\n');
}

function serializeActorMentionMappings(
  entries: Array<{
    actor: string;
    channel: 'feishu';
    id: string;
    name: string;
  }>,
): string {
  return entries
    .map((entry) =>
      entry.name
        ? `${entry.actor}=${entry.id}|${entry.name}`
        : `${entry.actor}=${entry.id}`,
    )
    .join('\n');
}

function makeActorMentionDraftRows(
  repository?: RepoReviewRepository | null,
): ActorMentionDraftRow[] {
  if (!repository?.actorMentionMappings?.length) return [];
  return repository.actorMentionMappings.map((entry, index) => ({
    key: `saved-${entry.actor}-${entry.id}-${index}`,
    actor: entry.actor,
    memberId: entry.id,
  }));
}

function parseActorMentionMappingsInput(value: string): {
  entries: Array<{
    actor: string;
    channel: 'feishu';
    id: string;
    name: string;
  }>;
  issues: ActorMentionParseIssue[];
} {
  const entries: Array<{
    actor: string;
    channel: 'feishu';
    id: string;
    name: string;
  }> = [];
  const issues: ActorMentionParseIssue[] = [];
  const seenActors = new Set<string>();
  const idToActor = new Map<string, string>();

  value.split('\n').forEach((rawLine, index) => {
    const entry = rawLine.trim();
    if (!entry) return;
    const line = index + 1;
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex < 0) {
      issues.push({
        level: 'error',
        line,
        message: i18n.t('repoReview.parseError.missingEquals'),
      });
      return;
    }
    const actorSource = entry.slice(0, separatorIndex).trim();
    const targetPart = entry.slice(separatorIndex + 1).trim();
    if (!actorSource) {
      issues.push({
        level: 'error',
        line,
        message: i18n.t('repoReview.parseError.emptyActor'),
      });
      return;
    }
    if (!targetPart) {
      issues.push({
        level: 'error',
        line,
        message: i18n.t('repoReview.parseError.missingOpenId'),
      });
      return;
    }
    const [idPart, ...nameParts] = targetPart.split('|');
    const actor = normalizeActorBindingValue(actorSource);
    const id = idPart.trim();
    const name = nameParts.join('|').trim() || actorSource;
    if (!id) {
      issues.push({
        level: 'error',
        line,
        message: i18n.t('repoReview.parseError.emptyOpenId'),
      });
      return;
    }
    if (seenActors.has(actor)) {
      issues.push({
        level: 'error',
        line,
        message: i18n.t('repoReview.parseError.duplicateActor', {
          actor: actorSource,
        }),
      });
      return;
    }
    const existingActor = idToActor.get(id);
    if (existingActor && existingActor !== actor) {
      issues.push({
        level: 'warning',
        line,
        message: i18n.t('repoReview.parseError.duplicateId', {
          id,
          existing: existingActor,
        }),
      });
    }
    seenActors.add(actor);
    idToActor.set(id, actor);
    entries.push({
      actor,
      channel: 'feishu',
      id,
      name,
    });
  });

  return { entries, issues };
}

function formatRemoteProviderLabel(
  provider: RepoReviewRepository['remoteProvider'],
): string {
  if (provider === 'github') return 'GitHub';
  if (provider === 'gitlab') return 'GitLab';
  if (provider === 'gitea') return 'Gitea';
  return i18n.t('repoReview.remoteProvider.local');
}

function getRemoteRepoSlugLabel(
  provider: RepoReviewRepository['remoteProvider'],
): string {
  if (provider === 'gitlab' || provider === 'gitea') {
    return i18n.t('repoReview.remoteRepoSlug.gitlab');
  }
  if (provider === 'github') {
    return i18n.t('repoReview.remoteRepoSlug.github');
  }
  return i18n.t('repoReview.remoteRepoSlug.default');
}

function getRemoteRepoSlugPlaceholder(
  provider: RepoReviewRepository['remoteProvider'],
): string {
  if (provider === 'gitlab' || provider === 'gitea') {
    return 'group/project';
  }
  if (provider === 'github') {
    return 'owner/repo';
  }
  return i18n.t('repoReview.remoteRepoSlugPlaceholder.default');
}

function getRemoteBaseUrlHint(
  provider: RepoReviewRepository['remoteProvider'],
): string {
  if (provider === 'gitlab') {
    return i18n.t('repoReview.remoteBaseUrlHint.gitlab');
  }
  if (provider === 'gitea') {
    return i18n.t('repoReview.remoteBaseUrlHint.gitea');
  }
  if (provider === 'github') {
    return i18n.t('repoReview.remoteBaseUrlHint.github');
  }
  return i18n.t('repoReview.remoteBaseUrlHint.default');
}

function getWebhookSecretHint(
  provider: RepoReviewRepository['remoteProvider'],
): string {
  if (provider === 'gitlab') {
    return i18n.t('repoReview.webhookSecretHint.gitlab');
  }
  if (provider === 'github') {
    return i18n.t('repoReview.webhookSecretHint.github');
  }
  if (provider === 'gitea') {
    return i18n.t('repoReview.webhookSecretHint.gitea');
  }
  return i18n.t('repoReview.webhookSecretHint.default');
}

function getWebhookSecretLabel(
  provider: RepoReviewRepository['remoteProvider'],
): string {
  if (provider === 'gitlab')
    return i18n.t('repoReview.webhookSecretLabel.gitlab');
  if (provider === 'github')
    return i18n.t('repoReview.webhookSecretLabel.github');
  if (provider === 'gitea')
    return i18n.t('repoReview.webhookSecretLabel.gitea');
  return i18n.t('repoReview.webhookSecretLabel.default');
}

function getPlatformTokenLabel(
  provider: RepoReviewRepository['remoteProvider'],
): string {
  if (provider === 'gitlab')
    return i18n.t('repoReview.platformTokenLabel.gitlab');
  if (provider === 'github')
    return i18n.t('repoReview.platformTokenLabel.github');
  if (provider === 'gitea')
    return i18n.t('repoReview.platformTokenLabel.gitea');
  return i18n.t('repoReview.platformTokenLabel.default');
}

function getPlatformTokenHint(
  provider: RepoReviewRepository['remoteProvider'],
): string {
  if (provider === 'gitlab') {
    return i18n.t('repoReview.platformTokenHint.gitlab');
  }
  if (provider === 'github') {
    return i18n.t('repoReview.platformTokenHint.github');
  }
  if (provider === 'gitea') {
    return i18n.t('repoReview.platformTokenHint.gitea');
  }
  return i18n.t('repoReview.platformTokenHint.optional');
}

function formatRemoteOptionLabel(
  option: RepoReviewRepositoryRemoteOption,
): string {
  const providerLabel = formatRemoteProviderLabel(option.provider);
  return option.remoteRepoSlug
    ? `${option.remoteName} · ${providerLabel} · ${option.remoteRepoSlug}`
    : `${option.remoteName} · ${providerLabel}`;
}

function formatReviewChatTarget(
  reviewChatJid: string,
  conversations: Conversation[],
): string {
  if (!reviewChatJid || reviewChatJid.startsWith('repo-review:')) {
    return i18n.t('repoReview.chatTarget.auto');
  }
  const matched = conversations.find(
    (conversation) => conversation.jid === reviewChatJid,
  );
  return matched ? formatConversationLabel(matched) : reviewChatJid;
}

function createActorMentionDraftRow(): ActorMentionDraftRow {
  return {
    key: `mapping-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    actor: '',
    memberId: '',
  };
}

function normalizeActorBindingValue(value: string): string {
  return value.trim().replace(/^@+/, '').toLowerCase();
}

function buildActorBindingVariants(value: string): string[] {
  const raw = value.trim();
  if (!raw) return [];
  const variants = new Set<string>();
  const normalized = normalizeActorBindingValue(raw);
  if (normalized) variants.add(normalized);

  const emailMatch = raw.match(
    /<?([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/,
  );
  if (emailMatch?.[0]) {
    variants.add(normalizeActorBindingValue(emailMatch[0]));
  }
  if (emailMatch?.[1]) {
    variants.add(normalizeActorBindingValue(emailMatch[1]));
  }

  return Array.from(variants).filter(Boolean);
}

function isMeaningfulActorCandidate(value: string): boolean {
  const normalized = normalizeActorBindingValue(value);
  if (!normalized) return false;
  if (
    normalized === 'manual-sync' ||
    normalized === '本地开发者' ||
    normalized === '(unknown)'
  ) {
    return false;
  }
  return normalized.length <= 120;
}

function buildActorMentionMappingsState(input: {
  rows: ActorMentionDraftRow[];
  members: RepoReviewChatMember[];
  manualText: string;
}) {
  const memberNameById = new Map(
    input.members.map((member) => [member.id, member.name] as const),
  );
  const entries: Array<{
    actor: string;
    channel: 'feishu';
    id: string;
    name: string;
  }> = [];
  const issues: ActorMentionParseIssue[] = [];
  const seenActors = new Set<string>();
  const idToActor = new Map<string, string>();
  let syntheticLine = 0;

  for (const row of input.rows) {
    if (!row.actor.trim() && !row.memberId.trim()) continue;
    syntheticLine += 1;
    const actor = normalizeActorBindingValue(row.actor);
    const id = row.memberId.trim();
    if (!actor) {
      issues.push({
        level: 'error',
        line: syntheticLine,
        message: i18n.t('repoReview.parseError.quickEmptyActor'),
      });
      continue;
    }
    if (!id) {
      issues.push({
        level: 'error',
        line: syntheticLine,
        message: i18n.t('repoReview.parseError.quickMissingMember', { actor }),
      });
      continue;
    }
    if (seenActors.has(actor)) {
      issues.push({
        level: 'error',
        line: syntheticLine,
        message: i18n.t('repoReview.parseError.duplicateActor', { actor }),
      });
      continue;
    }
    const existingActor = idToActor.get(id);
    if (existingActor && existingActor !== actor) {
      issues.push({
        level: 'warning',
        line: syntheticLine,
        message: i18n.t('repoReview.parseError.quickDuplicateMember', {
          name: memberNameById.get(id) || id,
          existing: existingActor,
        }),
      });
    }
    seenActors.add(actor);
    idToActor.set(id, actor);
    entries.push({
      actor,
      channel: 'feishu',
      id,
      name: memberNameById.get(id) || actor,
    });
  }

  const manual = parseActorMentionMappingsInput(input.manualText);
  for (const issue of manual.issues) {
    issues.push({
      ...issue,
      line: syntheticLine + issue.line,
    });
  }
  for (const entry of manual.entries) {
    if (seenActors.has(entry.actor)) {
      issues.push({
        level: 'error',
        line: syntheticLine + 1,
        message: i18n.t('repoReview.parseError.quickDuplicateInManual', {
          actor: entry.actor,
        }),
      });
      continue;
    }
    const existingActor = idToActor.get(entry.id);
    if (existingActor && existingActor !== entry.actor) {
      issues.push({
        level: 'warning',
        line: syntheticLine + 1,
        message: i18n.t('repoReview.parseError.duplicateId', {
          id: entry.id,
          existing: existingActor,
        }),
      });
    }
    seenActors.add(entry.actor);
    idToActor.set(entry.id, entry.actor);
    entries.push(entry);
  }

  return { entries, issues };
}

function makeRepositoryDraft(
  repository?: RepoReviewRepository | null,
): RepositoryDraft {
  if (!repository) return { ...EMPTY_REPOSITORY_DRAFT };
  return {
    id: repository.id,
    name: repository.name,
    language: repository.language || 'TypeScript',
    localRepoPath: repository.localRepoPath,
    remoteProvider: repository.remoteProvider,
    remoteRepoSlug: repository.remoteRepoSlug,
    remoteBaseUrl: repository.remoteBaseUrl,
    cloneUrl: repository.cloneUrl,
    defaultTargetBranch: repository.defaultTargetBranch || 'main',
    reviewChatJid: repository.reviewChatJid,
    webhookSecret: '',
    platformToken: '',
    actorMentionDraftRows: makeActorMentionDraftRows(repository),
    actorMentionMappingsText: '',
    autoSyncEnabled: repository.autoSyncEnabled,
    autoSyncIntervalMinutes: repository.autoSyncIntervalMinutes || 30,
    digestDailyEnabled: repository.digestDailyEnabled,
    digestWeeklyEnabled: repository.digestWeeklyEnabled,
    digestDailyHour: repository.digestDailyHour ?? 18,
    digestWeeklyDay: repository.digestWeeklyDay ?? 5,
    digestWeeklyHour: repository.digestWeeklyHour ?? 18,
    enabled: repository.enabled,
    allowAiFix: repository.allowAiFix ?? false,
    sshKeyId: repository.sshKeyId || '',
  };
}

function formatRepoAutoSyncStatus(status: string): string {
  if (status === 'running') return i18n.t('repoReview.status.running');
  if (status === 'success') return i18n.t('repoReview.status.success');
  if (status === 'partial') return i18n.t('repoReview.status.partial');
  if (status === 'error') return i18n.t('repoReview.status.failed');
  if (status === 'idle') return i18n.t('repoReview.status.idle');
  return i18n.t('repoReview.status.notExecuted');
}

function formatOptionalDateTime(value: string): string {
  if (!value) return i18n.t('repoReview.status.notExecuted');
  return new Date(value).toLocaleString();
}

function parseOptionalTimestamp(value: string): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

function isTimestampWithinDays(
  value: string,
  days: number,
  nowMs = Date.now(),
): boolean {
  const timestamp = parseOptionalTimestamp(value);
  if (Number.isNaN(timestamp)) return false;
  return timestamp >= nowMs - days * 24 * 60 * 60 * 1000;
}

function getLatestTimestamp(values: string[]): number {
  let latest = Number.NaN;
  for (const value of values) {
    const timestamp = parseOptionalTimestamp(value);
    if (Number.isNaN(timestamp)) continue;
    if (Number.isNaN(latest) || timestamp > latest) {
      latest = timestamp;
    }
  }
  return latest;
}

function makeProfileDraft(
  repositoryId: string,
  profile?: RepoReviewProfile | null,
): ProfileDraft {
  if (!profile) {
    return { ...EMPTY_PROFILE_DRAFT, repositoryId };
  }
  return {
    id: profile.id,
    repositoryId: profile.repositoryId,
    name: profile.name,
    stage: profile.stage,
    sourceMode: profile.sourceMode,
    blockingMode: profile.blockingMode,
    passDecisionMode: profile.passDecisionMode,
    reviewScope: profile.reviewScope,
    targetBranches: profile.targetBranches,
    skillIds: profile.skillIds,
    promptTemplate: profile.promptTemplate,
    includeGlobsText: joinGlobs(profile.includeGlobs),
    excludeGlobsText: joinGlobs(profile.excludeGlobs),
    includeFullFileContext: profile.includeFullFileContext,
    maxFiles: profile.maxFiles,
    maxDiffBytes: profile.maxDiffBytes,
    writeToChat: profile.writeToChat,
    writeToPlatform: profile.writeToPlatform,
    reviewOutputMode:
      profile.reviewOutputMode === 'message' ? 'message' : 'share_link',
    diffSubagentThreshold: profile.diffSubagentThreshold ?? 15,
    subagentTimeoutSeconds: profile.subagentTimeoutSeconds ?? 420,
    enabled: profile.enabled,
  };
}

function resolveProfileDraft(
  repositoryId: string,
  profiles: RepoReviewProfile[],
  preferredProfileId?: string,
): ProfileDraft {
  if (!repositoryId) {
    return { ...EMPTY_PROFILE_DRAFT };
  }
  const preferredProfile = preferredProfileId
    ? profiles.find((profile) => profile.id === preferredProfileId) || null
    : null;
  return makeProfileDraft(
    repositoryId,
    preferredProfile || profiles[0] || null,
  );
}

function formatConversationLabel(conversation: Conversation): string {
  const title =
    conversation.display_name ||
    conversation.custom_title ||
    conversation.name ||
    conversation.jid;
  const channel = conversation.channel
    ? conversation.channel.toUpperCase()
    : 'LOCAL';
  const chatKind =
    conversation.is_group === 1
      ? i18n.t('repoReview.chatKind.group')
      : conversation.channel === 'web'
        ? i18n.t('repoReview.chatKind.web')
        : i18n.t('repoReview.chatKind.private');
  return `${title} · ${channel} · ${chatKind}`;
}

function formatRunOutcomeLabel(value: string): string {
  if (value === 'pass') return i18n.t('repoReview.status.pass');
  if (value === 'warn') return i18n.t('repoReview.status.warn');
  if (value === 'fail') return i18n.t('repoReview.status.fail');
  if (value === 'error') return i18n.t('repoReview.status.error');
  if (value === 'skipped') return i18n.t('repoReview.status.skipped');
  return value;
}

function formatRunTitle(run: RepoReviewRun): string {
  return formatRunOutcomeLabel(run.overall || run.status);
}

function formatRunStageLabel(stage: RepoReviewRun['stage']): string {
  return stage === 'commit'
    ? i18n.t('repoReview.stage.commit')
    : i18n.t('repoReview.stage.push');
}

function formatRunSourceLabel(source: string): string {
  if (source === 'local-hook') return i18n.t('repoReview.source.localHook');
  if (source === 'github') return 'GitHub';
  if (source === 'gitlab') return 'GitLab';
  if (source === 'gitea') return 'Gitea';
  return source || i18n.t('repoReview.source.unknown');
}

function maskSensitivePreview(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 4) return `${trimmed.slice(0, 1)}***`;
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}***${trimmed.slice(-1)}`;
  }
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

function formatShortSha(value: string): string {
  return value ? value.slice(0, 8) : '-';
}

function buildRepoReviewCompactSummary(text: string, fallback: string): string {
  const normalized = (text || fallback).trim();
  return normalized || fallback;
}

function getRunDurationMs(run: RepoReviewRun): number {
  if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs)) {
    return Math.max(0, run.durationMs);
  }
  const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : 0;
  const completedAt = run.completedAt ? new Date(run.completedAt).getTime() : 0;
  if (startedAt > 0 && completedAt >= startedAt) {
    return completedAt - startedAt;
  }
  return 0;
}

function getRepoReviewRunActivityMs(run: RepoReviewRun): number {
  return Date.parse(run.updatedAt || run.createdAt || '') || 0;
}

function formatDurationMs(value: number): string {
  if (!value || value <= 0) return i18n.t('repoReview.timeline.inProgress');
  if (value < 1000) return `${value}ms`;
  if (value < 60_000)
    return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatBaselineSourceLabel(value?: string): string {
  if (!value) return i18n.t('repoReview.baseline.notReturned');
  if (value === 'previous_run')
    return i18n.t('repoReview.baseline.previousRun');
  if (value === 'default_branch')
    return i18n.t('repoReview.baseline.defaultBranch');
  if (value === 'merge_base') return 'merge-base';
  if (value === 'explicit_base_sha')
    return i18n.t('repoReview.baseline.explicitBaseSha');
  if (value === 'pr_compare') return i18n.t('repoReview.baseline.prCompare');
  return value;
}

function formatResultStateLabel(run: RepoReviewRun): string {
  const value = run.resultState?.trim();
  if (!value) {
    if (run.status === 'running' || run.status === 'queued') {
      return i18n.t('repoReview.status.running');
    }
    return formatRunOutcomeLabel(run.overall || run.status);
  }
  if (value === 'needs_human') return i18n.t('repoReview.status.needsHuman');
  if (value === 'delivered') return i18n.t('repoReview.status.delivered');
  if (value === 'delivery_failed')
    return i18n.t('repoReview.status.deliveryFailed');
  if (value === 'blocked') return i18n.t('repoReview.status.blocked');
  return value;
}

function getDeliveryTone(status: string): 'success' | 'warning' | 'neutral' {
  if (
    status === 'delivered' ||
    status === 'posted' ||
    status === 'success' ||
    status === 'sent'
  ) {
    return 'success';
  }
  if (
    status === 'failed' ||
    status === 'error' ||
    status === 'blocked' ||
    status === 'timeout'
  ) {
    return 'warning';
  }
  return 'neutral';
}

function formatDeliveryStatusLabel(status: string): string {
  if (!status) return i18n.t('repoReview.delivery.notReturned');
  if (
    status === 'delivered' ||
    status === 'posted' ||
    status === 'success' ||
    status === 'sent'
  ) {
    return i18n.t('repoReview.delivery.delivered');
  }
  if (status === 'pending' || status === 'queued' || status === 'running') {
    return i18n.t('repoReview.delivery.delivering');
  }
  if (status === 'skipped') return i18n.t('repoReview.delivery.skipped');
  if (status === 'disabled') return i18n.t('repoReview.delivery.disabled');
  if (status === 'failed' || status === 'error' || status === 'timeout') {
    return i18n.t('repoReview.delivery.failed');
  }
  return status;
}

function resolveChatDeliveryStatus(run: RepoReviewRun): string {
  if (run.chatDeliveryStatus) return run.chatDeliveryStatus;
  if (run.status === 'queued' || run.status === 'running') return 'pending';
  return '';
}

function resolvePlatformDeliveryStatus(run: RepoReviewRun): string {
  if (run.platformStatusDeliveryStatus) return run.platformStatusDeliveryStatus;
  if (run.platformCommentDeliveryStatus)
    return run.platformCommentDeliveryStatus;
  if (run.platformStatus || run.platformCommentUrl) return 'delivered';
  if (run.status === 'queued' || run.status === 'running') return 'pending';
  return '';
}

function formatDigestRunTypeLabel(type: RepoReviewDigestRun['type']): string {
  return type === 'weekly'
    ? i18n.t('repoReview.digest.weekly')
    : i18n.t('repoReview.digest.daily');
}

function formatDigestRunStatusLabel(status: string): string {
  if (status === 'completed') return i18n.t('repoReview.status.completed');
  if (status === 'failed' || status === 'error')
    return i18n.t('repoReview.status.error');
  if (status === 'running') return i18n.t('repoReview.status.running');
  if (status === 'queued') return i18n.t('repoReview.status.queued');
  return status || i18n.t('repoReview.status.unknown');
}

function formatDigestDeliveryStatusLabel(status: string): string {
  if (status === 'delivered') return i18n.t('repoReview.delivery.delivered');
  if (status === 'failed' || status === 'error')
    return i18n.t('repoReview.delivery.failed');
  if (status === 'not_configured')
    return i18n.t('repoReview.status.notConfigured');
  if (status === 'pending') return i18n.t('repoReview.status.pending');
  return status || i18n.t('repoReview.status.unknown');
}

export function RepoReviewSettingsPanel({
  apiBase,
  pickNativeDirectory,
  conversations,
  initialRepositoryId,
  initialDetailTab = 'overview',
  onRepositoryRouteChange,
  hideRepositoryList = false,
  embedded = false,
}: RepoReviewSettingsPanelProps) {
  const { t } = useTranslation('repoReview');
  const [loading, setLoading] = useState(false);
  const isInitialLoadRef = useRef(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [cancellingRunIds, setCancellingRunIds] = useState<string[]>([]);
  const [repositories, setRepositories] = useState<RepoReviewRepository[]>([]);
  const [sshKeys, setSshKeys] = useState<SshKeyInfo[]>([]);
  const [profiles, setProfiles] = useState<RepoReviewProfile[]>([]);
  const [runs, setRuns] = useState<RepoReviewRun[]>([]);
  const [digestRuns, setDigestRuns] = useState<RepoReviewDigestRun[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState('');
  const previousInitialRepositoryIdRef = useRef(initialRepositoryId || '');
  const [creatingRepository, setCreatingRepository] = useState(false);
  const [repositoryFilter, setRepositoryFilter] = useState('');
  const [runFilterStatus, setRunFilterStatus] = useState('');
  const [runFilterText, setRunFilterText] = useState('');
  const [runsPage, setRunsPage] = useState(1);
  const [repoDetailTab, setRepoDetailTab] =
    useState<RepoReviewPanelTab>(initialDetailTab);
  const [inlineCodeMapBranch, setInlineCodeMapBranch] = useState<string | null>(
    null,
  );
  const [repoCardPage, setRepoCardPage] = useState(1);
  const [syncingBranchNames, setSyncingBranchNames] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<
    RepoReviewBranchSummary[]
  >([]);
  const [loadingRemoteBranches, setLoadingRemoteBranches] = useState(false);
  const [lastSyncMessage, setLastSyncMessage] = useState('');
  const [discoveringRepository, setDiscoveringRepository] = useState(false);
  const [repositoryDetectionWarnings, setRepositoryDetectionWarnings] =
    useState<string[]>([]);
  const [lastRepositoryDetection, setLastRepositoryDetection] =
    useState<RepoReviewRepositoryDetection | null>(null);
  const [discoveredContributors, setDiscoveredContributors] = useState<
    { name: string; email: string }[]
  >([]);
  const [contributorsLoading, setContributorsLoading] = useState(false);
  const [selectedDetectedRemoteName, setSelectedDetectedRemoteName] =
    useState('');
  const [autoCreatedProfileNotice, setAutoCreatedProfileNotice] = useState('');
  const [reviewChatMembers, setReviewChatMembers] = useState<
    RepoReviewChatMember[]
  >([]);
  const [loadingReviewChatMembers, setLoadingReviewChatMembers] =
    useState(false);
  const [reviewChatMembersError, setReviewChatMembersError] = useState('');
  const [customReviewChatJidInput, setCustomReviewChatJidInput] = useState('');
  const [manualDecisionRunId, setManualDecisionRunId] = useState('');
  const [rerunningRunIds, setRerunningRunIds] = useState<string[]>([]);
  const [expandedRunProgressIds, setExpandedRunProgressIds] = useState<
    string[]
  >([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedRunDetail, setSelectedRunDetail] =
    useState<RepoReviewRun | null>(null);
  const [loadingRunDetail, setLoadingRunDetail] = useState(false);
  const [digestRunsSectionOpen, setDigestRunsSectionOpen] = useState(false);
  const [selectedDigestRunId, setSelectedDigestRunId] = useState('');
  const [selectedDigestRunDetail, setSelectedDigestRunDetail] =
    useState<RepoReviewDigestRun | null>(null);
  const [loadingDigestRuns, setLoadingDigestRuns] = useState(false);
  const [loadingDigestRunDetail, setLoadingDigestRunDetail] = useState(false);
  const [branchStatusPanelOpen, setBranchStatusPanelOpen] = useState(false);
  const [branchStatusPanelInitialBranch, setBranchStatusPanelInitialBranch] =
    useState('');
  const [selectedMentionMemberId, setSelectedMentionMemberId] = useState('');
  const [advancedMappingsOpen, setAdvancedMappingsOpen] = useState(false);
  const [repositoryDraft, setRepositoryDraft] = useState<RepositoryDraft>(
    EMPTY_REPOSITORY_DRAFT,
  );
  const [profileDraft, setProfileDraft] =
    useState<ProfileDraft>(EMPTY_PROFILE_DRAFT);
  const [repositorySectionOpen, setRepositorySectionOpen] = useState(false);
  const [profileSectionOpen, setProfileSectionOpen] = useState(false);
  const [runsSectionOpen, setRunsSectionOpen] = useState(false);
  const [repositoryEditorOpen, setRepositoryEditorOpen] = useState(false);
  const [repositoryEditorSection, setRepositoryEditorSection] =
    useState<RepositoryEditorSection>('all');
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] =
    useState<RepoReviewConfirmDialogState>(EMPTY_CONFIRM_DIALOG);
  const [savingRepository, setSavingRepository] = useState(false);
  const [deletingRepository, setDeletingRepository] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [deletingProfile, setDeletingProfile] = useState(false);
  const pauseOverviewRefresh = repositoryEditorOpen || profileEditorOpen;

  // Refs for async safety: prevent race conditions and stale updates.
  const mountedRef = useRef(true);
  const overviewRequestIdRef = useRef(0);
  const runsRequestIdRef = useRef(0);
  const runSnapshotRequestIdRef = useRef(0);
  const runsRefreshInFlightRef = useRef(false);
  const runDetailRefreshInFlightRef = useRef(false);
  const remoteBranchRequestIdRef = useRef(0);
  const digestRunsRequestIdRef = useRef(0);
  const reviewRealtimeLastSeqByJidRef = useRef<Record<string, number>>({});
  const reviewRealtimePendingRef = useRef<
    Array<
      Extract<
        NonNullable<ReturnType<typeof normalizeConversationRealtimeEvent>>,
        { kind: 'turn_event' | 'stream' }
      >
    >
  >([]);
  const reviewRealtimeRefreshTimerRef = useRef<number | null>(null);
  const runFilterKeyRef = useRef('');
  const repositoryEditorSectionRefs = useRef<
    Record<Exclude<RepositoryEditorSection, 'all'>, HTMLDivElement | null>
  >({
    source: null,
    delivery: null,
    autosync: null,
    credentials: null,
  });
  const { getCachedBranches, setCachedBranches, invalidateBranchCache } =
    useRepoReviewBranchCache();

  const overview = useMemo<RepoReviewOverview>(
    () => ({
      repositories,
      profiles,
      runs,
    }),
    [profiles, repositories, runs],
  );

  const selectedRepository = useMemo(
    () =>
      overview.repositories.find(
        (entry) => entry.id === selectedRepositoryId,
      ) || null,
    [overview.repositories, selectedRepositoryId],
  );

  const repositoryById = useMemo(
    () =>
      new Map(overview.repositories.map((entry) => [entry.id, entry] as const)),
    [overview.repositories],
  );

  const profileById = useMemo(
    () => new Map(overview.profiles.map((entry) => [entry.id, entry] as const)),
    [overview.profiles],
  );

  const actorMentionMappingsState = useMemo(
    () =>
      buildActorMentionMappingsState({
        rows: repositoryDraft.actorMentionDraftRows,
        members: reviewChatMembers,
        manualText: repositoryDraft.actorMentionMappingsText,
      }),
    [
      repositoryDraft.actorMentionDraftRows,
      repositoryDraft.actorMentionMappingsText,
      reviewChatMembers,
    ],
  );

  const filteredRepositories = useMemo(() => {
    const keyword = repositoryFilter.trim().toLowerCase();
    if (!keyword) return overview.repositories;
    return overview.repositories.filter((entry) =>
      [
        entry.name,
        entry.id,
        entry.language,
        entry.localRepoPath,
        entry.remoteRepoSlug,
      ]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(keyword)),
    );
  }, [overview.repositories, repositoryFilter]);

  const showWorkspaceDetail = !!selectedRepositoryId || creatingRepository;
  const repositoryCatalogVisible =
    !hideRepositoryList && !(embedded && showWorkspaceDetail);
  const repositoryWorkspaceFocused =
    hideRepositoryList || (embedded && showWorkspaceDetail);

  const profilesForSelectedRepository = useMemo(
    () =>
      overview.profiles.filter(
        (entry) => entry.repositoryId === selectedRepositoryId,
      ),
    [overview.profiles, selectedRepositoryId],
  );
  const pushProfilesForSelectedRepository = useMemo(
    () =>
      profilesForSelectedRepository.filter(
        (profile) => profile.stage === 'push' && profile.enabled,
      ),
    [profilesForSelectedRepository],
  );

  const conversationOptions = useMemo(
    () => [
      {
        value: AUTO_REVIEW_CHAT_VALUE,
        label: i18n.t('repoReview.chatOption.auto'),
      },
      {
        value: CUSTOM_REVIEW_CHAT_VALUE,
        label: i18n.t('repoReview.chatOption.custom'),
      },
      ...conversations
        .filter((conversation) => !conversation.jid.startsWith('repo-review:'))
        .sort((left, right) => {
          const leftScore =
            (left.channel === 'feishu' ? 4 : 0) +
            (left.is_group === 1 ? 2 : 0) +
            (left.custom_title ? 1 : 0);
          const rightScore =
            (right.channel === 'feishu' ? 4 : 0) +
            (right.is_group === 1 ? 2 : 0) +
            (right.custom_title ? 1 : 0);
          if (leftScore !== rightScore) return rightScore - leftScore;
          return formatConversationLabel(left).localeCompare(
            formatConversationLabel(right),
            'zh-Hans-CN',
          );
        })
        .map((conversation) => ({
          value: conversation.jid,
          label: formatConversationLabel(conversation),
        })),
    ],
    [conversations],
  );

  const conversationOptionValues = useMemo(
    () => new Set(conversationOptions.map((option) => option.value)),
    [conversationOptions],
  );

  useEffect(() => {
    const currentValue = repositoryDraft.reviewChatJid.trim();
    if (
      !currentValue ||
      currentValue.startsWith('repo-review:') ||
      conversationOptionValues.has(currentValue)
    ) {
      setCustomReviewChatJidInput('');
      return;
    }
    setCustomReviewChatJidInput(currentValue);
  }, [conversationOptionValues, repositoryDraft.reviewChatJid]);

  const reviewChatValue =
    !repositoryDraft.reviewChatJid ||
    repositoryDraft.reviewChatJid.startsWith('repo-review:')
      ? AUTO_REVIEW_CHAT_VALUE
      : conversationOptionValues.has(repositoryDraft.reviewChatJid)
        ? repositoryDraft.reviewChatJid
        : CUSTOM_REVIEW_CHAT_VALUE;

  const selectedReviewChatJid =
    reviewChatValue === AUTO_REVIEW_CHAT_VALUE ||
    reviewChatValue === CUSTOM_REVIEW_CHAT_VALUE
      ? ''
      : reviewChatValue;
  const effectiveReviewChatJid =
    reviewChatValue === CUSTOM_REVIEW_CHAT_VALUE
      ? customReviewChatJidInput.trim()
      : selectedReviewChatJid;
  const isFeishuReviewChat =
    effectiveReviewChatJid.startsWith('feishu:') ||
    effectiveReviewChatJid.startsWith('oc_');

  const canLoadRemoteBranches =
    !creatingRepository &&
    !!selectedRepositoryId &&
    !!selectedRepository?.remoteProvider;
  const shouldLoadRemoteBranches =
    canLoadRemoteBranches &&
    (repoDetailTab === 'profile' ||
      repoDetailTab === 'config' ||
      branchStatusPanelOpen);

  const repositoryHasMappingErrors = actorMentionMappingsState.issues.some(
    (issue) => issue.level === 'error',
  );

  const availableReviewChatMembers = useMemo(() => {
    const deduped = new Map<string, RepoReviewChatMember>();
    for (const member of reviewChatMembers) {
      if (!member.id) continue;
      deduped.set(member.id, member);
    }
    for (const entry of actorMentionMappingsState.entries) {
      if (!entry.id || deduped.has(entry.id)) continue;
      deduped.set(entry.id, {
        id: entry.id,
        name: entry.name || entry.id,
        chatJid: effectiveReviewChatJid,
        source: 'saved_mapping',
      });
    }
    return Array.from(deduped.values()).sort((left, right) =>
      left.name.localeCompare(right.name, 'zh-Hans-CN'),
    );
  }, [
    actorMentionMappingsState.entries,
    effectiveReviewChatJid,
    reviewChatMembers,
  ]);

  const reviewChatMemberOptions = useMemo<AppSelectOption[]>(
    () =>
      availableReviewChatMembers.map((member) => ({
        value: member.id,
        label:
          member.source === 'saved_mapping'
            ? i18n.t('repoReview.chatTarget.savedMapping', {
                name: member.name,
              })
            : member.name,
      })),
    [availableReviewChatMembers],
  );

  const selectedMentionMember = useMemo(
    () =>
      availableReviewChatMembers.find(
        (member) => member.id === selectedMentionMemberId,
      ) || null,
    [availableReviewChatMembers, selectedMentionMemberId],
  );

  const reviewChatMemberSourceStats = useMemo(() => {
    const stats = {
      api: 0,
      message: 0,
      saved: 0,
    };
    for (const member of availableReviewChatMembers) {
      if (member.source === 'feishu_api') stats.api += 1;
      else if (member.source === 'feishu_message') stats.message += 1;
      else if (member.source === 'saved_mapping') stats.saved += 1;
    }
    return stats;
  }, [availableReviewChatMembers]);

  const availableProfileBranches = useMemo(() => {
    const seen = new Set<string>();
    const next: RepoReviewBranchSummary[] = [];
    const pushBranch = (branch: RepoReviewBranchSummary) => {
      const normalized = branch.name.trim();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      next.push(branch);
    };
    for (const branch of remoteBranches) {
      pushBranch(branch);
    }
    if (selectedRepository?.defaultTargetBranch) {
      pushBranch({
        name: selectedRepository.defaultTargetBranch,
        headSha: '',
        parentSha: '',
        actor: '',
        title: '',
        latestCommitAt: '',
        defaultBranch: true,
      });
    }
    for (const branch of profileDraft.targetBranches) {
      pushBranch({
        name: branch,
        headSha: '',
        parentSha: '',
        actor: '',
        title: '',
        latestCommitAt: '',
        defaultBranch: branch === selectedRepository?.defaultTargetBranch,
      });
    }
    return next;
  }, [
    profileDraft.targetBranches,
    remoteBranches,
    selectedRepository?.defaultTargetBranch,
  ]);

  const filteredProfileBranches = availableProfileBranches;

  const runsForDisplay = useMemo(() => {
    const keyword = runFilterText.trim().toLowerCase();
    const filtered = overview.runs.filter((run) => {
      if (selectedRepositoryId && run.repositoryId !== selectedRepositoryId) {
        return false;
      }
      if (runFilterStatus && (run.overall || run.status) !== runFilterStatus) {
        return false;
      }
      if (!keyword) return true;
      const repositoryName = repositoryById.get(run.repositoryId)?.name || '';
      const profileName = profileById.get(run.profileId)?.name || '';
      return [
        repositoryName,
        profileName,
        run.summary,
        run.actor,
        run.branch,
        run.headSha,
        run.changedFiles.join(' '),
      ]
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
    return sortRepoReviewRunsByLatestActivity(filtered);
  }, [
    overview.runs,
    profileById,
    repositoryById,
    runFilterStatus,
    runFilterText,
    selectedRepositoryId,
  ]);
  const RUNS_PAGE_SIZE = 12;
  const REPO_CARD_PAGE_SIZE = 12;
  const totalRunsPages = Math.max(
    1,
    Math.ceil(runsForDisplay.length / RUNS_PAGE_SIZE),
  );
  const pagedRunsForDisplay = useMemo(() => {
    const safePage = Math.min(Math.max(runsPage, 1), totalRunsPages);
    const start = (safePage - 1) * RUNS_PAGE_SIZE;
    return runsForDisplay.slice(start, start + RUNS_PAGE_SIZE);
  }, [runsForDisplay, runsPage, totalRunsPages]);

  const selectedRepositoryRuns = useMemo(
    () =>
      sortRepoReviewRunsByLatestActivity(
        overview.runs.filter(
          (run) => run.repositoryId === selectedRepositoryId,
        ),
      ),
    [overview.runs, selectedRepositoryId],
  );

  const selectedRepositoryRunsByBranch = useMemo(() => {
    const grouped: Record<string, RepoReviewRun[]> = {};
    for (const run of selectedRepositoryRuns) {
      if (!run.branch) continue;
      if (!grouped[run.branch]) {
        grouped[run.branch] = [];
      }
      grouped[run.branch]!.push(run);
    }
    return grouped;
  }, [selectedRepositoryRuns]);

  const reviewIdentityCandidates = useMemo<ReviewIdentityCandidate[]>(() => {
    const mappedMemberNameByActor = new Map(
      actorMentionMappingsState.entries.map((entry) => [
        entry.actor,
        entry.name || entry.id,
      ]),
    );
    const candidates = new Map<
      string,
      {
        actor: string;
        sources: Set<string>;
        mappedMemberName: string;
      }
    >();

    const pushCandidate = (rawValue: string, source: string) => {
      if (!rawValue.trim()) return;
      for (const actor of buildActorBindingVariants(rawValue)) {
        if (!isMeaningfulActorCandidate(actor)) continue;
        const existing = candidates.get(actor);
        if (existing) {
          existing.sources.add(source);
          if (!existing.mappedMemberName) {
            existing.mappedMemberName =
              mappedMemberNameByActor.get(actor) || '';
          }
          continue;
        }
        candidates.set(actor, {
          actor,
          sources: new Set([source]),
          mappedMemberName: mappedMemberNameByActor.get(actor) || '',
        });
      }
    };

    for (const run of selectedRepositoryRuns.slice(0, 30)) {
      pushCandidate(run.actor, i18n.t('repoReview.contributor.pushUser'));
      for (const detail of run.commitDetails.slice(0, 20)) {
        pushCandidate(
          detail.author,
          i18n.t('repoReview.contributor.commitAuthor'),
        );
      }
    }

    for (const contributor of discoveredContributors) {
      pushCandidate(
        contributor.name,
        i18n.t('repoReview.contributor.gitCommitter'),
      );
      if (contributor.email) {
        pushCandidate(
          contributor.email,
          i18n.t('repoReview.contributor.gitCommitter'),
        );
      }
    }

    return Array.from(candidates.values())
      .sort((left, right) => {
        const leftMapped = left.mappedMemberName ? 1 : 0;
        const rightMapped = right.mappedMemberName ? 1 : 0;
        if (leftMapped !== rightMapped) return leftMapped - rightMapped;
        if (right.sources.size !== left.sources.size) {
          return right.sources.size - left.sources.size;
        }
        return left.actor.localeCompare(right.actor, 'en');
      })
      .map((entry) => ({
        actor: entry.actor,
        sources: Array.from(entry.sources.values()),
        mappedMemberName: entry.mappedMemberName,
      }));
  }, [
    actorMentionMappingsState.entries,
    selectedRepositoryRuns,
    discoveredContributors,
  ]);

  const selectedRepositoryLatestRun = selectedRepositoryRuns[0] || null;
  const currentWebhookSecretPreview = useMemo(() => {
    if (repositoryDraft.webhookSecret.trim()) {
      return maskSensitivePreview(repositoryDraft.webhookSecret);
    }
    return selectedRepository?.webhookSecretPreview || '';
  }, [repositoryDraft.webhookSecret, selectedRepository?.webhookSecretPreview]);
  const currentPlatformTokenPreview = useMemo(() => {
    if (repositoryDraft.platformToken.trim()) {
      return maskSensitivePreview(repositoryDraft.platformToken);
    }
    return selectedRepository?.platformTokenPreview || '';
  }, [repositoryDraft.platformToken, selectedRepository?.platformTokenPreview]);
  const selectedRunFromOverview = useMemo(
    () =>
      selectedRunId
        ? overview.runs.find((entry) => entry.id === selectedRunId) || null
        : null,
    [overview.runs, selectedRunId],
  );
  const selectedRunData = useMemo(() => {
    return mergeRepoReviewRunSnapshot(
      selectedRunFromOverview,
      selectedRunDetail,
    );
  }, [selectedRunDetail, selectedRunFromOverview]);
  const selectedRunProgressEntries = useMemo(
    () => (selectedRunData ? buildReviewProgressEntries(selectedRunData) : []),
    [selectedRunData],
  );
  const activeReviewRealtimeJids = useMemo(() => {
    const targets = new Set<string>();
    for (const run of overview.runs) {
      if (run.status !== 'queued' && run.status !== 'running') continue;
      targets.add(
        getRepoReviewRunChatJid(run, repositoryById.get(run.repositoryId)),
      );
    }
    if (
      selectedRunData &&
      (selectedRunData.status === 'queued' ||
        selectedRunData.status === 'running')
    ) {
      targets.add(
        getRepoReviewRunChatJid(
          selectedRunData,
          repositoryById.get(selectedRunData.repositoryId),
        ),
      );
    }
    return targets;
  }, [overview.runs, repositoryById, selectedRunData]);
  const hasActiveRuns = useMemo(
    () =>
      overview.runs.some(
        (run) => run.status === 'queued' || run.status === 'running',
      ),
    [overview.runs],
  );
  const latestRunWithProgress = useMemo(
    () =>
      runsForDisplay.find(
        (run) => run.status === 'running' || hasRepoReviewVisibleProgress(run),
      ) || null,
    [runsForDisplay],
  );

  const selectedRepositoryAllBranchStates = useMemo<
    Array<RepoReviewBranchStateItem & { visible: boolean }>
  >(() => {
    if (!selectedRepository) return [];
    const pushProfiles = pushProfilesForSelectedRepository;
    const nowMs = Date.now();
    const branchNames = new Set<string>();
    for (const branch of remoteBranches) {
      if (branch.name) branchNames.add(branch.name);
    }
    for (const run of selectedRepositoryRuns) {
      if (run.branch) branchNames.add(run.branch);
    }
    if (selectedRepository.defaultTargetBranch) {
      branchNames.add(selectedRepository.defaultTargetBranch);
    }
    return Array.from(branchNames)
      .sort((left, right) => {
        if (left === selectedRepository.defaultTargetBranch) return -1;
        if (right === selectedRepository.defaultTargetBranch) return 1;
        return left.localeCompare(right, 'en');
      })
      .map((branchName) => {
        const remoteBranch =
          remoteBranches.find((entry) => entry.name === branchName) || null;
        const lastRun =
          selectedRepositoryRuns.find((entry) => entry.branch === branchName) ||
          null;
        const hasExplicitTargetProfile = pushProfiles.some((profile) =>
          profile.targetBranches.includes(branchName),
        );
        const hasRecentRemoteActivity = isTimestampWithinDays(
          remoteBranch?.latestCommitAt || '',
          REPO_REVIEW_ACTIVE_BRANCH_WINDOW_DAYS,
          nowMs,
        );
        const hasRecentRunActivity =
          isTimestampWithinDays(
            lastRun?.createdAt || '',
            REPO_REVIEW_ACTIVE_BRANCH_WINDOW_DAYS,
            nowMs,
          ) ||
          isTimestampWithinDays(
            lastRun?.completedAt || '',
            REPO_REVIEW_ACTIVE_BRANCH_WINDOW_DAYS,
            nowMs,
          );
        const hasActiveRun =
          lastRun?.status === 'queued' || lastRun?.status === 'running';
        const targetProfiles = pushProfiles.filter(
          (profile) =>
            profile.targetBranches.length === 0 ||
            profile.targetBranches.includes(branchName),
        );
        return {
          name: branchName,
          defaultBranch:
            remoteBranch?.defaultBranch ||
            branchName === selectedRepository.defaultTargetBranch,
          headSha: remoteBranch?.headSha || lastRun?.headSha || '',
          actor: remoteBranch?.actor || lastRun?.actor || '',
          title: remoteBranch?.title || lastRun?.summary || '',
          latestCommitAt: remoteBranch?.latestCommitAt || '',
          isReviewing: hasActiveRun,
          lastRun,
          targetProfiles,
          visible:
            remoteBranch?.defaultBranch ||
            branchName === selectedRepository.defaultTargetBranch ||
            hasExplicitTargetProfile ||
            hasRecentRemoteActivity ||
            hasRecentRunActivity ||
            hasActiveRun,
        };
      })
      .sort((left, right) => {
        if (left.visible && !right.visible) return -1;
        if (!left.visible && right.visible) return 1;
        if (left.defaultBranch && !right.defaultBranch) return -1;
        if (!left.defaultBranch && right.defaultBranch) return 1;
        const leftTime = getLatestTimestamp([
          left.latestCommitAt,
          left.lastRun?.completedAt || '',
          left.lastRun?.createdAt || '',
        ]);
        const rightTime = getLatestTimestamp([
          right.latestCommitAt,
          right.lastRun?.completedAt || '',
          right.lastRun?.createdAt || '',
        ]);
        if (!Number.isNaN(leftTime) || !Number.isNaN(rightTime)) {
          if (Number.isNaN(leftTime)) return 1;
          if (Number.isNaN(rightTime)) return -1;
          if (rightTime !== leftTime) return rightTime - leftTime;
        }
        return left.name.localeCompare(right.name, 'en');
      });
  }, [
    pushProfilesForSelectedRepository,
    remoteBranches,
    selectedRepository,
    selectedRepositoryRuns,
  ]);
  const selectedRepositoryBranchStates = useMemo(
    () =>
      selectedRepositoryAllBranchStates
        .filter((item) => item.visible)
        .map(stripBranchStateVisibility),
    [selectedRepositoryAllBranchStates],
  );

  const allRepositoryBranchStates = useMemo(
    () => selectedRepositoryAllBranchStates.map(stripBranchStateVisibility),
    [selectedRepositoryAllBranchStates],
  );

  const branchSpotlightItems = useMemo(
    () =>
      selectedRepositoryBranchStates
        .filter((item) => {
          const outcome = item.lastRun?.overall || item.lastRun?.status || '';
          return (
            item.defaultBranch ||
            item.isReviewing ||
            outcome === 'warn' ||
            outcome === 'fail' ||
            outcome === 'error'
          );
        })
        .slice(0, 6),
    [selectedRepositoryBranchStates],
  );
  const manualReviewFullFileSummary = useMemo(() => {
    if (!selectedRepository) return '';
    if (pushProfilesForSelectedRepository.length === 0) {
      return i18n.t('repoReview.manualReview.noProfile');
    }
    const enabledCount = pushProfilesForSelectedRepository.filter(
      (profile) => profile.includeFullFileContext,
    ).length;
    if (enabledCount === 0) {
      return i18n.t('repoReview.manualReview.diffOnly');
    }
    if (enabledCount === pushProfilesForSelectedRepository.length) {
      return i18n.t('repoReview.manualReview.allFullFile');
    }
    return i18n.t('repoReview.manualReview.partialFullFile', {
      enabled: enabledCount,
      total: pushProfilesForSelectedRepository.length,
    });
  }, [pushProfilesForSelectedRepository, selectedRepository]);

  const reviewViewMode = repositoryEditorOpen ? 'repository' : 'overview';

  const manualPendingRuns = useMemo(
    () =>
      runsForDisplay.filter(
        (run) =>
          run.stage === 'push' &&
          run.passDecisionMode === 'human' &&
          !run.manualDecision &&
          run.status === 'completed' &&
          run.overall !== 'error' &&
          run.overall !== 'skipped',
      ),
    [runsForDisplay],
  );

  const selectedRepositoryWorkspaceCards = useMemo(() => {
    if (!selectedRepository) return [];

    return [
      {
        title: t('repoReview.workspace.source'),
        action: 'repository-source',
        tone: selectedRepository.localRepoPath ? 'success' : 'warning',
        status: selectedRepository.localRepoPath
          ? t('repoReview.workspace.source.connected')
          : t('repoReview.workspace.source.pending'),
        value:
          selectedRepository.localRepoPath ||
          selectedRepository.remoteRepoSlug ||
          t('repoReview.workspace.source.notBound'),
        detail: `${formatRemoteProviderLabel(selectedRepository.remoteProvider)}${
          selectedRepository.defaultTargetBranch
            ? ` · ${t('repoReview.workspace.defaultBaseline', { branch: selectedRepository.defaultTargetBranch })}`
            : ''
        }`,
      },
      {
        title: t('repoReview.workspace.delivery'),
        action: 'repository-delivery',
        tone: selectedRepository.reviewChatJid ? 'success' : 'neutral',
        status: selectedRepository.reviewChatJid
          ? t('repoReview.workspace.delivery.ready')
          : t('repoReview.workspace.delivery.default'),
        value: formatReviewChatTarget(
          selectedRepository.reviewChatJid,
          conversations,
        ),
        detail: t('repoReview.workspace.delivery.feishuMapping', {
          count: selectedRepository.actorMentionMappings.length,
        }),
      },
      {
        title: t('repoReview.workspace.profile'),
        action: 'profile',
        tone: profilesForSelectedRepository.length > 0 ? 'success' : 'warning',
        status:
          profilesForSelectedRepository.length > 0
            ? t('repoReview.workspace.profile.configured')
            : t('repoReview.workspace.profile.pending'),
        value: t('repoReview.workspace.profile.count', {
          count: profilesForSelectedRepository.length,
        }),
        detail: selectedRepositoryLatestRun
          ? t('repoReview.workspace.profile.latestResult', {
              result: formatRunOutcomeLabel(
                selectedRepositoryLatestRun.overall ||
                  selectedRepositoryLatestRun.status,
              ),
            })
          : t('repoReview.workspace.profile.noRuns'),
      },
      {
        title: t('repoReview.workspace.autosync'),
        action: 'repository-autosync',
        tone: selectedRepository.autoSyncEnabled
          ? selectedRepository.lastAutoSyncStatus === 'error'
            ? 'warning'
            : 'success'
          : 'neutral',
        status: selectedRepository.autoSyncEnabled
          ? t('repoReview.workspace.autosync.enabled')
          : t('repoReview.workspace.autosync.manual'),
        value: selectedRepository.autoSyncEnabled
          ? t('repoReview.workspace.autosync.interval', {
              minutes: selectedRepository.autoSyncIntervalMinutes,
            })
          : t('repoReview.workspace.autosync.onDemand'),
        detail: selectedRepository.autoSyncEnabled
          ? t('repoReview.workspace.autosync.last', {
              status: formatRepoAutoSyncStatus(
                selectedRepository.lastAutoSyncStatus || '',
              ),
              time: formatOptionalDateTime(
                selectedRepository.lastAutoSyncAt || '',
              ),
            })
          : t('repoReview.workspace.autosync.webhookOnly'),
      },
      {
        title: t('repoReview.workspace.digest'),
        action: 'repository-autosync',
        tone:
          selectedRepository.digestDailyEnabled ||
          selectedRepository.digestWeeklyEnabled
            ? 'success'
            : 'neutral',
        status:
          selectedRepository.digestDailyEnabled ||
          selectedRepository.digestWeeklyEnabled
            ? t('repoReview.workspace.digest.enabled')
            : t('repoReview.workspace.digest.disabled'),
        value:
          [
            selectedRepository.digestDailyEnabled
              ? t('repoReview.workspace.digest.dailyTime', {
                  hour: selectedRepository.digestDailyHour,
                })
              : '',
            selectedRepository.digestWeeklyEnabled
              ? t('repoReview.workspace.digest.weeklyTime', {
                  weekday: '一二三四五六日'[
                    selectedRepository.digestWeeklyDay - 1
                  ],
                  hour: selectedRepository.digestWeeklyHour,
                })
              : '',
          ]
            .filter(Boolean)
            .join(' · ') || t('repoReview.workspace.digest.closed'),
        detail:
          selectedRepository.lastDigestDailyAt ||
          selectedRepository.lastDigestWeeklyAt
            ? [
                t('repoReview.workspace.digest.last', {
                  time: formatOptionalDateTime(
                    selectedRepository.lastDigestDailyAt ||
                      selectedRepository.lastDigestWeeklyAt ||
                      '',
                  ),
                }),
                selectedRepository.nextDigestDailyAt ||
                selectedRepository.nextDigestWeeklyAt
                  ? t('repoReview.workspace.digest.next', {
                      time: formatOptionalDateTime(
                        selectedRepository.nextDigestDailyAt ||
                          selectedRepository.nextDigestWeeklyAt ||
                          '',
                      ),
                    })
                  : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : selectedRepository.nextDigestDailyAt ||
                selectedRepository.nextDigestWeeklyAt
              ? t('repoReview.workspace.digest.next', {
                  time: formatOptionalDateTime(
                    selectedRepository.nextDigestDailyAt ||
                      selectedRepository.nextDigestWeeklyAt ||
                      '',
                  ),
                })
              : t('repoReview.workspace.digest.notExecuted'),
      },
    ] as Array<{
      title: string;
      action: RepoReviewWorkspaceCardAction;
      tone: 'success' | 'warning' | 'neutral';
      status: string;
      value: string;
      detail: string;
    }>;
  }, [
    conversations,
    profilesForSelectedRepository.length,
    selectedRepository,
    selectedRepositoryLatestRun,
  ]);

  const openRepositoryEditor = (
    create = false,
    section: RepositoryEditorSection = 'all',
  ) => {
    setCreatingRepository(create);
    setRepositoryEditorSection(section);
    setSelectedMentionMemberId('');
    setAdvancedMappingsOpen(false);
    if (create) {
      setRepositoryDraft({ ...EMPTY_REPOSITORY_DRAFT });
    } else {
      setRepositoryDraft(makeRepositoryDraft(selectedRepository));
    }
    setRepositorySectionOpen(true);
    setRepositoryEditorOpen(true);
  };

  const closeRepositoryEditor = () => {
    setRepositoryEditorOpen(false);
    setRepositoryEditorSection('all');
    setSelectedMentionMemberId('');
    setAdvancedMappingsOpen(false);
    if (!creatingRepository) {
      setRepositoryDraft(makeRepositoryDraft(selectedRepository));
    }
  };

  const openProfileEditor = (create = false) => {
    if (!selectedRepositoryId) return;
    setProfileSectionOpen(true);
    if (create) {
      setProfileDraft(makeProfileDraft(selectedRepositoryId));
    }
    setProfileEditorOpen(true);
  };

  const closeProfileEditor = () => {
    setProfileEditorOpen(false);
    if (selectedRepositoryId) {
      setProfileDraft((current) =>
        current.id
          ? current
          : resolveProfileDraft(
              selectedRepositoryId,
              profilesForSelectedRepository,
            ),
      );
    }
  };

  const refreshRepositoryCatalog = async (preserveFeedback = false) => {
    const requestId = ++overviewRequestIdRef.current;
    setLoading(true);
    if (!preserveFeedback) {
      setMessage('');
      setError('');
    }
    try {
      const nextRepositories = await fetchRepoReviewRepositories(apiBase, {
        summary: true,
      });
      if (requestId !== overviewRequestIdRef.current) return;
      if (!mountedRef.current) return;
      isInitialLoadRef.current = false;
      setRepositories(nextRepositories);
      setSelectedRepositoryId((current) => {
        if (creatingRepository) return current;
        if (current && nextRepositories.some((entry) => entry.id === current)) {
          return current;
        }
        return '';
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.loadConfig'),
      );
    } finally {
      setLoading(false);
    }
  };

  const refreshSelectedRepositoryDetail = async (
    repositoryId: string,
    preserveFeedback = true,
  ) => {
    const normalizedRepositoryId = repositoryId.trim();
    if (!normalizedRepositoryId) {
      setProfiles([]);
      setRuns([]);
      return;
    }
    const requestId = ++overviewRequestIdRef.current;
    setLoading(true);
    if (!preserveFeedback) {
      setMessage('');
      setError('');
    }
    try {
      const detail = await fetchRepoReviewRepositoryDetail(
        apiBase,
        normalizedRepositoryId,
      );
      if (requestId !== overviewRequestIdRef.current) return;
      if (!mountedRef.current) return;
      setRepositories((current) =>
        current.map((entry) =>
          entry.id === normalizedRepositoryId ? detail.repository : entry,
        ),
      );
      setProfiles(detail.profiles);
    } catch (err) {
      if (requestId !== overviewRequestIdRef.current) return;
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.loadConfig'),
      );
    } finally {
      if (requestId === overviewRequestIdRef.current && mountedRef.current) {
        setLoading(false);
      }
    }
  };

  const loadSshKeys = async () => {
    try {
      const response = await fetch(`${apiBase}/api/settings/ssh-keys`, {
        credentials: 'include',
      });
      if (!response.ok) {
        setSshKeys([]);
        return;
      }
      const payload = await response.json().catch(() => []);
      setSshKeys(Array.isArray(payload) ? (payload as SshKeyInfo[]) : []);
    } catch {
      setSshKeys([]);
    }
  };

  const refreshCurrentView = async (preserveFeedback = false) => {
    await refreshRepositoryCatalog(preserveFeedback);
    if (!selectedRepositoryId || creatingRepository) {
      return;
    }
    await refreshSelectedRepositoryDetail(selectedRepositoryId, true);
    await refreshRunSummaries(true);
  };

  const refreshRunSummaries = async (preserveFeedback = true) => {
    if (runsRefreshInFlightRef.current) return;
    if (!selectedRepositoryId) {
      setRuns([]);
      return;
    }
    runsRefreshInFlightRef.current = true;
    const requestId = ++runsRequestIdRef.current;
    const runSnapshotRequestId = ++runSnapshotRequestIdRef.current;
    setLoading(true);
    if (!preserveFeedback) {
      setMessage('');
      setError('');
    }
    try {
      const nextRuns = await fetchRepoReviewRunSummaries(apiBase, {
        repositoryId: selectedRepositoryId || undefined,
        status: runFilterStatus || undefined,
        keyword: runFilterText.trim() || undefined,
      });
      if (requestId !== runsRequestIdRef.current) return;
      if (!mountedRef.current) return;
      isInitialLoadRef.current = false;
      if (runSnapshotRequestId === runSnapshotRequestIdRef.current) {
        setRuns((current) =>
          mergeRepoReviewRunListSnapshots(nextRuns, current),
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.loadRuns'),
      );
    } finally {
      runsRefreshInFlightRef.current = false;
      if (requestId === runsRequestIdRef.current && mountedRef.current) {
        setLoading(false);
      }
    }
  };

  const refreshSelectedRunDetail = useCallback(
    async (runId: string) => {
      const detailRunId = runId.trim();
      if (!detailRunId || runDetailRefreshInFlightRef.current) return;
      runDetailRefreshInFlightRef.current = true;
      try {
        const data = await fetchRepoReviewRunDetail(apiBase, detailRunId);
        if (!mountedRef.current) return;
        setSelectedRunDetail((current) =>
          mergeFetchedRepoReviewRunSnapshot(data.run || null, current),
        );
      } catch {
        // Best effort poll refresh.
      } finally {
        runDetailRefreshInFlightRef.current = false;
      }
    },
    [apiBase],
  );

  const refreshDigestRuns = async (preserveFeedback = true) => {
    const repositoryId = selectedRepositoryId;
    if (!repositoryId) {
      setDigestRuns([]);
      return;
    }
    const requestId = ++digestRunsRequestIdRef.current;
    setLoadingDigestRuns(true);
    if (!preserveFeedback) {
      setMessage('');
      setError('');
    }
    try {
      const nextRuns = await fetchRepoReviewDigestRuns(
        apiBase,
        repositoryId,
        20,
      );
      if (requestId !== digestRunsRequestIdRef.current) return;
      if (!mountedRef.current) return;
      setDigestRuns(nextRuns);
    } catch (err) {
      if (requestId !== digestRunsRequestIdRef.current) return;
      if (!mountedRef.current) return;
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.loadDigestRuns'),
      );
    } finally {
      if (requestId === digestRunsRequestIdRef.current && mountedRef.current) {
        setLoadingDigestRuns(false);
      }
    }
  };

  const invalidateRemoteBranchCache = (repositoryId?: string) => {
    invalidateBranchCache(repositoryId);
  };

  const refreshRemoteBranches = async (
    force = false,
    preserveFeedback = true,
  ) => {
    if (!canLoadRemoteBranches) {
      setRemoteBranches([]);
      setLoadingRemoteBranches(false);
      return;
    }
    const repositoryId = selectedRepositoryId;
    const cachedBranches =
      !force && repositoryId ? getCachedBranches(repositoryId) : null;
    const requestId = ++remoteBranchRequestIdRef.current;
    const cacheIsFresh = Boolean(cachedBranches);
    if (cachedBranches) {
      setLoadingRemoteBranches(false);
      setRemoteBranches(cachedBranches);
    } else {
      setLoadingRemoteBranches(true);
    }
    if (!preserveFeedback) {
      setMessage('');
      setError('');
    }
    try {
      const nextBranches = await fetchRepoReviewRemoteBranches(
        apiBase,
        repositoryId,
        force,
      );
      if (requestId !== remoteBranchRequestIdRef.current) return;
      if (!mountedRef.current) return;
      setCachedBranches(repositoryId, nextBranches);
      setRemoteBranches(nextBranches);
    } catch (err) {
      if (requestId !== remoteBranchRequestIdRef.current) return;
      if (!mountedRef.current) return;
      if (!cacheIsFresh) {
        setRemoteBranches([]);
      }
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.loadRemoteBranches'),
      );
    } finally {
      if (
        requestId === remoteBranchRequestIdRef.current &&
        mountedRef.current
      ) {
        setLoadingRemoteBranches(false);
      }
    }
  };

  const refreshReviewChatMembers = async (
    chatJid: string,
    preserveFeedback = true,
  ) => {
    const normalizedChatJid = chatJid.trim();
    if (!normalizedChatJid || !normalizedChatJid.startsWith('feishu:')) {
      setReviewChatMembers([]);
      setReviewChatMembersError('');
      return;
    }
    setLoadingReviewChatMembers(true);
    if (!preserveFeedback) {
      setReviewChatMembersError('');
    }
    try {
      const members = await fetchRepoReviewChatMembers(
        apiBase,
        normalizedChatJid,
      );
      setReviewChatMembers(members);
      setReviewChatMembersError('');
    } catch (err) {
      setReviewChatMembers([]);
      setReviewChatMembersError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.loadFeishuMembers'),
      );
    } finally {
      setLoadingReviewChatMembers(false);
    }
  };

  const scheduleRepoReviewRealtimeRefresh = useCallback(
    (runId?: string) => {
      if (reviewRealtimeRefreshTimerRef.current !== null) {
        window.clearTimeout(reviewRealtimeRefreshTimerRef.current);
      }
      reviewRealtimeRefreshTimerRef.current = window.setTimeout(() => {
        reviewRealtimeRefreshTimerRef.current = null;
        if (!mountedRef.current) return;
        void refreshRunSummaries(true);
        const detailRunId = runId || selectedRunId;
        if (!detailRunId) return;
        void refreshSelectedRunDetail(detailRunId);
      }, 250);
    },
    [refreshRunSummaries, refreshSelectedRunDetail, selectedRunId],
  );

  const applyRepoReviewRealtimeEvents = useCallback(
    (
      events: Array<
        Extract<
          NonNullable<ReturnType<typeof normalizeConversationRealtimeEvent>>,
          { kind: 'turn_event' | 'stream' }
        >
      >,
    ) => {
      if (events.length === 0) return;
      const eventsByJid = new Map<
        string,
        Array<
          Extract<
            NonNullable<ReturnType<typeof normalizeConversationRealtimeEvent>>,
            { kind: 'turn_event' | 'stream' }
          >
        >
      >();
      for (const event of events) {
        const existing = eventsByJid.get(event.jid);
        if (existing) {
          existing.push(event);
        } else {
          eventsByJid.set(event.jid, [event]);
        }
      }

      setRuns((currentRuns) => {
        if (eventsByJid.size === 0) return currentRuns;
        const preferredRunByJid = new Map<
          string,
          {
            run: RepoReviewRun;
            index: number;
            activityMs: number;
            selected: boolean;
          }
        >();
        currentRuns.forEach((run, index) => {
          if (run.status !== 'queued' && run.status !== 'running') return;
          const jid = getRepoReviewRunChatJid(
            run,
            repositoryById.get(run.repositoryId),
          );
          const candidate = {
            run,
            index,
            activityMs: getRepoReviewRunActivityMs(run),
            selected: run.id === selectedRunId,
          };
          const existing = preferredRunByJid.get(jid);
          if (!existing) {
            preferredRunByJid.set(jid, candidate);
            return;
          }
          if (candidate.selected && !existing.selected) {
            preferredRunByJid.set(jid, candidate);
            return;
          }
          if (!candidate.selected && existing.selected) return;
          if (candidate.activityMs > existing.activityMs) {
            preferredRunByJid.set(jid, candidate);
          }
        });

        let nextRuns = currentRuns;
        for (const [jid, jidEvents] of eventsByJid) {
          const preferred = preferredRunByJid.get(jid);
          if (!preferred) continue;
          let updatedRun = preferred.run;
          for (const event of jidEvents) {
            updatedRun = applyRepoReviewRealtimeEventToRun(updatedRun, event);
          }
          if (updatedRun === preferred.run) continue;
          if (nextRuns === currentRuns) {
            nextRuns = [...currentRuns];
          }
          nextRuns[preferred.index] = updatedRun;
        }
        return nextRuns;
      });

      setSelectedRunDetail((current) => {
        if (!current) return current;
        const currentJid = getRepoReviewRunChatJid(
          current,
          repositoryById.get(current.repositoryId),
        );
        const currentEvents = eventsByJid.get(currentJid);
        if (!currentEvents || currentEvents.length === 0) return current;
        let next = current;
        for (const event of currentEvents) {
          next = applyRepoReviewRealtimeEventToRun(next, event);
        }
        return next;
      });

      const completedJid =
        events.find(
          (event) =>
            (event.kind === 'stream' && event.done) ||
            (event.kind === 'turn_event' &&
              (event.event.type === 'turn.completed' ||
                event.event.type === 'turn.failed')),
        )?.jid || '';
      if (!completedJid) return;

      const matchingRun =
        selectedRunData &&
        getRepoReviewRunChatJid(
          selectedRunData,
          repositoryById.get(selectedRunData.repositoryId),
        ) === completedJid
          ? selectedRunData
          : overview.runs.find(
              (run) =>
                getRepoReviewRunChatJid(
                  run,
                  repositoryById.get(run.repositoryId),
                ) === completedJid,
            ) || null;
      scheduleRepoReviewRealtimeRefresh(matchingRun?.id);
    },
    [
      overview.runs,
      repositoryById,
      scheduleRepoReviewRealtimeRefresh,
      selectedRunData,
      selectedRunId,
    ],
  );

  const flushPendingRepoReviewRealtimeEvents = useCallback(() => {
    if (!mountedRef.current || reviewRealtimePendingRef.current.length === 0) {
      return;
    }
    const ready = reviewRealtimePendingRef.current.filter((event) =>
      activeReviewRealtimeJids.has(event.jid),
    );
    if (ready.length === 0) return;
    const readySet = new Set(ready);
    reviewRealtimePendingRef.current = reviewRealtimePendingRef.current.filter(
      (event) => !readySet.has(event),
    );
    applyRepoReviewRealtimeEvents(ready);
  }, [activeReviewRealtimeJids, applyRepoReviewRealtimeEvents]);

  const handleRepoReviewRealtimeMessage = useCallback(
    (data: Record<string, unknown>) => {
      const normalized = normalizeConversationRealtimeEvent(data);
      if (
        !normalized ||
        (normalized.kind !== 'turn_event' && normalized.kind !== 'stream')
      ) {
        return;
      }

      if (typeof normalized.seq === 'number') {
        const lastSeq = reviewRealtimeLastSeqByJidRef.current[normalized.jid];
        if (typeof lastSeq === 'number' && normalized.seq <= lastSeq) {
          return;
        }
        reviewRealtimeLastSeqByJidRef.current[normalized.jid] = normalized.seq;
      }

      if (!activeReviewRealtimeJids.has(normalized.jid)) {
        reviewRealtimePendingRef.current.push(normalized);
        if (reviewRealtimePendingRef.current.length > 200) {
          reviewRealtimePendingRef.current =
            reviewRealtimePendingRef.current.slice(-200);
        }
        return;
      }

      if (!mountedRef.current) return;
      applyRepoReviewRealtimeEvents([normalized]);
    },
    [activeReviewRealtimeJids, applyRepoReviewRealtimeEvents],
  );

  useWebSocket(handleRepoReviewRealtimeMessage);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reviewRealtimePendingRef.current = [];
      if (reviewRealtimeRefreshTimerRef.current !== null) {
        window.clearTimeout(reviewRealtimeRefreshTimerRef.current);
        reviewRealtimeRefreshTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    flushPendingRepoReviewRealtimeEvents();
  }, [flushPendingRepoReviewRealtimeEvents]);

  useEffect(() => {
    void refreshRepositoryCatalog();
  }, []);

  useEffect(() => {
    if (creatingRepository) {
      return;
    }
    if (!selectedRepositoryId) {
      setProfiles([]);
      setRuns([]);
      runFilterKeyRef.current = '';
      return;
    }
    const filterKey = `${runFilterStatus}::${runFilterText.trim()}`;
    runFilterKeyRef.current = filterKey;
    setProfiles([]);
    setRuns([]);
    void refreshSelectedRepositoryDetail(selectedRepositoryId, true);
    void refreshRunSummaries(true);
  }, [creatingRepository, selectedRepositoryId]);

  useEffect(() => {
    if (!selectedRepositoryId) {
      runFilterKeyRef.current = '';
      return;
    }
    const nextKey = `${runFilterStatus}::${runFilterText.trim()}`;
    const previousKey = runFilterKeyRef.current;
    runFilterKeyRef.current = nextKey;
    if (nextKey === previousKey) {
      return;
    }
    if (!nextKey && !previousKey) {
      return;
    }
    void refreshRunSummaries(true);
  }, [runFilterStatus, runFilterText, selectedRepositoryId]);

  useEffect(() => {
    setRunsPage(1);
  }, [runFilterStatus, runFilterText, selectedRepositoryId]);

  useEffect(() => {
    if (
      !selectedRepositoryId ||
      repoDetailTab !== 'runs' ||
      !digestRunsSectionOpen
    ) {
      setDigestRuns([]);
      closeDigestRunDetail();
      return;
    }
    void refreshDigestRuns(true);
  }, [digestRunsSectionOpen, repoDetailTab, selectedRepositoryId]);

  useEffect(() => {
    if (runsPage > totalRunsPages) {
      setRunsPage(totalRunsPages);
    }
  }, [runsPage, totalRunsPages]);

  useEffect(() => {
    if (!selectedRepositoryId || pauseOverviewRefresh) return;
    const timer = window.setInterval(
      () => {
        void refreshRunSummaries(true);
      },
      hasActiveRuns ? 5000 : 30_000,
    );
    return () => window.clearInterval(timer);
  }, [
    hasActiveRuns,
    pauseOverviewRefresh,
    runFilterStatus,
    runFilterText,
    selectedRepositoryId,
  ]);

  useEffect(() => {
    if (!selectedRunId || pauseOverviewRefresh) return;
    const selectedRun = runs.find((entry) => entry.id === selectedRunId);
    if (!selectedRun) return;
    if (selectedRun.status !== 'queued' && selectedRun.status !== 'running') {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshSelectedRunDetail(selectedRunId);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pauseOverviewRefresh, refreshSelectedRunDetail, runs, selectedRunId]);

  useEffect(() => {
    if (!latestRunWithProgress) return;
    setRunsSectionOpen(true);
    setExpandedRunProgressIds((current) =>
      current.includes(latestRunWithProgress.id)
        ? current
        : [...current, latestRunWithProgress.id],
    );
  }, [latestRunWithProgress]);

  useEffect(() => {
    if (!selectedRunId) return;
    if (!overview.runs.some((entry) => entry.id === selectedRunId)) {
      closeRunDetail();
    }
  }, [overview.runs, selectedRunId]);

  useEffect(() => {
    if (!selectedDigestRunId) return;
    if (!digestRuns.some((entry) => entry.id === selectedDigestRunId)) {
      closeDigestRunDetail();
    }
  }, [digestRuns, selectedDigestRunId]);

  useEffect(() => {
    const previousInitialRepositoryId = previousInitialRepositoryIdRef.current;
    previousInitialRepositoryIdRef.current = initialRepositoryId || '';
    if (creatingRepository) return;
    if (!initialRepositoryId) {
      if (!previousInitialRepositoryId) return;
      setSelectedRepositoryId('');
      setRepositoryEditorOpen(false);
      setProfileEditorOpen(false);
      setRepoDetailTab('overview');
      return;
    }
    if (selectedRepositoryId === initialRepositoryId) {
      setRepoDetailTab(initialDetailTab);
      return;
    }
    if (
      !overview.repositories.some(
        (repository) => repository.id === initialRepositoryId,
      )
    ) {
      return;
    }
    setSelectedRepositoryId(initialRepositoryId);
    setRepositoryEditorOpen(false);
    setProfileEditorOpen(false);
    setRepoDetailTab(initialDetailTab);
  }, [
    creatingRepository,
    initialDetailTab,
    initialRepositoryId,
    overview.repositories,
    selectedRepositoryId,
  ]);

  useEffect(() => {
    if (selectedRepositoryId) return;
    setBranchStatusPanelOpen(false);
    setBranchStatusPanelInitialBranch('');
  }, [selectedRepositoryId]);

  useEffect(() => {
    if (!repositoryEditorOpen || repositoryEditorSection === 'all') return;
    const timer = window.setTimeout(() => {
      repositoryEditorSectionRefs.current[
        repositoryEditorSection
      ]?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 40);
    return () => window.clearTimeout(timer);
  }, [repositoryEditorOpen, repositoryEditorSection]);

  useEffect(() => {
    if (selectedRepositoryId) {
      invalidateRemoteBranchCache(selectedRepositoryId);
    }
  }, [selectedRepositoryId]);

  useEffect(() => {
    if (repositoryEditorOpen) {
      return;
    }
    if (creatingRepository) {
      setRepositoryDraft({ ...EMPTY_REPOSITORY_DRAFT });
      setProfileDraft({ ...EMPTY_PROFILE_DRAFT });
      setRepositoryDetectionWarnings([]);
      setLastRepositoryDetection(null);
      setSelectedDetectedRemoteName('');
      setAutoCreatedProfileNotice('');
      return;
    }
    setRepositoryDraft(makeRepositoryDraft(selectedRepository));
    setRepositoryDetectionWarnings([]);
    setLastRepositoryDetection(null);
    setSelectedDetectedRemoteName('');
    setAutoCreatedProfileNotice('');
  }, [creatingRepository, repositoryEditorOpen, selectedRepository]);

  useEffect(() => {
    if (creatingRepository || repositoryEditorOpen || profileEditorOpen) {
      return;
    }
    const repositoryId = selectedRepository?.id || '';
    setProfileDraft((current) => {
      if (!repositoryId) {
        return { ...EMPTY_PROFILE_DRAFT };
      }
      if (
        current.repositoryId === repositoryId &&
        current.id &&
        profilesForSelectedRepository.some(
          (profile) => profile.id === current.id,
        )
      ) {
        return current;
      }
      if (
        current.repositoryId === repositoryId &&
        !current.id &&
        profilesForSelectedRepository.length === 0
      ) {
        return current;
      }
      return resolveProfileDraft(
        repositoryId,
        profilesForSelectedRepository,
        current.repositoryId === repositoryId ? current.id : undefined,
      );
    });
  }, [
    creatingRepository,
    profileEditorOpen,
    profilesForSelectedRepository,
    repositoryEditorOpen,
    selectedRepository,
  ]);

  useEffect(() => {
    if (!shouldLoadRemoteBranches) {
      setRemoteBranches([]);
      return;
    }
    void refreshRemoteBranches(false);
  }, [selectedRepositoryId, shouldLoadRemoteBranches]);

  useEffect(() => {
    setSelectedMentionMemberId('');
    setAdvancedMappingsOpen(false);
  }, [effectiveReviewChatJid]);

  useEffect(() => {
    if (!repositoryEditorOpen || !isFeishuReviewChat) {
      setReviewChatMembers([]);
      setReviewChatMembersError('');
      return;
    }
    void refreshReviewChatMembers(effectiveReviewChatJid);
  }, [effectiveReviewChatJid, isFeishuReviewChat, repositoryEditorOpen]);

  useEffect(() => {
    if (!repositoryEditorOpen) return;
    void loadSshKeys();
  }, [repositoryEditorOpen]);

  const applyRepositoryDetection = (
    detection: RepoReviewRepositoryDetection,
  ) => {
    setRepositoryDraft((current) => ({
      ...current,
      name: current.name || detection.repositoryName || current.name,
      remoteProvider: detection.provider || current.remoteProvider,
      remoteRepoSlug: detection.remoteRepoSlug || current.remoteRepoSlug,
      remoteBaseUrl: detection.remoteBaseUrl || current.remoteBaseUrl,
      cloneUrl: detection.cloneUrl || current.cloneUrl,
      defaultTargetBranch:
        detection.defaultTargetBranch || current.defaultTargetBranch,
    }));
    setRepositoryDetectionWarnings(detection.warnings || []);
    setLastRepositoryDetection(detection);
    setSelectedDetectedRemoteName(detection.detectedRemoteName || '');
  };

  const toggleRunProgress = (runId: string) => {
    setExpandedRunProgressIds((current) =>
      current.includes(runId)
        ? current.filter((entry) => entry !== runId)
        : [...current, runId],
    );
  };

  const openRunDetail = async (run: RepoReviewRun) => {
    setSelectedRunId(run.id);
    setSelectedRunDetail(run);
    setLoadingRunDetail(true);
    try {
      const data = await fetchRepoReviewRunDetail(apiBase, run.id);
      setSelectedRunDetail((current) =>
        mergeFetchedRepoReviewRunSnapshot(data.run || run, current || run),
      );
    } catch (err) {
      setSelectedRunDetail(run);
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.loadRunDetail'),
      );
    } finally {
      setLoadingRunDetail(false);
    }
  };

  const openRunDetailById = async (runId: string) => {
    if (!runId) return;
    const existingRun = runs.find((entry) => entry.id === runId);
    setSelectedRunId(runId);
    if (existingRun) {
      setSelectedRunDetail(existingRun);
    }
    setLoadingRunDetail(true);
    try {
      const data = await fetchRepoReviewRunDetail(apiBase, runId);
      if (data.run) {
        setSelectedRunDetail((current) =>
          mergeFetchedRepoReviewRunSnapshot(
            data.run,
            current || existingRun || null,
          ),
        );
      } else if (existingRun) {
        setSelectedRunDetail(existingRun);
      } else {
        setSelectedRunDetail(null);
      }
    } catch (err) {
      if (existingRun) {
        setSelectedRunDetail(existingRun);
      }
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.loadRunDetail'),
      );
    } finally {
      setLoadingRunDetail(false);
    }
  };

  const closeRunDetail = () => {
    setSelectedRunId('');
    setSelectedRunDetail(null);
    setLoadingRunDetail(false);
  };

  const openDigestRunDetail = async (run: RepoReviewDigestRun) => {
    setSelectedDigestRunId(run.id);
    setSelectedDigestRunDetail(run);
    setLoadingDigestRunDetail(true);
    try {
      const data = await fetchRepoReviewDigestRunDetail(apiBase, run.id);
      setSelectedDigestRunDetail(data.run || run);
    } catch (err) {
      setSelectedDigestRunDetail(run);
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.loadDigestRunDetail'),
      );
    } finally {
      setLoadingDigestRunDetail(false);
    }
  };

  const closeDigestRunDetail = () => {
    setSelectedDigestRunId('');
    setSelectedDigestRunDetail(null);
    setLoadingDigestRunDetail(false);
  };

  const discoverRepositoryConfig = async (remoteNameOverride?: string) => {
    const localRepoPath = repositoryDraft.localRepoPath.trim();
    const remoteUrl = repositoryDraft.cloneUrl.trim();
    if (!localRepoPath && !remoteUrl) {
      setError(i18n.t('repoReview.error.discoverRepoHint'));
      setMessage('');
      return;
    }
    setDiscoveringRepository(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(
        `${apiBase}/api/repo-reviews/repositories/discover`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            localRepoPath,
            remoteUrl,
            remoteProvider: repositoryDraft.remoteProvider,
            remoteName:
              remoteNameOverride || selectedDetectedRemoteName || undefined,
          }),
        },
      );
      const data =
        await readRepoReviewJson<RepoReviewRepositoryDetectionResponse>(
          response,
        ).catch(() => ({ detection: undefined as never }));
      if (!response.ok) {
        throw new Error(
          (data as { error?: string }).error ||
            i18n.t('repoReview.error.discoverRepo'),
        );
      }
      const detection = data.detection;
      applyRepositoryDetection(detection);
      const sourceLabel =
        detection.source === 'local_repo'
          ? detection.detectedRemoteName
            ? `本地仓库 remote ${detection.detectedRemoteName}`
            : t('repoReview.form.localRepo')
          : t('repoReview.form.repoLink');
      setMessage(
        i18n.t('repoReview.success.discoveredRepo', { source: sourceLabel }),
      );

      const effectiveCloneUrl = detection.cloneUrl || remoteUrl;
      if (effectiveCloneUrl && detection.source === 'remote_url') {
        setContributorsLoading(true);
        fetch(
          `${apiBase}/api/repo-reviews/repositories/discover-contributors`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cloneUrl: effectiveCloneUrl }),
          },
        )
          .then((r) => (r.ok ? r.json() : { contributors: [] }))
          .then((d: { contributors?: { name: string; email: string }[] }) =>
            setDiscoveredContributors(d.contributors || []),
          )
          .catch(() => setDiscoveredContributors([]))
          .finally(() => setContributorsLoading(false));
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.discoverRepo'),
      );
    } finally {
      setDiscoveringRepository(false);
    }
  };

  const saveRepository = async () => {
    if (repositoryHasMappingErrors) {
      setError(i18n.t('repoReview.error.feishuMappingFormat'));
      setMessage('');
      return;
    }
    setError('');
    setMessage('');
    setSavingRepository(true);
    try {
      const manualReviewChatJid = customReviewChatJidInput.trim();
      if (
        reviewChatValue === CUSTOM_REVIEW_CHAT_VALUE &&
        !manualReviewChatJid
      ) {
        setError(i18n.t('repoReview.error.customChatJid'));
        return;
      }
      const payload = {
        ...repositoryDraft,
        actorMentionMappings: actorMentionMappingsState.entries,
        reviewChatJid:
          reviewChatValue === AUTO_REVIEW_CHAT_VALUE
            ? repositoryDraft.id
              ? `repo-review:${repositoryDraft.id}`
              : ''
            : reviewChatValue === CUSTOM_REVIEW_CHAT_VALUE
              ? manualReviewChatJid
              : reviewChatValue,
      };
      const url = repositoryDraft.id
        ? `${apiBase}/api/repo-reviews/repositories/${encodeURIComponent(repositoryDraft.id)}`
        : `${apiBase}/api/repo-reviews/repositories`;
      const method = repositoryDraft.id ? 'PATCH' : 'POST';
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          data.error || i18n.t('repoReview.error.saveRepository'),
        );
      }
      invalidateRemoteBranchCache(repositoryDraft.id);
      await refreshRepositoryCatalog(true);
      const nextRepository = data.repository as
        | RepoReviewRepository
        | undefined;
      const autoCreatedProfiles = Array.isArray(data.autoCreatedProfiles)
        ? (data.autoCreatedProfiles as RepoReviewProfile[])
        : [];
      const saveWarnings = Array.isArray(data.warnings)
        ? (data.warnings as string[])
        : [];
      if (nextRepository?.id) {
        setCreatingRepository(false);
        setSelectedRepositoryId(nextRepository.id);
        await refreshSelectedRepositoryDetail(nextRepository.id, true);
        await refreshRunSummaries(true);
        setRepositoryDraft(makeRepositoryDraft(nextRepository));
        setProfileDraft(
          makeProfileDraft(nextRepository.id, autoCreatedProfiles[0]),
        );
      }
      setRepositoryEditorOpen(false);
      setRepositorySectionOpen(false);
      setRepositoryDetectionWarnings(saveWarnings);
      setLastRepositoryDetection(null);
      setSelectedDetectedRemoteName('');
      setAutoCreatedProfileNotice(
        autoCreatedProfiles.length > 0
          ? i18n.t('repoReview.success.defaultTemplate', {
              names: autoCreatedProfiles
                .map((profile) => profile.name)
                .join('、'),
            })
          : '',
      );
      const webhookHint =
        nextRepository?.webhookUrl && nextRepository.remoteProvider
          ? i18n.t('repoReview.success.webhookHint', {
              provider:
                nextRepository.remoteProvider === 'github'
                  ? 'GitHub'
                  : nextRepository.remoteProvider === 'gitlab'
                    ? 'GitLab'
                    : 'Gitea',
            })
          : '';
      setMessage(
        (autoCreatedProfiles.length > 0
          ? i18n.t('repoReview.success.repoSavedWithProfiles', {
              count: autoCreatedProfiles.length,
            })
          : i18n.t('repoReview.success.repoSaved')) + webhookHint,
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.saveRepository'),
      );
    } finally {
      setSavingRepository(false);
    }
  };

  const toggleRepositoryEnabled = async (
    repoId: string,
    currentEnabled: boolean,
  ) => {
    const nextEnabled = !currentEnabled;
    const label = nextEnabled
      ? i18n.t('repoReview.button.enable')
      : i18n.t('repoReview.button.disable');
    openConfirmDialog({
      title: nextEnabled
        ? i18n.t('repoReview.confirm.enableRepo')
        : i18n.t('repoReview.confirm.disableRepo'),
      message: nextEnabled
        ? i18n.t('repoReview.confirm.enableRepoMessage')
        : i18n.t('repoReview.confirm.disableRepoMessage'),
      confirmLabel: i18n.t('repoReview.confirm.confirmAction', { label }),
      tone: nextEnabled ? 'primary' : 'warning',
      onConfirm: async () => {
        setError('');
        setMessage('');
        try {
          const response = await fetch(
            `${apiBase}/api/repo-reviews/repositories/${encodeURIComponent(repoId)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: nextEnabled }),
            },
          );
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(
              data.error || i18n.t('repoReview.error.toggleFailed', { label }),
            );
          }
          await refreshRepositoryCatalog(true);
          if (selectedRepositoryId === repoId) {
            await refreshSelectedRepositoryDetail(repoId, true);
          }
          setMessage(i18n.t('repoReview.success.repoToggled', { label }));
        } catch (err) {
          setError(
            err instanceof Error
              ? err.message
              : i18n.t('repoReview.error.toggleFailed', { label }),
          );
        }
      },
    });
  };

  const deleteRepository = async () => {
    if (!repositoryDraft.id) return;
    openConfirmDialog({
      title: i18n.t('repoReview.confirm.deleteRepo'),
      message: i18n.t('repoReview.confirm.deleteRepoMessage', {
        name: repositoryDraft.name || repositoryDraft.id,
      }),
      confirmLabel: i18n.t('repoReview.button.confirmDelete'),
      tone: 'danger',
      onConfirm: async () => {
        setError('');
        setMessage('');
        setDeletingRepository(true);
        try {
          const response = await fetch(
            `${apiBase}/api/repo-reviews/repositories/${encodeURIComponent(String(repositoryDraft.id || ''))}`,
            { method: 'DELETE' },
          );
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(
              data.error || i18n.t('repoReview.error.deleteRepository'),
            );
          }
          invalidateRemoteBranchCache(repositoryDraft.id);
          setCreatingRepository(false);
          setSelectedRepositoryId('');
          setRepositoryDraft({ ...EMPTY_REPOSITORY_DRAFT });
          setProfileDraft({ ...EMPTY_PROFILE_DRAFT });
          setRepositoryEditorOpen(false);
          setRepositorySectionOpen(false);
          setLastRepositoryDetection(null);
          setAutoCreatedProfileNotice('');
          await refreshRepositoryCatalog(true);
          setMessage(i18n.t('repoReview.success.repoDeleted'));
        } finally {
          setDeletingRepository(false);
        }
      },
    });
  };

  const saveProfile = async () => {
    if (!selectedRepositoryId) {
      setError(i18n.t('repoReview.error.selectRepo'));
      return;
    }
    setError('');
    setMessage('');
    setSavingProfile(true);
    try {
      const payload = {
        ...profileDraft,
        repositoryId: selectedRepositoryId,
        passDecisionMode:
          profileDraft.stage === 'push' ? profileDraft.passDecisionMode : 'ai',
        includeGlobs: splitGlobs(profileDraft.includeGlobsText),
        excludeGlobs: splitGlobs(profileDraft.excludeGlobsText),
      };
      const url = profileDraft.id
        ? `${apiBase}/api/repo-reviews/profiles/${encodeURIComponent(profileDraft.id)}`
        : `${apiBase}/api/repo-reviews/profiles`;
      const method = profileDraft.id ? 'PATCH' : 'POST';
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || i18n.t('repoReview.error.saveProfile'));
      }
      invalidateRemoteBranchCache(selectedRepositoryId);
      await refreshRepositoryCatalog(true);
      await refreshSelectedRepositoryDetail(selectedRepositoryId, true);
      const nextProfile = data.profile as RepoReviewProfile | undefined;
      if (nextProfile) {
        setProfileDraft(makeProfileDraft(selectedRepositoryId, nextProfile));
      }
      setProfileEditorOpen(false);
      setMessage(i18n.t('repoReview.success.profileSaved'));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.saveProfile'),
      );
    } finally {
      setSavingProfile(false);
    }
  };

  const deleteProfile = async () => {
    if (!profileDraft.id) return;
    openConfirmDialog({
      title: i18n.t('repoReview.confirm.deleteProfile'),
      message: i18n.t('repoReview.confirm.deleteProfileMessage', {
        name: profileDraft.name || profileDraft.id,
      }),
      confirmLabel: i18n.t('repoReview.button.confirmDelete'),
      tone: 'danger',
      onConfirm: async () => {
        setError('');
        setMessage('');
        setDeletingProfile(true);
        try {
          const response = await fetch(
            `${apiBase}/api/repo-reviews/profiles/${encodeURIComponent(String(profileDraft.id || ''))}`,
            { method: 'DELETE' },
          );
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(
              data.error || i18n.t('repoReview.error.deleteProfile'),
            );
          }
          invalidateRemoteBranchCache(selectedRepositoryId);
          await refreshRepositoryCatalog(true);
          await refreshSelectedRepositoryDetail(selectedRepositoryId, true);
          setProfileEditorOpen(false);
          setMessage(i18n.t('repoReview.success.profileDeleted'));
        } finally {
          setDeletingProfile(false);
        }
      },
    });
  };

  const syncSingleRemoteBranch = async (
    branch: string,
    request?: Partial<RepoReviewManualReviewRequest>,
  ) => {
    if (!selectedRepositoryId || !branch) return;
    if (syncingBranchNames.includes(branch)) {
      setLastSyncMessage(
        i18n.t('repoReview.success.branchProcessing', { branch }),
      );
      return;
    }
    const branchState = allRepositoryBranchStates.find(
      (entry) => entry.name === branch,
    );
    if (branchState?.isReviewing) {
      setLastSyncMessage(
        i18n.t('repoReview.success.branchAlreadyReviewing', { branch }),
      );
      return;
    }
    setError('');
    setMessage('');
    setLastSyncMessage('');
    setSyncingBranchNames((current) =>
      current.includes(branch) ? current : [...current, branch],
    );
    try {
      const branchRuns = selectedRepositoryRuns.filter(
        (run) => run.branch === branch,
      );
      const latestRun = branchRuns[0] || branchState?.lastRun || null;
      const currentHeadSha = branchState?.headSha || latestRun?.headSha || '';
      const requestedMode: RepoReviewManualReviewMode = request?.mode || 'auto';
      const shouldRepeatLatestScope =
        requestedMode === 'auto' &&
        !!latestRun &&
        !!latestRun.baseSha &&
        !!currentHeadSha &&
        latestRun.headSha === currentHeadSha;
      const normalizedMode: RepoReviewManualReviewMode = shouldRepeatLatestScope
        ? 'commit_sha'
        : requestedMode;
      const payload: RepoReviewManualReviewRequest = {
        branch,
        mode: normalizedMode,
        baselineRunId:
          normalizedMode === 'history_run'
            ? request?.baselineRunId || undefined
            : undefined,
        baselineSha:
          normalizedMode === 'commit_sha'
            ? request?.baselineSha || latestRun?.baseSha || undefined
            : undefined,
        allowRepeat:
          request?.allowRepeat ??
          (shouldRepeatLatestScope ||
            normalizedMode === 'last_reviewed' ||
            normalizedMode === 'history_run' ||
            normalizedMode === 'commit_sha' ||
            normalizedMode === 'full'),
      };
      const data = (await triggerRepoReviewManualBranch(
        apiBase,
        selectedRepositoryId,
        payload,
      )) as RepoReviewSingleBranchSyncResponse;
      setLastSyncMessage(
        data.reason ||
          (data.reused
            ? i18n.t('repoReview.success.branchDuplicateIgnored', { branch })
            : i18n.t('repoReview.success.branchTriggered', { branch })),
      );
      invalidateRemoteBranchCache(selectedRepositoryId);
      await refreshRunSummaries(true);
      await refreshRemoteBranches(true);
      if (data.runId) {
        await openRunDetailById(data.runId);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.triggerBranch'),
      );
    } finally {
      setSyncingBranchNames((current) =>
        current.filter((entry) => entry !== branch),
      );
    }
  };

  const setRepositoryEditorSectionRef =
    (section: Exclude<RepositoryEditorSection, 'all'>) =>
    (node: HTMLDivElement | null) => {
      repositoryEditorSectionRefs.current[section] = node;
    };

  const openWorkspaceCardAction = (action: RepoReviewWorkspaceCardAction) => {
    if (action === 'profile') {
      setProfileSectionOpen(true);
      openProfileEditor(profilesForSelectedRepository.length === 0);
      return;
    }
    const sectionMap: Record<
      Exclude<RepoReviewWorkspaceCardAction, 'profile'>,
      RepositoryEditorSection
    > = {
      'repository-source': 'source',
      'repository-delivery': 'delivery',
      'repository-autosync': 'autosync',
    };
    openRepositoryEditor(false, sectionMap[action]);
  };

  const selectRepoDetailTab = useCallback(
    (tab: RepoReviewPanelTab) => {
      setRepoDetailTab(tab);
      if (selectedRepositoryId) {
        onRepositoryRouteChange?.(selectedRepositoryId, tab);
      }
    },
    [onRepositoryRouteChange, selectedRepositoryId],
  );

  const openWorkspaceDetail = useCallback(
    (repositoryId: string) => {
      setCreatingRepository(false);
      setSelectedRepositoryId(repositoryId);
      setRepositoryEditorOpen(false);
      setProfileEditorOpen(false);
      setRepoDetailTab('overview');
      onRepositoryRouteChange?.(repositoryId, 'overview');
    },
    [onRepositoryRouteChange],
  );

  const closeWorkspaceDetail = useCallback(() => {
    setSelectedRepositoryId('');
    setCreatingRepository(false);
    setRepositoryEditorOpen(false);
    setProfileEditorOpen(false);
    setRepoDetailTab('overview');
    onRepositoryRouteChange?.(null);
  }, [onRepositoryRouteChange]);

  const openBranchReviewWorkbench = (branch?: string) => {
    setBranchStatusPanelInitialBranch(branch || '');
    setBranchStatusPanelOpen(true);
    void refreshRemoteBranches(true, true);
  };

  const openConfirmDialog = (input: {
    title: string;
    message: string;
    confirmLabel: string;
    tone?: 'danger' | 'primary' | 'warning';
    onConfirm: () => Promise<void>;
  }) => {
    setConfirmDialog({
      open: true,
      title: input.title,
      message: input.message,
      confirmLabel: input.confirmLabel,
      tone: input.tone || 'primary',
      pending: false,
      onConfirm: input.onConfirm,
    });
  };

  const closeConfirmDialog = () => {
    setConfirmDialog(EMPTY_CONFIRM_DIALOG);
  };

  const runConfirmDialog = async () => {
    const action = confirmDialog.onConfirm;
    if (!action || confirmDialog.pending) return;
    setConfirmDialog((current) => ({ ...current, pending: true }));
    try {
      await action();
      setConfirmDialog(EMPTY_CONFIRM_DIALOG);
    } catch (err) {
      setConfirmDialog(EMPTY_CONFIRM_DIALOG);
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.operationFailed'),
      );
    }
  };

  const isRunCancellable = (run: RepoReviewRun) =>
    run.status === 'queued' || run.status === 'running';

  const isRunCancelling = (runId: string) => cancellingRunIds.includes(runId);

  const isRunRerunning = (runId: string) => rerunningRunIds.includes(runId);

  const rerunRun = async (run: RepoReviewRun) => {
    if (run.status === 'queued' || run.status === 'running') return;
    setError('');
    setMessage('');
    setRerunningRunIds((current) =>
      current.includes(run.id) ? current : [...current, run.id],
    );
    try {
      const result = await rerunRepoReviewRun(apiBase, run.id);
      if (result.run?.id) {
        setMessage(
          result.message || i18n.t('repoReview.success.rerunTriggered'),
        );
        await refreshRunSummaries(true);
        if (selectedRepositoryId === run.repositoryId) {
          await refreshRemoteBranches(true);
        }
        await openRunDetailById(result.run.id);
      } else {
        setError(result.error || i18n.t('repoReview.error.rerunFailed'));
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.rerunFailed'),
      );
    } finally {
      setRerunningRunIds((current) =>
        current.filter((entry) => entry !== run.id),
      );
    }
  };

  const cancelRun = async (run: RepoReviewRun) => {
    if (!isRunCancellable(run)) return;
    setError('');
    setMessage('');
    setCancellingRunIds((current) =>
      current.includes(run.id) ? current : [...current, run.id],
    );
    try {
      const result = await cancelRepoReviewRun(apiBase, run.id);
      if (result.cancelled) {
        setMessage(i18n.t('repoReview.success.cancelled'));
      } else if (result.error) {
        setError(result.error);
      } else {
        setMessage(i18n.t('repoReview.success.cancelNotEffective'));
      }
      if (selectedRunId === run.id && result.run) {
        setSelectedRunDetail(result.run);
      }
      await refreshRunSummaries(true);
      if (selectedRepositoryId === run.repositoryId) {
        await refreshRemoteBranches(true);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : i18n.t('repoReview.error.cancelFailed'),
      );
    } finally {
      setCancellingRunIds((current) =>
        current.filter((entry) => entry !== run.id),
      );
    }
  };

  const decideRunByHuman = async (
    run: RepoReviewRun,
    decision: 'pass' | 'fail',
  ) => {
    const label =
      decision === 'pass'
        ? i18n.t('repoReview.button.manualPass')
        : i18n.t('repoReview.button.manualFail');
    openConfirmDialog({
      title: i18n.t('repoReview.confirm.humanDecision'),
      message: i18n.t('repoReview.confirm.humanDecisionMessage', {
        runId: run.id,
        label,
      }),
      confirmLabel: i18n.t('repoReview.confirm.confirmAction', { label }),
      tone: decision === 'fail' ? 'danger' : 'primary',
      onConfirm: async () => {
        setError('');
        setMessage('');
        setManualDecisionRunId(run.id);
        try {
          const response = await fetch(
            `${apiBase}/api/repo-reviews/runs/${encodeURIComponent(run.id)}/manual-decision`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision }),
            },
          );
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(
              data.error || i18n.t('repoReview.error.manualDecisionFailed'),
            );
          }
          await refreshRunSummaries(true);
          if (selectedRunId === run.id) {
            const detail = await fetchRepoReviewRunDetail(
              apiBase,
              run.id,
            ).catch(() => null);
            if (detail?.run) {
              setSelectedRunDetail(detail.run);
            }
          }
          setMessage(
            decision === 'pass'
              ? i18n.t('repoReview.success.manualPass')
              : i18n.t('repoReview.success.manualFail'),
          );
        } finally {
          setManualDecisionRunId('');
        }
      },
    });
  };

  const toggleTargetBranch = (branch: string) => {
    setProfileDraft((current) => ({
      ...current,
      targetBranches: current.targetBranches.includes(branch)
        ? current.targetBranches.filter((entry) => entry !== branch)
        : [...current.targetBranches, branch],
    }));
  };

  const upsertMentionMapping = (actorValue: string, memberId: string) => {
    const actor = normalizeActorBindingValue(actorValue);
    if (!actor || !memberId) {
      setError(i18n.t('repoReview.error.fillActorAndMember'));
      return;
    }
    const member = availableReviewChatMembers.find(
      (entry) => entry.id === memberId,
    );
    if (!member) {
      setError(i18n.t('repoReview.error.memberNotFound'));
      return;
    }
    setRepositoryDraft((current) => ({
      ...current,
      actorMentionDraftRows: [
        ...current.actorMentionDraftRows.filter(
          (row) => normalizeActorBindingValue(row.actor) !== actor,
        ),
        {
          key: createActorMentionDraftRow().key,
          actor,
          memberId: member.id,
        },
      ].sort((left, right) => left.actor.localeCompare(right.actor, 'en')),
      actorMentionMappingsText: serializeActorMentionMappings(
        parseActorMentionMappingsInput(
          current.actorMentionMappingsText,
        ).entries.filter((entry) => entry.actor !== actor),
      ),
    }));
    setError('');
  };

  const appendMentionDraftRow = (
    actorValue = '',
    memberId = selectedMentionMemberId,
  ) => {
    setRepositoryDraft((current) => ({
      ...current,
      actorMentionDraftRows: [
        ...current.actorMentionDraftRows,
        {
          key: createActorMentionDraftRow().key,
          actor: normalizeActorBindingValue(actorValue),
          memberId,
        },
      ],
    }));
    setError('');
  };

  const updateMentionDraftRow = (
    rowKey: string,
    patch: Partial<Pick<ActorMentionDraftRow, 'actor' | 'memberId'>>,
  ) => {
    setRepositoryDraft((current) => ({
      ...current,
      actorMentionDraftRows: current.actorMentionDraftRows.map((row) =>
        row.key === rowKey
          ? {
              ...row,
              ...patch,
              actor:
                patch.actor === undefined
                  ? row.actor
                  : normalizeActorBindingValue(patch.actor),
            }
          : row,
      ),
    }));
    setError('');
  };

  const removeMentionDraftRow = (rowKey: string) => {
    setRepositoryDraft((current) => ({
      ...current,
      actorMentionDraftRows: current.actorMentionDraftRows.filter(
        (row) => row.key !== rowKey,
      ),
    }));
  };

  const applyIdentityCandidate = (actor: string) => {
    if (selectedMentionMemberId) {
      upsertMentionMapping(actor, selectedMentionMemberId);
      return;
    }
    const normalizedActor = normalizeActorBindingValue(actor);
    setRepositoryDraft((current) => {
      if (
        current.actorMentionDraftRows.some(
          (row) => normalizeActorBindingValue(row.actor) === normalizedActor,
        )
      ) {
        return current;
      }
      return {
        ...current,
        actorMentionDraftRows: [
          ...current.actorMentionDraftRows,
          {
            key: createActorMentionDraftRow().key,
            actor: normalizedActor,
            memberId: '',
          },
        ],
      };
    });
    setError('');
  };

  const profileCountByRepo = useMemo(() => {
    const counts = new Map<string, number>();
    for (const profile of overview.profiles) {
      counts.set(
        profile.repositoryId,
        (counts.get(profile.repositoryId) || 0) + 1,
      );
    }
    return counts;
  }, [overview.profiles]);

  return (
    <div
      className={`${embedded ? 'page-view ' : ''}settings-section repo-review-panel${embedded ? ' repo-review-panel--embedded' : ''}`.trim()}
    >
      {embedded ? (
        !repositoryWorkspaceFocused ? (
          <AppHeroHeader
            title={t('auto.c270fc6f')}
            subtitle={t('panel.description')}
            className="repo-review-topbar"
            controls={
              repositoryCatalogVisible ? (
                <>
                  <SearchPill
                    value={repositoryFilter}
                    onChange={(value) => {
                      setRepositoryFilter(value);
                      setRepoCardPage(1);
                    }}
                    placeholder={t('repoReview.repo.filterPlaceholder')}
                    aria-label={t('repoReview.repo.filterPlaceholder')}
                    leadingIcon={<IconSearch />}
                    clearLabel={t('清空搜索')}
                  />
                  <button
                    className="btn-primary workflow-create-action"
                    onClick={() => {
                      onRepositoryRouteChange?.(null);
                      openRepositoryEditor(true);
                      setRepoDetailTab('config');
                    }}
                  >
                    {t('repoReview.button.newRepo')}
                  </button>
                </>
              ) : null
            }
          />
        ) : null
      ) : (
        <div className="section-header">
          <div>
            <h3>Repo Review</h3>
            <p className="settings-hint">{t('repoReview.panel.description')}</p>
          </div>
          <button
            className="btn-outline btn-sm"
            onClick={() => void refreshCurrentView()}
            disabled={loading && isInitialLoadRef.current}
          >
            {loading && isInitialLoadRef.current
              ? t('repoReview.common.loading')
              : t('repoReview.button.refresh')}
          </button>
        </div>
      )}

      <div
        className={`repository-review-page-body repo-review-workspace-layout${repositoryWorkspaceFocused ? ' repo-review-workspace-layout--focused' : ''}${showWorkspaceDetail ? '' : ' repo-review-workspace-layout--list-only'}`}
      >
        {repositoryCatalogVisible ? (
          <div className="repo-review-card-list repo-review-workspace-list">
            {filteredRepositories.length === 0 ? (
              <div className="repo-review-empty-card-hint">
                {t('repoReview.repo.noMatch')}
              </div>
            ) : (
              <section className="repo-review-library">
                <div className="nc-catalog-grid repo-review-cards-grid">
                  {filteredRepositories
                    .slice(
                      (repoCardPage - 1) * REPO_CARD_PAGE_SIZE,
                      repoCardPage * REPO_CARD_PAGE_SIZE,
                    )
                    .map((repository) => (
                      <LibraryCard
                        key={repository.id}
                        className={`repo-review-repo-card ${
                          !creatingRepository &&
                          selectedRepositoryId === repository.id
                            ? 'active'
                            : ''
                        }`}
                        onClick={() => openWorkspaceDetail(repository.id)}
                        heading={repository.name}
                        badge={
                          <span
                            className={`repo-review-badge ${repository.enabled ? 'enabled' : 'disabled'}`}
                          >
                            {repository.enabled
                              ? t('repoReview.repo.enabledBadge')
                              : t('repoReview.repo.disabledBadge')}
                          </span>
                        }
                        rows={[
                          {
                            label: t('repoReview.repo.language'),
                            value:
                              repository.language ||
                              t('repoReview.repo.notSet'),
                          },
                          {
                            label: t('repoReview.repo.platform'),
                            value: `${formatRemoteProviderLabel(repository.remoteProvider)}${
                              repository.remoteRepoSlug
                                ? ` · ${repository.remoteRepoSlug}`
                                : ''
                            }`,
                          },
                          {
                            label: t('repoReview.repoCard.profile'),
                            value: `${t('repoReview.repoCard.profileCount', {
                              count:
                                repository.profileCount ??
                                profileCountByRepo.get(repository.id) ??
                                0,
                            })}${
                              repository.defaultTargetBranch
                                ? ` · ${t('repoReview.repoCard.baseline', {
                                    branch: repository.defaultTargetBranch,
                                  })}`
                                : ''
                            }`,
                          },
                          {
                            label: t('repoReview.repoCard.session'),
                            value: formatReviewChatTarget(
                              repository.reviewChatJid,
                              conversations,
                            ),
                          },
                          {
                            label: t('repoReview.repoCard.polling'),
                            value: repository.autoSyncEnabled
                              ? `${t('repoReview.repoCard.pollInterval', {
                                  minutes: repository.autoSyncIntervalMinutes,
                                })}${
                                  repository.lastAutoSyncStatus
                                    ? ` · ${formatRepoAutoSyncStatus(
                                        repository.lastAutoSyncStatus,
                                      )}`
                                    : ''
                                }`
                              : null,
                          },
                        ]}
                      />
                    ))}
                </div>
                {filteredRepositories.length > REPO_CARD_PAGE_SIZE ? (
                  <div className="repo-review-library-pagination">
                    <Pagination
                      page={repoCardPage}
                      pageSize={REPO_CARD_PAGE_SIZE}
                      total={filteredRepositories.length}
                      onPageChange={setRepoCardPage}
                    />
                  </div>
                ) : null}
              </section>
            )}
          </div>
        ) : null}

        {showWorkspaceDetail ? (
          <RepoReviewWorkspaceDetailSurface
            embedded={embedded}
            open={showWorkspaceDetail}
            onClose={closeWorkspaceDetail}
          >
            <section className="repo-review-workspace-detail">
              {creatingRepository || !repositoryWorkspaceFocused ? (
                <div className="repo-review-workspace-detail-header">
                  <div>
                    <h3>
                      {creatingRepository
                        ? t('repoReview.drawer.newWorkspace')
                        : selectedRepository?.name ||
                          t('repoReview.drawer.repoDetail')}
                    </h3>
                    <p className="settings-hint">
                      {creatingRepository
                        ? t('repoReview.hero.newRepoHint')
                        : selectedRepository?.remoteRepoSlug ||
                          t('repoReview.repo.noMatch')}
                    </p>
                  </div>
                  {(selectedRepositoryId || creatingRepository) &&
                  !hideRepositoryList ? (
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={closeWorkspaceDetail}
                    >
                      {embedded ? '返回列表' : t('repoReview.button.close')}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {!!selectedRepositoryId || creatingRepository ? (
                <div className="repo-review-drawer-content repo-review-inline-detail-content">
                  {!creatingRepository &&
                    selectedRepository &&
                    !repositoryEditorOpen && (
                      <>
                        <TabBar
                          tabs={[
                            {
                              key: 'overview',
                              label: t('repoReview.tab.overview'),
                            },
                            {
                              key: 'profile',
                              label: t('repoReview.tab.profile'),
                            },
                            { key: 'runs', label: t('repoReview.tab.runs') },
                            {
                              key: 'project-graph',
                              label: t('repoReview.tab.projectGraph'),
                            },
                            {
                              key: 'codemap',
                              label: t('repoReview.tab.codemap'),
                            },
                            {
                              key: 'config',
                              label: t('repoReview.tab.config'),
                            },
                          ]}
                          activeKey={repoDetailTab}
                          onChange={(key) =>
                            selectRepoDetailTab(key as RepoReviewPanelTab)
                          }
                        />
                      </>
                    )}

                  {/* Creating Repository */}
                  {creatingRepository && (
                    <div className="repo-review-card repo-review-overview-hero">
                      <div className="repo-review-overview-hero-top">
                        <div className="repo-review-overview-copy">
                          <span className="repo-review-overview-kicker">
                            {t('repoReview.workspace.repositoryWorkspace')}
                          </span>
                          <h3>{t('repoReview.hero.newRepoTitle')}</h3>
                          <div className="settings-hint">
                            {t('repoReview.hero.newRepoHint')}
                          </div>
                        </div>
                        <div className="repo-review-overview-actions">
                          <button
                            type="button"
                            className="btn-primary btn-sm"
                            onClick={() => {
                              openRepositoryEditor(true);
                              setRepoDetailTab('config');
                            }}
                          >
                            {t('repoReview.hero.fillRepoInfo')}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Tab: Overview */}
                  {!creatingRepository &&
                    selectedRepository &&
                    !repositoryEditorOpen &&
                    repoDetailTab === 'overview' && (
                      <>
                        <div className="repo-review-framework-shell">
                          <div className="repo-review-card repo-review-framework-header">
                            <div className="repo-review-framework-header-copy">
                              <span className="repo-review-overview-kicker">
                                {t('repoReview.workspace.repositoryWorkspace')}
                              </span>
                              <h3>{selectedRepository.name}</h3>
                              <div className="settings-hint repo-review-ellipsis">
                                {selectedRepository.remoteRepoSlug ||
                                  t('repoReview.workspace.defaultBaseline', {
                                    branch:
                                      selectedRepository.defaultTargetBranch ||
                                      t('repoReview.repo.notSet'),
                                  })}
                              </div>
                            </div>
                            <div className="repo-review-framework-header-main">
                              <div className="repo-review-framework-repo-pill">
                                <span className="repo-review-framework-repo-pill-icon">
                                  <IconFolder />
                                </span>
                                <div className="repo-review-framework-repo-pill-copy">
                                  <strong>
                                    {formatRemoteProviderLabel(
                                      selectedRepository.remoteProvider,
                                    )}
                                    {selectedRepository.remoteRepoSlug
                                      ? ` / ${selectedRepository.remoteRepoSlug}`
                                      : ''}
                                  </strong>
                                  <span>
                                    {selectedRepository.defaultTargetBranch ||
                                      t('repoReview.repo.notSet')}
                                  </span>
                                </div>
                              </div>
                              <div className="repo-review-framework-header-actions">
                                <button
                                  type="button"
                                  className={`btn-sm ${selectedRepository.enabled ? 'btn-warning' : 'btn-success'}`}
                                  onClick={() =>
                                    void toggleRepositoryEnabled(
                                      selectedRepository.id,
                                      selectedRepository.enabled,
                                    )
                                  }
                                >
                                  {selectedRepository.enabled
                                    ? t('repoReview.button.disable')
                                    : t('repoReview.button.enable')}
                                </button>
                                <button
                                  type="button"
                                  className="btn-outline btn-sm"
                                  onClick={() => {
                                    openRepositoryEditor(false);
                                    selectRepoDetailTab('config');
                                  }}
                                >
                                  {t('repoReview.button.editRepo')}
                                </button>
                                <button
                                  type="button"
                                  className="btn-primary btn-sm"
                                  onClick={() => {
                                    openProfileEditor(true);
                                    selectRepoDetailTab('profile');
                                  }}
                                  disabled={!selectedRepositoryId}
                                >
                                  {t('repoReview.button.newProfile')}
                                </button>
                              </div>
                            </div>
                          </div>

                          <div className="repo-review-framework-board repo-review-framework-board--single">
                            <div className="repo-review-framework-main">
                              <div className="repo-review-card repo-review-overview-hero repo-review-overview-hero--framework">
                                <div className="repo-review-card-header">
                                  <div>
                                    <h4>{t('repoReview.panel.description')}</h4>
                                    <div className="settings-hint">
                                      {manualReviewFullFileSummary}
                                    </div>
                                  </div>
                                  <div className="repo-review-source-summary">
                                    <span
                                      className={`repo-review-status-badge ${
                                        selectedRepository.enabled
                                          ? 'enabled'
                                          : 'disabled'
                                      }`}
                                    >
                                      {selectedRepository.enabled
                                        ? t('repoReview.repoStatus.enabled')
                                        : t('repoReview.repoStatus.disabled')}
                                    </span>
                                    <span className="repo-review-source-pill tone-neutral">
                                      {formatRemoteProviderLabel(
                                        selectedRepository.remoteProvider,
                                      )}
                                    </span>
                                    {selectedRepositoryLatestRun ? (
                                      <span
                                        className={`repo-review-status-badge status-${
                                          selectedRepositoryLatestRun.overall ||
                                          selectedRepositoryLatestRun.status
                                        }`}
                                      >
                                        {t('repoReview.overview.latestReview')}{' '}
                                        {formatRunOutcomeLabel(
                                          selectedRepositoryLatestRun.overall ||
                                            selectedRepositoryLatestRun.status,
                                        )}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="repo-review-workspace-grid repo-review-workspace-grid--framework">
                                  {selectedRepositoryWorkspaceCards.map(
                                    (item) => (
                                      <button
                                        key={item.title}
                                        type="button"
                                        className="repo-review-workspace-card repo-review-workspace-card--framework actionable"
                                        onClick={() =>
                                          openWorkspaceCardAction(item.action)
                                        }
                                      >
                                        <div className="repo-review-framework-card-icon">
                                          {renderWorkspaceCardIcon(item.action)}
                                        </div>
                                        <div className="repo-review-workspace-card-topline">
                                          <span>{item.title}</span>
                                          <span
                                            className={`repo-review-source-pill tone-${item.tone}`}
                                          >
                                            {item.status}
                                          </span>
                                        </div>
                                        <strong className="repo-review-workspace-card-value">
                                          {item.value}
                                        </strong>
                                        <div className="settings-hint">
                                          {item.detail}
                                        </div>
                                      </button>
                                    ),
                                  )}
                                </div>
                              </div>

                              <div className="repo-review-framework-content-grid">
                                <RepositoryRelationshipsPanel
                                  repositoryId={selectedRepository.id}
                                />
                                <div className="repo-review-card repo-review-manual-review-card">
                                  <div className="repo-review-card-header">
                                    <div>
                                      <h4>
                                        {t('repoReview.manualReview.title')}
                                      </h4>
                                      <div className="settings-hint">
                                        {t(
                                          'repoReview.manualReview.selectBaselineHint',
                                        )}
                                      </div>
                                    </div>
                                    <div className="repo-review-inline-actions">
                                      <button
                                        type="button"
                                        className="btn-outline btn-sm"
                                        onClick={() =>
                                          openBranchReviewWorkbench()
                                        }
                                      >
                                        {t('repoReview.branchStatus.viewAll')}
                                      </button>
                                    </div>
                                  </div>
                                  {branchSpotlightItems.length ? (
                                    <div className="repo-review-spotlight-list">
                                      {branchSpotlightItems.map((item) => (
                                        <div
                                          key={item.name}
                                          className="repo-review-spotlight-item repo-review-manual-branch-item"
                                        >
                                          <div className="repo-review-spotlight-main">
                                            <strong>{item.name}</strong>
                                            <div className="repo-review-spotlight-meta">
                                              {item.defaultBranch ? (
                                                <span>
                                                  {t(
                                                    'repoReview.branchStatus.defaultBaseline',
                                                  )}
                                                </span>
                                              ) : null}
                                              {item.actor ? (
                                                <span>{item.actor}</span>
                                              ) : null}
                                              {item.latestCommitAt ? (
                                                <span>
                                                  {t(
                                                    'repoReview.branchStatus.recentCommit',
                                                    {
                                                      time: formatOptionalDateTime(
                                                        item.latestCommitAt,
                                                      ),
                                                    },
                                                  )}
                                                </span>
                                              ) : null}
                                            </div>
                                            <div
                                              className="settings-hint repo-review-summary-preview"
                                              title={
                                                item.lastRun?.summary ||
                                                item.title ||
                                                t(
                                                  'repoReview.branchStatus.noSummary',
                                                )
                                              }
                                            >
                                              {item.lastRun?.summary ||
                                                item.title ||
                                                t(
                                                  'repoReview.branchStatus.noRecentSummary',
                                                )}
                                            </div>
                                          </div>
                                          <div className="repo-review-manual-branch-side">
                                            <div className="repo-review-source-summary">
                                              {item.isReviewing ? (
                                                <span className="repo-review-source-pill tone-success">
                                                  {t(
                                                    'repoReview.branchStatus.reviewing',
                                                  )}
                                                </span>
                                              ) : null}
                                              {item.lastRun ? (
                                                <span
                                                  className={`repo-review-status-badge status-${
                                                    item.lastRun.overall ||
                                                    item.lastRun.status
                                                  }`}
                                                >
                                                  {formatRunOutcomeLabel(
                                                    item.lastRun.overall ||
                                                      item.lastRun.status,
                                                  )}
                                                </span>
                                              ) : (
                                                <span className="repo-review-source-pill tone-neutral">
                                                  {t(
                                                    'repoReview.branchStatus.noRuns',
                                                  )}
                                                </span>
                                              )}
                                            </div>
                                            <div className="repo-review-inline-actions">
                                              {item.lastRun ? (
                                                <button
                                                  type="button"
                                                  className="btn-outline btn-sm repo-review-btn-compact"
                                                  onClick={() => {
                                                    if (!item.lastRun) return;
                                                    void openRunDetail(
                                                      item.lastRun,
                                                    );
                                                  }}
                                                >
                                                  {t(
                                                    'repoReview.button.viewDetail',
                                                  )}
                                                </button>
                                              ) : null}
                                              <button
                                                type="button"
                                                className="btn-primary btn-sm repo-review-btn-compact"
                                                onClick={() =>
                                                  openBranchReviewWorkbench(
                                                    item.name,
                                                  )
                                                }
                                                disabled={
                                                  !selectedRepository.remoteProvider ||
                                                  item.isReviewing ||
                                                  syncingBranchNames.includes(
                                                    item.name,
                                                  )
                                                }
                                              >
                                                {item.isReviewing ||
                                                syncingBranchNames.includes(
                                                  item.name,
                                                )
                                                  ? t(
                                                      'repoReview.branchStatus.reviewing',
                                                    )
                                                  : t(
                                                      'repoReview.branchStatus.selectBaseline',
                                                    )}
                                              </button>
                                            </div>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="repo-review-empty-hint">
                                      {t(
                                        'repoReview.branchStatus.noPriorityBranches',
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        {manualPendingRuns.length > 0 ? (
                          <div className="repo-review-card">
                            <div className="repo-review-card-header">
                              <div>
                                <h4>{t('repoReview.manualDecision.title')}</h4>
                                <div className="settings-hint">
                                  {t('repoReview.manualDecision.pendingHint')}
                                </div>
                              </div>
                              <span className="repo-review-status-badge status-warn">
                                {t('repoReview.manualDecision.pendingCount', {
                                  count: manualPendingRuns.length,
                                })}
                              </span>
                            </div>
                            <div className="repo-review-spotlight-list">
                              {manualPendingRuns.slice(0, 4).map((run) => (
                                <div
                                  key={run.id}
                                  className="repo-review-spotlight-item"
                                >
                                  <div className="repo-review-spotlight-main">
                                    <strong>{formatRunTitle(run)}</strong>
                                    <div className="repo-review-spotlight-meta">
                                      <span>
                                        {new Date(
                                          run.createdAt,
                                        ).toLocaleString()}
                                      </span>
                                      {run.branch ? (
                                        <span>{run.branch}</span>
                                      ) : null}
                                      {run.actor ? (
                                        <span>{run.actor}</span>
                                      ) : null}
                                    </div>
                                  </div>
                                  <div className="repo-review-inline-actions">
                                    <button
                                      type="button"
                                      className="btn-outline btn-sm repo-review-btn-compact"
                                      onClick={() => void openRunDetail(run)}
                                    >
                                      查看详情
                                    </button>
                                    <button
                                      className="btn-danger btn-sm repo-review-btn-compact"
                                      onClick={() =>
                                        void decideRunByHuman(run, 'fail')
                                      }
                                      disabled={manualDecisionRunId === run.id}
                                    >
                                      {manualDecisionRunId === run.id
                                        ? '处理中...'
                                        : '人工不通过'}
                                    </button>
                                    <button
                                      className="btn-primary btn-sm repo-review-btn-compact"
                                      onClick={() =>
                                        void decideRunByHuman(run, 'pass')
                                      }
                                      disabled={manualDecisionRunId === run.id}
                                    >
                                      {manualDecisionRunId === run.id
                                        ? '处理中...'
                                        : '人工通过'}
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </>
                    )}

                  {/* Tab: Profile */}
                  {!creatingRepository &&
                    selectedRepository &&
                    !repositoryEditorOpen &&
                    repoDetailTab === 'profile' && (
                      <RepoReviewProfileSection
                        selectedRepositoryId={selectedRepositoryId}
                        sectionOpen={profileSectionOpen || profileEditorOpen}
                        editorOpen={profileEditorOpen}
                        profileDraft={profileDraft}
                        setProfileDraft={setProfileDraft}
                        profiles={profilesForSelectedRepository}
                        autoCreatedProfileNotice={autoCreatedProfileNotice}
                        availableProfileBranches={availableProfileBranches}
                        filteredProfileBranches={filteredProfileBranches}
                        loadingRemoteBranches={loadingRemoteBranches}
                        savingProfile={savingProfile}
                        deletingProfile={deletingProfile}
                        activeBranchWindowDays={
                          REPO_REVIEW_ACTIVE_BRANCH_WINDOW_DAYS
                        }
                        onToggleSection={() =>
                          setProfileSectionOpen((current) => !current)
                        }
                        onOpenEditor={openProfileEditor}
                        onCloseEditor={closeProfileEditor}
                        onSelectProfile={(profile) =>
                          setProfileDraft(
                            makeProfileDraft(selectedRepositoryId, profile),
                          )
                        }
                        onRefreshBranches={() =>
                          void refreshRemoteBranches(true, false)
                        }
                        onToggleTargetBranch={toggleTargetBranch}
                        onSave={() => void saveProfile()}
                        onDelete={() => void deleteProfile()}
                      />
                    )}

                  {/* Tab: Runs */}
                  {!creatingRepository &&
                    !repositoryEditorOpen &&
                    repoDetailTab === 'runs' && (
                      <>
                        <div className="repo-review-card repo-review-runs-card repo-review-fold">
                          <button
                            type="button"
                            className="repo-review-fold-summary"
                            onClick={() =>
                              setRunsSectionOpen((current) => !current)
                            }
                            aria-expanded={runsSectionOpen}
                          >
                            <div className="repo-review-fold-copy">
                              <h4>{t('repoReview.runs.title')}</h4>
                              <div className="settings-hint">
                                {selectedRepository
                                  ? `当前仓库: ${selectedRepository.name}`
                                  : '全部仓库'}
                                {` · ${runsForDisplay.length} 条 · 已按最近活动时间倒序`}
                              </div>
                            </div>
                            <span
                              className={`repo-review-fold-icon ${runsSectionOpen ? 'open' : ''}`}
                            >
                              <IconChevronDown />
                            </span>
                          </button>
                          {runsSectionOpen ? (
                            <div className="repo-review-fold-body">
                              {lastSyncMessage ? (
                                <div className="settings-hint">
                                  {lastSyncMessage}
                                </div>
                              ) : null}
                              <div className="repo-review-runs-toolbar">
                                <div className="form-group">
                                  <label>{t('repoReview.runs.status')}</label>
                                  <AppSelect
                                    value={runFilterStatus}
                                    onChange={setRunFilterStatus}
                                    ariaLabel={t(
                                      'repoReview.runs.filterByStatus',
                                    )}
                                    options={[
                                      {
                                        value: '',
                                        label: t('repoReview.status.all'),
                                      },
                                      { value: 'pass', label: '通过' },
                                      { value: 'warn', label: '需关注' },
                                      { value: 'fail', label: '不通过' },
                                      { value: 'error', label: '执行失败' },
                                      { value: 'skipped', label: '已跳过' },
                                      { value: 'queued', label: '排队中' },
                                      {
                                        value: 'running',
                                        label: t('repoReview.status.running'),
                                      },
                                    ]}
                                  />
                                </div>
                                <div className="form-group repo-review-run-search">
                                  <label>{t('repoReview.runs.keyword')}</label>
                                  <div className="repo-review-search-shell">
                                    <input
                                      className="repo-review-search-input"
                                      value={runFilterText}
                                      onChange={(event) =>
                                        setRunFilterText(event.target.value)
                                      }
                                      placeholder={t(
                                        'repoReview.runs.searchPlaceholder',
                                      )}
                                    />
                                    {!runFilterText && (
                                      <span
                                        className="repo-review-search-icon"
                                        aria-hidden="true"
                                      >
                                        <IconSearch />
                                      </span>
                                    )}
                                    {runFilterText ? (
                                      <button
                                        type="button"
                                        className="repo-review-search-clear"
                                        onClick={() => setRunFilterText('')}
                                        aria-label={t(
                                          'repoReview.runs.clearSearch',
                                        )}
                                      >
                                        <IconX />
                                      </button>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                              {runsForDisplay.length === 0 ? (
                                <div className="settings-hint">
                                  还没有匹配的审查运行记录。
                                </div>
                              ) : (
                                <>
                                  <Pagination
                                    page={runsPage}
                                    pageSize={RUNS_PAGE_SIZE}
                                    total={runsForDisplay.length}
                                    onPageChange={setRunsPage}
                                  />
                                  <div className="repo-review-run-list">
                                    {pagedRunsForDisplay.map((run) => {
                                      const repositoryName =
                                        repositoryById.get(run.repositoryId)
                                          ?.name || run.repositoryId;
                                      const profileName =
                                        profileById.get(run.profileId)?.name ||
                                        t('repoReview.runs.unmatchedProfile');
                                      const canDecideByHuman =
                                        run.stage === 'push' &&
                                        run.passDecisionMode === 'human' &&
                                        !run.manualDecision &&
                                        run.status === 'completed' &&
                                        run.overall !== 'error' &&
                                        run.overall !== 'skipped';
                                      const isManualDecisionPending =
                                        manualDecisionRunId === run.id;
                                      const allProgressEntries =
                                        buildReviewProgressEntries(run);
                                      const progressEntries =
                                        filterReviewProgressEntriesForList(
                                          allProgressEntries,
                                        );
                                      const hasSummaryOnlyProgress =
                                        allProgressEntries.length > 0 &&
                                        progressEntries.length === 0;
                                      const diffWorkerStepCount =
                                        run.reviewProgress?.steps?.filter(
                                          (step) =>
                                            step.id.startsWith(
                                              'split_diff_worker_',
                                            ) ||
                                            step.id.startsWith(
                                              'agentic_subagent_',
                                            ),
                                        ).length || 0;
                                      const progressExpanded =
                                        expandedRunProgressIds.includes(
                                          run.id,
                                        ) || run.status === 'running';
                                      const durationMs = getRunDurationMs(run);
                                      const chatDeliveryStatus =
                                        resolveChatDeliveryStatus(run);
                                      const platformDeliveryStatus =
                                        resolvePlatformDeliveryStatus(run);
                                      const manualDecisionLabel =
                                        run.manualDecision === 'pass'
                                          ? '已人工通过'
                                          : run.manualDecision === 'fail'
                                            ? '已人工不通过'
                                            : run.stage === 'push' &&
                                                run.passDecisionMode ===
                                                  'human' &&
                                                run.status === 'completed' &&
                                                run.overall !== 'error' &&
                                                run.overall !== 'skipped'
                                              ? '待人工最终判定'
                                              : '';
                                      return (
                                        <div
                                          key={run.id}
                                          className={`repo-review-run-card status-${run.overall || run.status}`}
                                        >
                                          <div className="repo-review-run-header">
                                            <div className="repo-review-run-title-block">
                                              <strong>
                                                {formatRunTitle(run)}
                                              </strong>
                                              <div className="repo-review-run-meta">
                                                <span>
                                                  {new Date(
                                                    run.createdAt,
                                                  ).toLocaleString()}
                                                </span>
                                                <span>
                                                  {formatRunStageLabel(
                                                    run.stage,
                                                  )}
                                                </span>
                                                <span>
                                                  {formatRunSourceLabel(
                                                    run.source,
                                                  )}
                                                </span>
                                                <span>
                                                  {formatDurationMs(durationMs)}
                                                </span>
                                              </div>
                                            </div>
                                            <div className="repo-review-run-actions">
                                              <button
                                                type="button"
                                                className="btn-outline btn-sm repo-review-btn-compact"
                                                onClick={() =>
                                                  void openRunDetail(run)
                                                }
                                              >
                                                查看详情
                                              </button>
                                              {!isRunCancellable(run) ? (
                                                <button
                                                  type="button"
                                                  className="btn-outline btn-sm repo-review-btn-compact"
                                                  onClick={() =>
                                                    void rerunRun(run)
                                                  }
                                                  disabled={isRunRerunning(
                                                    run.id,
                                                  )}
                                                >
                                                  {isRunRerunning(run.id)
                                                    ? '再次运行中...'
                                                    : '再次运行'}
                                                </button>
                                              ) : null}
                                              {isRunCancellable(run) ? (
                                                <button
                                                  type="button"
                                                  className="btn-outline btn-sm repo-review-btn-compact"
                                                  onClick={() =>
                                                    void cancelRun(run)
                                                  }
                                                  disabled={isRunCancelling(
                                                    run.id,
                                                  )}
                                                >
                                                  {isRunCancelling(run.id)
                                                    ? '中止中...'
                                                    : '中止'}
                                                </button>
                                              ) : null}
                                            </div>
                                          </div>
                                          <div className="repo-review-run-meta">
                                            <span>{repositoryName}</span>
                                            <span>{profileName}</span>
                                            {run.branch ? (
                                              <span>{run.branch}</span>
                                            ) : null}
                                            {run.actor ? (
                                              <span>{run.actor}</span>
                                            ) : null}
                                          </div>
                                          <div className="repo-review-run-badges">
                                            <span
                                              className={`repo-review-status-badge status-${
                                                run.overall || run.status
                                              }`}
                                            >
                                              {formatResultStateLabel(run)}
                                            </span>
                                            <span
                                              className={`repo-review-source-pill tone-${getDeliveryTone(chatDeliveryStatus)}`}
                                            >
                                              通知{' '}
                                              {formatDeliveryStatusLabel(
                                                chatDeliveryStatus,
                                              )}
                                            </span>
                                            <span
                                              className={`repo-review-source-pill tone-${getDeliveryTone(platformDeliveryStatus)}`}
                                            >
                                              平台{' '}
                                              {formatDeliveryStatusLabel(
                                                platformDeliveryStatus,
                                              )}
                                            </span>
                                            {run.baselineSource ? (
                                              <span className="repo-review-source-pill tone-neutral">
                                                基线{' '}
                                                {formatBaselineSourceLabel(
                                                  run.baselineSource,
                                                )}
                                              </span>
                                            ) : null}
                                          </div>
                                          <div
                                            className="repo-review-run-summary"
                                            title={buildRepoReviewCompactSummary(
                                              run.summary,
                                              run.error || '无摘要',
                                            )}
                                          >
                                            {run.summary ||
                                              run.error ||
                                              t('repoReview.runs.noSummary')}
                                          </div>
                                          <div className="repo-review-run-meta">
                                            <span>
                                              {formatShortSha(run.baseSha)}{' '}
                                              {'->'}{' '}
                                              {formatShortSha(run.headSha)}
                                            </span>
                                            <span>
                                              {run.changedFiles.length} 个文件
                                            </span>
                                            <span>
                                              {run.commitReviews.length}{' '}
                                              个提交明细
                                            </span>
                                            <span>
                                              {run.findings.length} 个问题
                                            </span>
                                            {progressEntries.length > 0 ? (
                                              <span>
                                                {progressEntries.length}{' '}
                                                个分析步骤
                                              </span>
                                            ) : null}
                                            {run.recommendedBlock ? (
                                              <span>
                                                {t(
                                                  'repoReview.runs.aiRecommendBlock',
                                                )}
                                              </span>
                                            ) : null}
                                            {run.blockingEnforced ? (
                                              <span>
                                                {t('repoReview.status.blocked')}
                                              </span>
                                            ) : null}
                                          </div>
                                          {progressEntries.length > 0 ? (
                                            <div className="repo-review-run-progress">
                                              <button
                                                type="button"
                                                className="btn-outline btn-sm repo-review-btn-compact"
                                                onClick={() =>
                                                  toggleRunProgress(run.id)
                                                }
                                              >
                                                {progressExpanded
                                                  ? '收起分析过程'
                                                  : '查看分析过程'}
                                              </button>
                                              <span className="settings-hint">
                                                {run.status === 'running'
                                                  ? diffWorkerStepCount > 0
                                                    ? `AI 正在分析中，已分配 ${diffWorkerStepCount} 个子代理任务，面板会自动刷新。`
                                                    : hasSummaryOnlyProgress
                                                      ? 'AI 正在分析中，列表仅显示摘要视图，完整思考和工具调用请点“查看详情”。'
                                                      : 'AI 正在分析中，面板会自动刷新。'
                                                  : hasSummaryOnlyProgress
                                                    ? '列表仅显示摘要视图，完整思考和工具调用请点“查看详情”。'
                                                    : '这里会展示 AI 的思考摘要、工具调用链和完成状态。'}
                                              </span>
                                            </div>
                                          ) : hasSummaryOnlyProgress ? (
                                            <div className="repo-review-run-progress">
                                              <span className="settings-hint">
                                                列表仅显示摘要视图，完整思考和工具调用请点“查看详情”。
                                              </span>
                                            </div>
                                          ) : run.status === 'running' ? (
                                            <div className="repo-review-run-progress">
                                              <span className="settings-hint">
                                                AI
                                                已开始执行，等待首批分析事件...
                                              </span>
                                            </div>
                                          ) : null}
                                          {progressExpanded &&
                                          progressEntries.length > 0 ? (
                                            <ReviewProgressTimeline
                                              entries={progressEntries}
                                            />
                                          ) : null}
                                          {manualDecisionLabel ? (
                                            <div className="repo-review-run-meta">
                                              <span>{manualDecisionLabel}</span>
                                              {run.manualDecisionBy ? (
                                                <span>
                                                  判定人: {run.manualDecisionBy}
                                                </span>
                                              ) : null}
                                              {run.manualDecisionAt ? (
                                                <span>
                                                  判定时间:{' '}
                                                  {new Date(
                                                    run.manualDecisionAt,
                                                  ).toLocaleString()}
                                                </span>
                                              ) : null}
                                            </div>
                                          ) : null}
                                          {run.lastDeliveryError ? (
                                            <div className="repo-review-progress-error">
                                              投递异常: {run.lastDeliveryError}
                                            </div>
                                          ) : null}
                                          {run.findings.length > 0 ? (
                                            <div className="repo-review-run-findings">
                                              {run.findings
                                                .slice(0, 3)
                                                .map((finding, index) => (
                                                  <div
                                                    key={`${run.id}-${index}`}
                                                    className="settings-hint repo-review-preview-line"
                                                  >
                                                    [{finding.severity}]{' '}
                                                    {finding.file
                                                      ? `${finding.file}: `
                                                      : ''}
                                                    {finding.title}
                                                  </div>
                                                ))}
                                            </div>
                                          ) : null}
                                          {run.commitReviews.length > 0 ? (
                                            <div className="repo-review-run-findings">
                                              {run.commitReviews
                                                .slice(0, 3)
                                                .map((review) => (
                                                  <div
                                                    key={`${run.id}-${review.commit}-${review.title}`}
                                                    className="settings-hint repo-review-preview-line"
                                                  >
                                                    {review.commit ||
                                                      '(unknown)'}{' '}
                                                    {review.title}
                                                    {review.author
                                                      ? ` · ${review.author}`
                                                      : ''}
                                                    {review.issues[0]
                                                      ? ` · 问题: ${review.issues[0]}`
                                                      : review.positives[0]
                                                        ? ` · 优点: ${review.positives[0]}`
                                                        : ''}
                                                  </div>
                                                ))}
                                            </div>
                                          ) : run.commitDetails.length > 0 ? (
                                            <div className="repo-review-run-findings">
                                              {run.commitDetails
                                                .slice(0, 3)
                                                .map((commit) => (
                                                  <div
                                                    key={`${run.id}-${commit.commit}-${commit.title}`}
                                                    className="settings-hint repo-review-preview-line"
                                                  >
                                                    {commit.commit ||
                                                      '(unknown)'}{' '}
                                                    {commit.title}
                                                    {commit.author
                                                      ? ` · ${commit.author}`
                                                      : ''}
                                                  </div>
                                                ))}
                                            </div>
                                          ) : null}
                                          {canDecideByHuman ? (
                                            <div className="modal-actions">
                                              <button
                                                className="btn-danger btn-sm repo-review-btn-compact"
                                                onClick={() =>
                                                  void decideRunByHuman(
                                                    run,
                                                    'fail',
                                                  )
                                                }
                                                disabled={
                                                  isManualDecisionPending
                                                }
                                              >
                                                {isManualDecisionPending
                                                  ? '处理中...'
                                                  : '人工不通过'}
                                              </button>
                                              <button
                                                className="btn-primary btn-sm repo-review-btn-compact"
                                                onClick={() =>
                                                  void decideRunByHuman(
                                                    run,
                                                    'pass',
                                                  )
                                                }
                                                disabled={
                                                  isManualDecisionPending
                                                }
                                              >
                                                {isManualDecisionPending
                                                  ? '处理中...'
                                                  : '人工通过'}
                                              </button>
                                            </div>
                                          ) : null}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </>
                              )}
                            </div>
                          ) : null}
                        </div>

                        {selectedRepository ? (
                          <div className="repo-review-card repo-review-runs-card repo-review-fold">
                            <button
                              type="button"
                              className="repo-review-fold-summary"
                              onClick={() =>
                                setDigestRunsSectionOpen((current) => !current)
                              }
                              aria-expanded={digestRunsSectionOpen}
                            >
                              <div className="repo-review-fold-copy">
                                <h4>{t('repoReview.digestRuns.title')}</h4>
                                <div className="settings-hint">
                                  {selectedRepository.name}
                                  {` · ${digestRuns.length} 条 · 计划槽位与实际执行时间都可追踪`}
                                </div>
                              </div>
                              <span
                                className={`repo-review-fold-icon ${digestRunsSectionOpen ? 'open' : ''}`}
                              >
                                <IconChevronDown />
                              </span>
                            </button>
                            {digestRunsSectionOpen ? (
                              <div className="repo-review-fold-body">
                                <div className="repo-review-inline-actions">
                                  <button
                                    type="button"
                                    className="btn-outline btn-sm repo-review-btn-compact"
                                    onClick={() =>
                                      void refreshDigestRuns(false)
                                    }
                                    disabled={loadingDigestRuns}
                                  >
                                    {loadingDigestRuns
                                      ? t('repoReview.common.loading')
                                      : t('repoReview.button.refresh')}
                                  </button>
                                  <span className="settings-hint">
                                    digest 运行记录独立于普通审查
                                    run，包含计划执行时间、统计窗口和投递结果。
                                  </span>
                                </div>
                                {digestRuns.length === 0 ? (
                                  <div className="settings-hint">
                                    还没有日报或周报运行记录。
                                  </div>
                                ) : (
                                  <div className="repo-review-run-list">
                                    {digestRuns.map((run) => (
                                      <div
                                        key={run.id}
                                        className={`repo-review-run-card status-${run.status || 'completed'}`}
                                      >
                                        <div className="repo-review-run-header">
                                          <div className="repo-review-run-title-block">
                                            <strong>
                                              {formatDigestRunTypeLabel(
                                                run.type,
                                              )}
                                            </strong>
                                            <div className="repo-review-run-meta">
                                              <span>
                                                计划{' '}
                                                {new Date(
                                                  run.scheduledFor ||
                                                    run.createdAt,
                                                ).toLocaleString()}
                                              </span>
                                              <span>
                                                {formatDurationMs(
                                                  run.durationMs,
                                                )}
                                              </span>
                                              {run.timezone ? (
                                                <span>{run.timezone}</span>
                                              ) : null}
                                            </div>
                                          </div>
                                          <div className="repo-review-run-actions">
                                            <button
                                              type="button"
                                              className="btn-outline btn-sm repo-review-btn-compact"
                                              onClick={() =>
                                                void openDigestRunDetail(run)
                                              }
                                            >
                                              查看详情
                                            </button>
                                          </div>
                                        </div>
                                        <div className="repo-review-run-badges">
                                          <span
                                            className={`repo-review-status-badge status-${run.status || 'completed'}`}
                                          >
                                            {formatDigestRunStatusLabel(
                                              run.status,
                                            )}
                                          </span>
                                          <span
                                            className={`repo-review-source-pill tone-${getDeliveryTone(run.deliveryStatus)}`}
                                          >
                                            投递{' '}
                                            {formatDigestDeliveryStatusLabel(
                                              run.deliveryStatus,
                                            )}
                                          </span>
                                          <span className="repo-review-source-pill tone-neutral">
                                            窗口{' '}
                                            {new Date(
                                              run.periodStart,
                                            ).toLocaleString()}
                                            {' -> '}
                                            {new Date(
                                              run.periodEnd,
                                            ).toLocaleString()}
                                          </span>
                                        </div>
                                        <div
                                          className="repo-review-run-summary"
                                          title={buildRepoReviewCompactSummary(
                                            run.summary,
                                            run.deliveryError ||
                                              run.errorMessage ||
                                              '无摘要',
                                          )}
                                        >
                                          {run.summary ||
                                            run.deliveryError ||
                                            run.errorMessage ||
                                            '无摘要'}
                                        </div>
                                        <div className="repo-review-run-meta">
                                          <span>{run.branchCount} 个分支</span>
                                          <span>{run.commitCount} 个提交</span>
                                          <span>
                                            {run.contributorCount} 位贡献者
                                          </span>
                                          {run.startedAt ? (
                                            <span>
                                              开始{' '}
                                              {new Date(
                                                run.startedAt,
                                              ).toLocaleString()}
                                            </span>
                                          ) : null}
                                          {run.completedAt ? (
                                            <span>
                                              完成{' '}
                                              {new Date(
                                                run.completedAt,
                                              ).toLocaleString()}
                                            </span>
                                          ) : null}
                                        </div>
                                        {run.deliveryError ||
                                        run.errorMessage ? (
                                          <div className="repo-review-progress-error">
                                            {run.deliveryError ||
                                              run.errorMessage}
                                          </div>
                                        ) : null}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </>
                    )}

                  {/* Tab: CodeMap */}
                  {!creatingRepository &&
                    selectedRepository &&
                    !repositoryEditorOpen &&
                    repoDetailTab === 'project-graph' && (
                      <ProjectGraphPanel
                        apiBase={apiBase}
                        repositoryId={selectedRepository.id}
                        repositoryName={selectedRepository.name}
                      />
                    )}

                  {/* Tab: CodeMap */}
                  {!creatingRepository &&
                    selectedRepository &&
                    !repositoryEditorOpen &&
                    repoDetailTab === 'codemap' && (
                      <div className="repo-review-card">
                        <CodeMapDrawerEntry
                          apiBase={apiBase}
                          repositoryId={selectedRepository.id}
                          repositoryName={selectedRepository.name}
                          defaultBranch={
                            selectedRepository.defaultTargetBranch || 'main'
                          }
                          onOpen={(branch) => setInlineCodeMapBranch(branch)}
                        />
                      </div>
                    )}

                  {/* CodeMap fullscreen overlay — uses full CodeMapPage */}
                  {inlineCodeMapBranch && selectedRepository && (
                    <div className="codemap-fullscreen-overlay">
                      <CodeMapPage
                        apiBase={apiBase}
                        repositoryIdProp={selectedRepository.id}
                        branchProp={inlineCodeMapBranch}
                        repoNameProp={selectedRepository.name}
                        onClose={() => setInlineCodeMapBranch(null)}
                      />
                    </div>
                  )}

                  {/* Tab: Config / Repository Editor */}
                  {(repositoryEditorOpen ||
                    (!creatingRepository &&
                      selectedRepository &&
                      repoDetailTab === 'config')) && (
                    <>
                      {repositoryEditorOpen && (
                        <div className="repo-review-card repo-review-editor-stage">
                          <div className="repo-review-editor-stage-top">
                            <div className="repo-review-overview-copy">
                              <span className="repo-review-overview-kicker">
                                {reviewViewMode === 'repository'
                                  ? t('repoReview.editor.repositoryEditor')
                                  : t('repoReview.editor.profileEditor')}
                              </span>
                              <h3>
                                {reviewViewMode === 'repository'
                                  ? creatingRepository
                                    ? t(
                                        'repoReview.editor.createRepositoryConfig',
                                      )
                                    : t(
                                        'repoReview.editor.editRepositoryConfig',
                                      )
                                  : profileDraft.id
                                    ? t('repoReview.editor.editReviewProfile')
                                    : t(
                                        'repoReview.editor.createReviewProfile',
                                      )}
                              </h3>
                              <div className="settings-hint">
                                {reviewViewMode === 'repository'
                                  ? t('repoReview.editor.repoHint')
                                  : t('repoReview.editor.profileHint')}
                              </div>
                            </div>
                            <div className="repo-review-overview-actions">
                              <button
                                type="button"
                                className="btn-outline btn-sm"
                                onClick={() => {
                                  closeRepositoryEditor();
                                  closeProfileEditor();
                                  selectRepoDetailTab('overview');
                                }}
                              >
                                {t('repoReview.editor.backToOverview')}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                      <div className="repo-review-card repo-review-fold">
                        <button
                          type="button"
                          className="repo-review-fold-summary"
                          onClick={() =>
                            setRepositorySectionOpen((current) => !current)
                          }
                          aria-expanded={
                            reviewViewMode === 'repository' ||
                            repositorySectionOpen
                          }
                        >
                          <div className="repo-review-fold-copy">
                            <h4>
                              {creatingRepository
                                ? t('repoReview.editor.newRepoConfig')
                                : t('repoReview.editor.repoConfig')}
                            </h4>
                            <div className="settings-hint">
                              {!creatingRepository && selectedRepository
                                ? t('repoReview.editor.repoSummary', {
                                    provider: formatRemoteProviderLabel(
                                      selectedRepository.remoteProvider,
                                    ),
                                    count: profilesForSelectedRepository.length,
                                    status: selectedRepository.enabled
                                      ? t('repoReview.repoStatus.enabled')
                                      : t('repoReview.repoStatus.disabled'),
                                  })
                                : t('repoReview.editor.repoCreateHint')}
                            </div>
                          </div>
                          <span
                            className={`repo-review-fold-icon ${
                              reviewViewMode === 'repository' ||
                              repositorySectionOpen
                                ? 'open'
                                : ''
                            }`}
                          >
                            <IconChevronDown />
                          </span>
                        </button>
                        <div className="repo-review-fold-card-actions">
                          <button
                            type="button"
                            className="btn-primary btn-sm"
                            onClick={() =>
                              openRepositoryEditor(
                                creatingRepository || !selectedRepository,
                              )
                            }
                          >
                            {creatingRepository || !selectedRepository
                              ? t('repoReview.button.createRepo')
                              : t('repoReview.button.editRepo')}
                          </button>
                        </div>
                        {reviewViewMode === 'repository' ||
                        repositorySectionOpen ||
                        repositoryEditorOpen ? (
                          <>
                            <div className="repo-review-fold-body">
                              {creatingRepository && selectedRepository ? (
                                <div className="modal-actions">
                                  <button
                                    className="btn-outline btn-sm"
                                    onClick={() => setCreatingRepository(false)}
                                  >
                                    {t(
                                      'repoReview.editor.backToCurrentRepository',
                                    )}
                                  </button>
                                </div>
                              ) : null}

                              {!creatingRepository && selectedRepository ? (
                                <div className="repo-review-summary-grid">
                                  <div className="repo-review-summary-item">
                                    <span className="repo-review-summary-label">
                                      {t('repoReview.summary.remoteRepository')}
                                    </span>
                                    <strong className="repo-review-summary-value">
                                      {formatRemoteProviderLabel(
                                        selectedRepository.remoteProvider,
                                      )}
                                      {selectedRepository.remoteRepoSlug
                                        ? ` · ${selectedRepository.remoteRepoSlug}`
                                        : ''}
                                    </strong>
                                  </div>
                                  <div className="repo-review-summary-item">
                                    <span className="repo-review-summary-label">
                                      {t('repoReview.summary.reviewChat')}
                                    </span>
                                    <strong className="repo-review-summary-value">
                                      {formatReviewChatTarget(
                                        selectedRepository.reviewChatJid,
                                        conversations,
                                      )}
                                    </strong>
                                  </div>
                                  <div className="repo-review-summary-item">
                                    <span className="repo-review-summary-label">
                                      {t('repoReview.summary.feishuMappings')}
                                    </span>
                                    <strong className="repo-review-summary-value">
                                      {t('repoReview.summary.entryCount', {
                                        count:
                                          selectedRepository
                                            .actorMentionMappings.length,
                                      })}
                                    </strong>
                                  </div>
                                  <div className="repo-review-summary-item">
                                    <span className="repo-review-summary-label">
                                      {t('repoReview.summary.reviewProfile')}
                                    </span>
                                    <strong className="repo-review-summary-value">
                                      {t('repoReview.summary.configuredCount', {
                                        count:
                                          profilesForSelectedRepository.length,
                                      })}
                                    </strong>
                                  </div>
                                  <div className="repo-review-summary-item">
                                    <span className="repo-review-summary-label">
                                      {t('repoReview.summary.credentialStatus')}
                                    </span>
                                    <strong className="repo-review-summary-value">
                                      {selectedRepository.hasWebhookSecret
                                        ? t(
                                            'repoReview.summary.webhookConfigured',
                                          )
                                        : t(
                                            'repoReview.summary.webhookNotConfigured',
                                          )}
                                      {selectedRepository.webhookSecretPreview
                                        ? ` (${selectedRepository.webhookSecretPreview})`
                                        : ''}
                                      {' · '}
                                      {selectedRepository.hasPlatformToken
                                        ? t(
                                            'repoReview.summary.tokenConfigured',
                                          )
                                        : t(
                                            'repoReview.summary.tokenNotConfigured',
                                          )}
                                      {selectedRepository.platformTokenPreview
                                        ? ` (${selectedRepository.platformTokenPreview})`
                                        : ''}
                                    </strong>
                                  </div>
                                  <div className="repo-review-summary-item">
                                    <span className="repo-review-summary-label">
                                      {t('repoReview.summary.autoSync')}
                                    </span>
                                    <strong className="repo-review-summary-value">
                                      {selectedRepository.autoSyncEnabled
                                        ? t(
                                            'repoReview.summary.autoSyncEnabled',
                                            {
                                              minutes:
                                                selectedRepository.autoSyncIntervalMinutes,
                                            },
                                          )
                                        : t('repoReview.repoStatus.disabled')}
                                    </strong>
                                  </div>
                                  {selectedRepository.webhookUrl &&
                                  selectedRepository.remoteProvider ? (
                                    <div className="repo-review-summary-item">
                                      <span className="repo-review-summary-label">
                                        {t(
                                          'repoReview.summary.webhookCallbackUrl',
                                        )}
                                      </span>
                                      <strong className="repo-review-summary-value repo-review-webhook-url-row">
                                        <code className="repo-review-webhook-url">
                                          {selectedRepository.webhookUrl}
                                        </code>
                                        <button
                                          type="button"
                                          className="btn-outline btn-sm"
                                          onClick={() => {
                                            const text =
                                              selectedRepository.webhookUrl!;
                                            if (
                                              navigator.clipboard &&
                                              window.isSecureContext
                                            ) {
                                              void navigator.clipboard.writeText(
                                                text,
                                              );
                                            } else {
                                              const ta =
                                                document.createElement(
                                                  'textarea',
                                                );
                                              ta.value = text;
                                              ta.style.position = 'fixed';
                                              ta.style.left = '-9999px';
                                              document.body.appendChild(ta);
                                              ta.select();
                                              document.execCommand('copy');
                                              document.body.removeChild(ta);
                                            }
                                            setMessage(
                                              i18n.t(
                                                'repoReview.success.webhookCopied',
                                              ),
                                            );
                                          }}
                                        >
                                          Copy
                                        </button>
                                      </strong>
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}

                              <div className="repo-review-form-grid">
                                <div className="form-group">
                                  <label>{t('repoReview.form.name')}</label>
                                  <input
                                    value={repositoryDraft.name}
                                    onChange={(event) =>
                                      setRepositoryDraft((current) => ({
                                        ...current,
                                        name: event.target.value,
                                      }))
                                    }
                                    placeholder="e.g. miniRpc"
                                  />
                                </div>
                                <div className="form-group">
                                  <label>{t('repoReview.form.language')}</label>
                                  <AppSelect
                                    value={repositoryDraft.language}
                                    onChange={(value) =>
                                      setRepositoryDraft((current) => ({
                                        ...current,
                                        language: value,
                                      }))
                                    }
                                    ariaLabel={t(
                                      'repoReview.form.selectLanguage',
                                    )}
                                    options={COMMON_LANGUAGES.map(
                                      (language) => ({
                                        value: language,
                                        label: language,
                                      }),
                                    )}
                                  />
                                </div>
                                <div
                                  ref={setRepositoryEditorSectionRef(
                                    'delivery',
                                  )}
                                  className={`form-group repo-review-chat-target-field ${
                                    repositoryEditorSection === 'delivery'
                                      ? 'repo-review-focus-target'
                                      : ''
                                  }`}
                                >
                                  <label>
                                    {t('repoReview.form.reviewChat')}
                                  </label>
                                  <div className="repo-review-chat-target-summary">
                                    <strong>
                                      {formatReviewChatTarget(
                                        effectiveReviewChatJid,
                                        conversations,
                                      )}
                                    </strong>
                                    <span>
                                      {reviewChatValue ===
                                      AUTO_REVIEW_CHAT_VALUE
                                        ? t('repoReview.form.autoChatSession')
                                        : isFeishuReviewChat
                                          ? t(
                                              'repoReview.form.feishuChatSession',
                                            )
                                          : t(
                                              'repoReview.form.nonFeishuChatSession',
                                            )}
                                    </span>
                                  </div>
                                  <AppSelect
                                    value={reviewChatValue}
                                    onChange={(value) =>
                                      setRepositoryDraft((current) => ({
                                        ...current,
                                        reviewChatJid:
                                          value === AUTO_REVIEW_CHAT_VALUE ||
                                          value === CUSTOM_REVIEW_CHAT_VALUE
                                            ? ''
                                            : value,
                                      }))
                                    }
                                    ariaLabel={t(
                                      'repoReview.form.selectChatSession',
                                    )}
                                    options={conversationOptions}
                                  />
                                  <div className="settings-hint">
                                    Choose the session that should actually
                                    receive review results. Feishu member
                                    binding and @ mappings only appear when a
                                    Feishu chat is selected.
                                  </div>
                                  {reviewChatValue ===
                                  CUSTOM_REVIEW_CHAT_VALUE ? (
                                    <>
                                      <input
                                        type="text"
                                        value={customReviewChatJidInput}
                                        onChange={(event) =>
                                          setCustomReviewChatJidInput(
                                            event.target.value,
                                          )
                                        }
                                        placeholder="feishu:oc_xxx / feishu:instanceId:oc_xxx / web:chat_xxx"
                                      />
                                      <div className="settings-hint">
                                        If the target chat is not listed yet,
                                        enter the full JID manually. For Feishu
                                        with only the default or a single
                                        instance, `oc_xxx` also works directly.
                                      </div>
                                    </>
                                  ) : null}
                                </div>
                                <div
                                  ref={setRepositoryEditorSectionRef('source')}
                                  className={`form-group repo-review-path-field ${
                                    repositoryEditorSection === 'source'
                                      ? 'repo-review-focus-target'
                                      : ''
                                  }`}
                                >
                                  <label>{t('repoReview.form.cloneUrl')}</label>
                                  <div className="repo-review-inline-actions">
                                    <input
                                      value={repositoryDraft.cloneUrl}
                                      onChange={(event) => {
                                        setRepositoryDraft((current) => ({
                                          ...current,
                                          cloneUrl: event.target.value,
                                        }));
                                        setSelectedDetectedRemoteName('');
                                      }}
                                      onBlur={() => {
                                        const url =
                                          repositoryDraft.cloneUrl.trim();
                                        if (
                                          url &&
                                          /^(https?:\/\/|git@|ssh:\/\/)/.test(
                                            url,
                                          )
                                        ) {
                                          void discoverRepositoryConfig();
                                        }
                                      }}
                                      placeholder={t(
                                        'repoReview.form.cloneUrlPlaceholder',
                                      )}
                                    />
                                    <button
                                      className="btn-outline btn-sm"
                                      onClick={() =>
                                        void discoverRepositoryConfig()
                                      }
                                      disabled={discoveringRepository}
                                    >
                                      {discoveringRepository
                                        ? t('repoReview.button.discovering')
                                        : t('repoReview.button.importFromLink')}
                                    </button>
                                  </div>
                                  <div className="settings-hint">
                                    Supports SSH clone URLs, HTTPS clone URLs,
                                    or direct repository page links. The
                                    provider, slug, and base URL are
                                    auto-detected after paste.
                                  </div>
                                </div>

                                <div
                                  ref={setRepositoryEditorSectionRef(
                                    'autosync',
                                  )}
                                  className={`form-group ${
                                    repositoryEditorSection === 'autosync'
                                      ? 'repo-review-focus-target'
                                      : ''
                                  }`}
                                >
                                  <label>
                                    {t('repoReview.form.remotePlatform')}
                                  </label>
                                  <AppSelect
                                    value={repositoryDraft.remoteProvider}
                                    onChange={(value) =>
                                      setRepositoryDraft((current) => ({
                                        ...current,
                                        remoteProvider:
                                          value as RepositoryDraft['remoteProvider'],
                                      }))
                                    }
                                    ariaLabel={t(
                                      'repoReview.form.selectPlatform',
                                    )}
                                    options={[
                                      {
                                        value: '',
                                        label: t(
                                          'repoReview.remoteProvider.local',
                                        ),
                                      },
                                      { value: 'github', label: 'GitHub' },
                                      { value: 'gitlab', label: 'GitLab' },
                                      { value: 'gitea', label: 'Gitea' },
                                    ]}
                                  />
                                  <div className="settings-hint">
                                    Auto-filled after pasting a repository link,
                                    or choose manually.
                                  </div>
                                </div>

                                <div
                                  ref={setRepositoryEditorSectionRef(
                                    'credentials',
                                  )}
                                  className={`form-group ${
                                    repositoryEditorSection === 'credentials'
                                      ? 'repo-review-focus-target'
                                      : ''
                                  }`}
                                >
                                  <label>
                                    {getRemoteRepoSlugLabel(
                                      repositoryDraft.remoteProvider,
                                    )}
                                  </label>
                                  <input
                                    value={repositoryDraft.remoteRepoSlug}
                                    onChange={(event) =>
                                      setRepositoryDraft((current) => ({
                                        ...current,
                                        remoteRepoSlug: event.target.value,
                                      }))
                                    }
                                    placeholder={getRemoteRepoSlugPlaceholder(
                                      repositoryDraft.remoteProvider,
                                    )}
                                  />
                                  <div className="settings-hint">
                                    This is the repository identifier used by
                                    the platform API, not the full URL.
                                  </div>
                                </div>

                                <div className="form-group">
                                  <label>
                                    {t('repoReview.form.remoteBaseUrl')}
                                  </label>
                                  <input
                                    value={repositoryDraft.remoteBaseUrl}
                                    onChange={(event) =>
                                      setRepositoryDraft((current) => ({
                                        ...current,
                                        remoteBaseUrl: event.target.value,
                                      }))
                                    }
                                    placeholder={t(
                                      'repoReview.form.remoteBaseUrlPlaceholder',
                                    )}
                                  />
                                  <div className="settings-hint">
                                    {getRemoteBaseUrlHint(
                                      repositoryDraft.remoteProvider,
                                    )}
                                  </div>
                                </div>

                                <details className="repo-review-advanced-section">
                                  <summary className="repo-review-advanced-summary">
                                    Advanced: Local Repository (Optional)
                                  </summary>
                                  <div className="form-group repo-review-path-field repo-review-path-field--stack">
                                    <div className="repo-review-inline-actions">
                                      <input
                                        value={repositoryDraft.localRepoPath}
                                        onChange={(event) => {
                                          setRepositoryDraft((current) => ({
                                            ...current,
                                            localRepoPath: event.target.value,
                                          }));
                                          setSelectedDetectedRemoteName('');
                                        }}
                                        placeholder="/Users/you/projects/repo"
                                      />
                                      <button
                                        className="btn-outline btn-sm"
                                        onClick={async () => {
                                          const picked =
                                            await pickNativeDirectory();
                                          if (!picked) return;
                                          setRepositoryDraft((current) => ({
                                            ...current,
                                            localRepoPath: picked,
                                          }));
                                          setSelectedDetectedRemoteName('');
                                          setRepositoryDetectionWarnings([]);
                                        }}
                                      >
                                        Choose
                                      </button>
                                      <button
                                        className="btn-outline btn-sm"
                                        onClick={() =>
                                          void discoverRepositoryConfig()
                                        }
                                        disabled={discoveringRepository}
                                      >
                                        {discoveringRepository
                                          ? 'Detecting...'
                                          : 'Import from Local Repository'}
                                      </button>
                                    </div>
                                    <div className="settings-hint">
                                      Optional. After binding a local git
                                      repository, NanoClaw can autofill remote
                                      settings from `git remote` and support
                                      local diff reviews.
                                    </div>
                                    {lastRepositoryDetection?.source ===
                                      'local_repo' &&
                                    lastRepositoryDetection.availableRemotes
                                      .length > 1 ? (
                                      <>
                                        <div className="repo-review-remote-picker-block">
                                          <label>
                                            {t(
                                              'repoReview.form.multipleRemotes',
                                            )}
                                          </label>
                                          <AppSelect
                                            value={
                                              selectedDetectedRemoteName ||
                                              lastRepositoryDetection.detectedRemoteName
                                            }
                                            onChange={(value) => {
                                              setSelectedDetectedRemoteName(
                                                value,
                                              );
                                              void discoverRepositoryConfig(
                                                value,
                                              );
                                            }}
                                            ariaLabel={t(
                                              'repoReview.form.selectGitRemote',
                                            )}
                                            options={lastRepositoryDetection.availableRemotes.map(
                                              (option) => ({
                                                value: option.remoteName,
                                                label:
                                                  formatRemoteOptionLabel(
                                                    option,
                                                  ),
                                              }),
                                            )}
                                          />
                                        </div>
                                        <div className="settings-hint">
                                          Multiple remotes were detected. Choose
                                          the one used for webhook and remote
                                          polling to avoid guessing the wrong
                                          default.
                                        </div>
                                      </>
                                    ) : null}
                                  </div>
                                </details>
                                {lastRepositoryDetection ? (
                                  <div className="form-group repo-review-textarea">
                                    <label>
                                      {t('repoReview.form.detectedConfig')}
                                    </label>
                                    <div className="repo-review-detection-summary">
                                      <div>
                                        <strong>
                                          {t('repoReview.form.source')}
                                        </strong>
                                        <span>
                                          {lastRepositoryDetection.source ===
                                          'local_repo'
                                            ? lastRepositoryDetection.detectedRemoteName
                                              ? `Local remote ${lastRepositoryDetection.detectedRemoteName}`
                                              : 'Local repository'
                                            : 'Repository link'}
                                        </span>
                                      </div>
                                      <div>
                                        <strong>
                                          {t('repoReview.runDetail.platform')}
                                        </strong>
                                        <span>
                                          {lastRepositoryDetection.provider ||
                                            t('repoReview.form.unrecognized')}
                                        </span>
                                      </div>
                                      <div>
                                        <strong>Repo</strong>
                                        <span>
                                          {lastRepositoryDetection.remoteRepoSlug ||
                                            'Not detected'}
                                        </span>
                                      </div>
                                      <div>
                                        <strong>Base URL</strong>
                                        <span>
                                          {lastRepositoryDetection.remoteBaseUrl ||
                                            t('repoReview.form.useDefault')}
                                        </span>
                                      </div>
                                      <div>
                                        <strong>Clone URL</strong>
                                        <span>
                                          {lastRepositoryDetection.cloneUrl ||
                                            'Not detected'}
                                        </span>
                                      </div>
                                      <div>
                                        <strong>
                                          {t('repoReview.form.defaultBranch')}
                                        </strong>
                                        <span>
                                          {lastRepositoryDetection.defaultTargetBranch ||
                                            'Not detected'}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                ) : null}
                                <div className="form-group">
                                  <label>
                                    {t('repoReview.form.defaultTargetBranch')}
                                  </label>
                                  <input
                                    value={repositoryDraft.defaultTargetBranch}
                                    onChange={(event) =>
                                      setRepositoryDraft((current) => ({
                                        ...current,
                                        defaultTargetBranch: event.target.value,
                                      }))
                                    }
                                    placeholder="main"
                                  />
                                  <div className="settings-hint">
                                    {t('repoReview.form.defaultBaselineHint')}
                                  </div>
                                </div>
                                <div className="form-group">
                                  <label>
                                    {t(
                                      'repoReview.form.autoSyncRemoteBranches',
                                    )}
                                  </label>
                                  <div className="settings-boolean-row">
                                    <div className="settings-boolean-copy">
                                      <span>
                                        {t('repoReview.form.enableAutoSync')}
                                      </span>
                                    </div>
                                    <div className="channel-boolean-control">
                                      <NcToggle
                                        checked={
                                          repositoryDraft.autoSyncEnabled
                                        }
                                        onChange={(checked) =>
                                          setRepositoryDraft((current) => ({
                                            ...current,
                                            autoSyncEnabled: checked,
                                          }))
                                        }
                                      />
                                    </div>
                                  </div>
                                  <div className="settings-hint">
                                    {t('repoReview.form.autoSyncHint')}
                                  </div>
                                </div>
                                <div className="form-group">
                                  <label>
                                    {t('repoReview.form.autoSyncInterval')}
                                  </label>
                                  <input
                                    className="nc-input"
                                    type="number"
                                    min={5}
                                    max={1440}
                                    value={
                                      repositoryDraft.autoSyncIntervalMinutes
                                    }
                                    onChange={(event) =>
                                      setRepositoryDraft((current) => ({
                                        ...current,
                                        autoSyncIntervalMinutes: Number(
                                          event.target.value || 30,
                                        ),
                                      }))
                                    }
                                    disabled={!repositoryDraft.autoSyncEnabled}
                                  />
                                  <div className="settings-hint">
                                    {t('repoReview.form.autoSyncIntervalHint')}
                                  </div>
                                </div>

                                <div className="form-group">
                                  <label>{t('repoReview.form.digest')}</label>
                                  <div className="settings-boolean-row">
                                    <div className="settings-boolean-copy">
                                      <span>
                                        {t('repoReview.form.enableDailyDigest')}
                                      </span>
                                    </div>
                                    <div className="channel-boolean-control">
                                      <NcToggle
                                        checked={
                                          repositoryDraft.digestDailyEnabled
                                        }
                                        onChange={(checked) =>
                                          setRepositoryDraft((current) => ({
                                            ...current,
                                            digestDailyEnabled: checked,
                                          }))
                                        }
                                      />
                                    </div>
                                  </div>
                                  {repositoryDraft.digestDailyEnabled ? (
                                    <div className="settings-sub-row">
                                      <label className="settings-inline-label">
                                        {t('repoReview.form.deliveryHour')}
                                      </label>
                                      <input
                                        className="nc-input nc-input-sm"
                                        type="number"
                                        min={0}
                                        max={23}
                                        value={repositoryDraft.digestDailyHour}
                                        onChange={(event) =>
                                          setRepositoryDraft((current) => ({
                                            ...current,
                                            digestDailyHour: Number(
                                              event.target.value || 18,
                                            ),
                                          }))
                                        }
                                      />
                                    </div>
                                  ) : null}
                                  <div className="settings-boolean-row">
                                    <div className="settings-boolean-copy">
                                      <span>
                                        {t(
                                          'repoReview.form.enableWeeklyDigest',
                                        )}
                                      </span>
                                    </div>
                                    <div className="channel-boolean-control">
                                      <NcToggle
                                        checked={
                                          repositoryDraft.digestWeeklyEnabled
                                        }
                                        onChange={(checked) =>
                                          setRepositoryDraft((current) => ({
                                            ...current,
                                            digestWeeklyEnabled: checked,
                                          }))
                                        }
                                      />
                                    </div>
                                  </div>
                                  {repositoryDraft.digestWeeklyEnabled ? (
                                    <>
                                      <div className="settings-sub-row">
                                        <label className="settings-inline-label">
                                          {t('repoReview.form.weekday')}
                                        </label>
                                        <NcSelect
                                          className="repo-review-digest-weekday-select"
                                          value={
                                            repositoryDraft.digestWeeklyDay
                                          }
                                          onChange={(event) =>
                                            setRepositoryDraft((current) => ({
                                              ...current,
                                              digestWeeklyDay: Number(
                                                event.target.value || 5,
                                              ),
                                            }))
                                          }
                                        >
                                          <option value={1}>
                                            {t('repoReview.weekday.mon')}
                                          </option>
                                          <option value={2}>
                                            {t('repoReview.weekday.tue')}
                                          </option>
                                          <option value={3}>
                                            {t('repoReview.weekday.wed')}
                                          </option>
                                          <option value={4}>
                                            {t('repoReview.weekday.thu')}
                                          </option>
                                          <option value={5}>
                                            {t('repoReview.weekday.fri')}
                                          </option>
                                          <option value={6}>
                                            {t('repoReview.weekday.sat')}
                                          </option>
                                          <option value={7}>
                                            {t('repoReview.weekday.sun')}
                                          </option>
                                        </NcSelect>
                                      </div>
                                      <div className="settings-sub-row">
                                        <label className="settings-inline-label">
                                          {t('repoReview.form.deliveryHour')}
                                        </label>
                                        <input
                                          className="nc-input nc-input-sm"
                                          type="number"
                                          min={0}
                                          max={23}
                                          value={
                                            repositoryDraft.digestWeeklyHour
                                          }
                                          onChange={(event) =>
                                            setRepositoryDraft((current) => ({
                                              ...current,
                                              digestWeeklyHour: Number(
                                                event.target.value || 18,
                                              ),
                                            }))
                                          }
                                        />
                                      </div>
                                    </>
                                  ) : null}
                                  <div className="settings-hint">
                                    {t('repoReview.form.digestHint')}
                                  </div>
                                </div>
                                {repositoryDetectionWarnings.length > 0 ? (
                                  <div className="form-group repo-review-textarea">
                                    <label>
                                      {t('repoReview.form.detectionWarnings')}
                                    </label>
                                    <div className="repo-review-issues">
                                      {repositoryDetectionWarnings.map(
                                        (warning, index) => (
                                          <div
                                            key={`${index}-${warning}`}
                                            className="repo-review-issue repo-review-issue-warning"
                                          >
                                            {warning}
                                          </div>
                                        ),
                                      )}
                                    </div>
                                  </div>
                                ) : null}
                                {contributorsLoading ? (
                                  <div className="settings-hint repo-review-hint-muted">
                                    {t('repoReview.form.contributorsLoading')}
                                  </div>
                                ) : discoveredContributors.length > 0 ? (
                                  <div className="settings-hint">
                                    {t(
                                      'repoReview.form.contributorsDiscovered',
                                      {
                                        count: discoveredContributors.length,
                                      },
                                    )}
                                  </div>
                                ) : null}
                                <RepoReviewActorMentionEditor
                                  isFeishuReviewChat={isFeishuReviewChat}
                                  pauseOverviewRefresh={pauseOverviewRefresh}
                                  selectedMentionMemberId={
                                    selectedMentionMemberId
                                  }
                                  setSelectedMentionMemberId={
                                    setSelectedMentionMemberId
                                  }
                                  reviewChatMemberOptions={
                                    reviewChatMemberOptions
                                  }
                                  loadingReviewChatMembers={
                                    loadingReviewChatMembers
                                  }
                                  availableReviewChatMembers={
                                    availableReviewChatMembers
                                  }
                                  selectedMentionMember={selectedMentionMember}
                                  reviewIdentityCandidates={
                                    reviewIdentityCandidates
                                  }
                                  reviewChatMemberSourceStats={
                                    reviewChatMemberSourceStats
                                  }
                                  reviewChatMembersError={
                                    reviewChatMembersError
                                  }
                                  actorMentionDraftRows={
                                    repositoryDraft.actorMentionDraftRows
                                  }
                                  actorMentionMappingsText={
                                    repositoryDraft.actorMentionMappingsText
                                  }
                                  actorMentionIssues={
                                    actorMentionMappingsState.issues
                                  }
                                  actorMentionEntryCount={
                                    actorMentionMappingsState.entries.length
                                  }
                                  advancedMappingsOpen={advancedMappingsOpen}
                                  setAdvancedMappingsOpen={
                                    setAdvancedMappingsOpen
                                  }
                                  onRefreshMembers={() =>
                                    void refreshReviewChatMembers(
                                      effectiveReviewChatJid,
                                      false,
                                    )
                                  }
                                  onAppendMentionDraftRow={() =>
                                    appendMentionDraftRow()
                                  }
                                  onApplyIdentityCandidate={
                                    applyIdentityCandidate
                                  }
                                  onUpdateMentionDraftRow={
                                    updateMentionDraftRow
                                  }
                                  onRemoveMentionDraftRow={
                                    removeMentionDraftRow
                                  }
                                  onActorMentionMappingsTextChange={(value) =>
                                    setRepositoryDraft((current) => ({
                                      ...current,
                                      actorMentionMappingsText: value,
                                    }))
                                  }
                                />
                                <div className="form-group">
                                  <label>
                                    {getWebhookSecretLabel(
                                      repositoryDraft.remoteProvider,
                                    )}
                                  </label>
                                  <input
                                    type="password"
                                    value={repositoryDraft.webhookSecret}
                                    onChange={(event) =>
                                      setRepositoryDraft((current) => ({
                                        ...current,
                                        webhookSecret: event.target.value,
                                      }))
                                    }
                                    placeholder={
                                      selectedRepository?.hasWebhookSecret
                                        ? t(
                                            'repoReview.form.webhookSecretKeepPlaceholder',
                                          )
                                        : t(
                                            'repoReview.form.webhookSecretPlaceholder',
                                          )
                                    }
                                  />
                                  <div className="settings-hint">
                                    {selectedRepository?.hasWebhookSecret
                                      ? t('repoReview.form.secretKeepHint')
                                      : t(
                                          'repoReview.form.secretNotConfigured',
                                        )}
                                  </div>
                                  {currentWebhookSecretPreview ? (
                                    <div className="settings-hint">
                                      {t('repoReview.form.currentPreview', {
                                        value: currentWebhookSecretPreview,
                                      })}
                                    </div>
                                  ) : null}
                                  <div className="settings-hint">
                                    {getWebhookSecretHint(
                                      repositoryDraft.remoteProvider,
                                    )}
                                  </div>
                                </div>
                                {sshKeys.length > 0 && (
                                  <div className="form-group">
                                    <label>{t('repoReview.form.sshKey')}</label>
                                    <select
                                      value={repositoryDraft.sshKeyId}
                                      onChange={(e) =>
                                        setRepositoryDraft((c) => ({
                                          ...c,
                                          sshKeyId: e.target.value,
                                        }))
                                      }
                                    >
                                      <option value="">
                                        {t('repoReview.form.defaultSshKey')}
                                      </option>
                                      {sshKeys.map((k) => (
                                        <option key={k.id} value={k.id}>
                                          {k.name}
                                          {k.fingerprint
                                            ? ` (${k.fingerprint.slice(0, 20)}…)`
                                            : ''}
                                          {k.isDefault ? ' ★' : ''}
                                        </option>
                                      ))}
                                    </select>
                                    <div className="settings-hint">
                                      {t('repoReview.form.sshKeyHint')}
                                    </div>
                                  </div>
                                )}
                                <div className="form-group">
                                  <label>
                                    {getPlatformTokenLabel(
                                      repositoryDraft.remoteProvider,
                                    )}
                                  </label>
                                  <input
                                    type="password"
                                    value={repositoryDraft.platformToken}
                                    onChange={(event) =>
                                      setRepositoryDraft((current) => ({
                                        ...current,
                                        platformToken: event.target.value,
                                      }))
                                    }
                                    placeholder={
                                      selectedRepository?.hasPlatformToken
                                        ? t(
                                            'repoReview.form.platformTokenKeepPlaceholder',
                                          )
                                        : t(
                                            'repoReview.form.platformTokenPlaceholder',
                                          )
                                    }
                                  />
                                  <div className="settings-hint">
                                    {selectedRepository?.hasPlatformToken
                                      ? t(
                                          'repoReview.form.platformTokenKeepHint',
                                        )
                                      : t(
                                          'repoReview.form.platformTokenNotConfigured',
                                        )}
                                  </div>
                                  {currentPlatformTokenPreview ? (
                                    <div className="settings-hint">
                                      {t('repoReview.form.currentPreview', {
                                        value: currentPlatformTokenPreview,
                                      })}
                                    </div>
                                  ) : null}
                                  <div className="settings-hint">
                                    {getPlatformTokenHint(
                                      repositoryDraft.remoteProvider,
                                    )}
                                  </div>
                                </div>
                                {repositoryDraft.remoteProvider === 'gitlab' ? (
                                  <div className="form-group repo-review-textarea">
                                    <label>
                                      {t('repoReview.form.gitlabTokenGuide')}
                                    </label>
                                    <div className="repo-review-token-guide">
                                      <div>
                                        <strong>
                                          {t(
                                            'repoReview.form.gitlabWebhookTokenTitle',
                                          )}
                                        </strong>
                                        <span>
                                          {t(
                                            'repoReview.form.gitlabWebhookTokenHint',
                                          )}
                                        </span>
                                      </div>
                                      <div>
                                        <strong>
                                          {t(
                                            'repoReview.form.gitlabAccessTokenTitle',
                                          )}
                                        </strong>
                                        <span>
                                          {t(
                                            'repoReview.form.gitlabAccessTokenHint',
                                          )}
                                        </span>
                                      </div>
                                      <div>
                                        <strong>
                                          {t(
                                            'repoReview.form.gitlabPipelineTriggerTitle',
                                          )}
                                        </strong>
                                        <span>
                                          {t(
                                            'repoReview.form.gitlabPipelineTriggerHint',
                                          )}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                ) : null}
                              </div>

                              <div className="form-group">
                                <label>{t('repoReview.form.allowAiFix')}</label>
                                <div className="settings-boolean-row">
                                  <div className="settings-boolean-copy">
                                    <span>
                                      {t('repoReview.form.allowAiFixHint')}
                                    </span>
                                  </div>
                                  <div className="channel-boolean-control">
                                    <NcToggle
                                      checked={repositoryDraft.allowAiFix}
                                      onChange={(checked) =>
                                        setRepositoryDraft((current) => ({
                                          ...current,
                                          allowAiFix: checked,
                                        }))
                                      }
                                    />
                                  </div>
                                </div>
                              </div>

                              <label className="settings-toggle-row">
                                <input
                                  type="checkbox"
                                  checked={repositoryDraft.enabled}
                                  onChange={(event) =>
                                    setRepositoryDraft((current) => ({
                                      ...current,
                                      enabled: event.target.checked,
                                    }))
                                  }
                                />
                                <span>
                                  {t('repoReview.form.enableRepoConfig')}
                                </span>
                              </label>

                              <div className="modal-actions">
                                <button
                                  className="btn-primary"
                                  onClick={() => void saveRepository()}
                                  disabled={
                                    repositoryHasMappingErrors ||
                                    savingRepository
                                  }
                                >
                                  {savingRepository
                                    ? t('repoReview.button.saving')
                                    : t('repoReview.button.save')}
                                </button>
                                {repositoryDraft.id ? (
                                  <button
                                    className={
                                      repositoryDraft.enabled
                                        ? 'btn-warning'
                                        : 'btn-success'
                                    }
                                    onClick={() =>
                                      void toggleRepositoryEnabled(
                                        repositoryDraft.id!,
                                        repositoryDraft.enabled,
                                      )
                                    }
                                  >
                                    {repositoryDraft.enabled
                                      ? t('repoReview.button.disableRepo')
                                      : t('repoReview.button.enableRepo')}
                                  </button>
                                ) : null}
                                <button
                                  className="btn-danger"
                                  onClick={() => void deleteRepository()}
                                  disabled={
                                    !repositoryDraft.id || deletingRepository
                                  }
                                >
                                  {deletingRepository
                                    ? t('repoReview.button.deleting')
                                    : t('repoReview.button.deleteRepo')}
                                </button>
                              </div>
                              <div className="settings-hint">
                                Local hook-based review remains supported, but
                                team workflows should generally prefer remote
                                webhooks or manual remote branch sync.
                              </div>
                              {selectedRepository?.autoSyncEnabled ? (
                                <div className="settings-hint">
                                  Auto sync:
                                  {` every ${selectedRepository.autoSyncIntervalMinutes} min; last ${formatRepoAutoSyncStatus(selectedRepository.lastAutoSyncStatus)} ${formatOptionalDateTime(selectedRepository.lastAutoSyncAt)}; next ${formatOptionalDateTime(selectedRepository.nextAutoSyncAt)}`}
                                  {selectedRepository.lastAutoSyncMessage
                                    ? `; ${selectedRepository.lastAutoSyncMessage}`
                                    : ''}
                                </div>
                              ) : null}
                              {lastSyncMessage ? (
                                <div className="test-result success">
                                  {lastSyncMessage}
                                </div>
                              ) : null}
                            </div>
                          </>
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="provider-empty repo-review-inline-empty">
                  {t('repoReview.repo.noMatch')}
                </div>
              )}
            </section>
          </RepoReviewWorkspaceDetailSurface>
        ) : null}
      </div>

      {message ? <div className="test-result success">{message}</div> : null}
      {error ? <div className="test-result error">{error}</div> : null}

      {selectedRunData ? (
        <RepoReviewRunDetailModal
          run={selectedRunData}
          loading={loadingRunDetail}
          repositoryName={
            repositoryById.get(selectedRunData.repositoryId)?.name ||
            selectedRunData.repositoryId
          }
          profileName={
            profileById.get(selectedRunData.profileId)?.name ||
            'Unmatched profile'
          }
          progressEntries={selectedRunProgressEntries}
          onClose={closeRunDetail}
          formatRunTitle={formatRunTitle}
          formatResultStateLabel={formatResultStateLabel}
          getDeliveryTone={getDeliveryTone}
          resolveChatDeliveryStatus={resolveChatDeliveryStatus}
          resolvePlatformDeliveryStatus={resolvePlatformDeliveryStatus}
          formatDeliveryStatusLabel={formatDeliveryStatusLabel}
          formatRunStageLabel={formatRunStageLabel}
          formatRunSourceLabel={formatRunSourceLabel}
          formatBaselineSourceLabel={formatBaselineSourceLabel}
          formatShortSha={(value) => formatShortSha(value || '')}
          formatDurationMs={(value) => formatDurationMs(value || 0)}
          getRunDurationMs={getRunDurationMs}
        />
      ) : null}

      {selectedDigestRunDetail ? (
        <RepoReviewDigestRunDetailModal
          run={selectedDigestRunDetail}
          loading={loadingDigestRunDetail}
          repositoryName={
            repositoryById.get(selectedDigestRunDetail.repositoryId)?.name ||
            selectedDigestRunDetail.repositoryId
          }
          onClose={closeDigestRunDetail}
          formatDigestRunTypeLabel={formatDigestRunTypeLabel}
          formatDigestRunStatusLabel={formatDigestRunStatusLabel}
          formatDigestDeliveryStatusLabel={formatDigestDeliveryStatusLabel}
          getDeliveryTone={getDeliveryTone}
          formatDurationMs={(value) => formatDurationMs(value || 0)}
        />
      ) : null}

      {branchStatusPanelOpen && selectedRepository ? (
        <RepoReviewBranchStatusModal
          apiBase={apiBase}
          repositoryId={selectedRepository.id}
          repositoryName={selectedRepository.name}
          initialBranch={branchStatusPanelInitialBranch}
          branchLocked={Boolean(branchStatusPanelInitialBranch)}
          items={allRepositoryBranchStates}
          runsByBranch={selectedRepositoryRunsByBranch}
          syncingBranchNames={syncingBranchNames}
          onClose={() => {
            setBranchStatusPanelOpen(false);
            setBranchStatusPanelInitialBranch('');
          }}
          onOpenRunDetail={(run) => {
            void openRunDetail(run);
          }}
          onTriggerReview={(input) => {
            void syncSingleRemoteBranch(input.branch, input);
          }}
          formatShortSha={(value) => formatShortSha(value || '')}
          formatOptionalDateTime={(value) =>
            formatOptionalDateTime(value || '')
          }
          formatRunOutcomeLabel={formatRunOutcomeLabel}
          formatRunStageLabel={formatRunStageLabel}
        />
      ) : null}

      {confirmDialog.open ? (
        <div className="modal-overlay" onClick={closeConfirmDialog}>
          <div
            className="modal modal-confirm"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>{confirmDialog.title}</h3>
            <p className="confirm-message">{confirmDialog.message}</p>
            <div className="modal-actions">
              <button
                className="btn-outline"
                onClick={closeConfirmDialog}
                disabled={confirmDialog.pending}
              >
                取消
              </button>
              <button
                className={
                  confirmDialog.tone === 'danger'
                    ? 'btn-danger'
                    : confirmDialog.tone === 'warning'
                      ? 'btn-warning'
                      : 'btn-primary'
                }
                onClick={() => void runConfirmDialog()}
                disabled={confirmDialog.pending}
              >
                {confirmDialog.pending
                  ? t('repoReview.button.processing')
                  : confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
