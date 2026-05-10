import {
  applyConversationStreamEvent,
  applyConversationTurnEvent,
} from '../../app-helpers';
import type {
  AssistantTurn,
  ConversationChatState,
  RepoReviewRepository,
  RepoReviewRun,
} from '../../app-types';
import type { NormalizedConversationRealtimeEvent } from '../../conversation-realtime';

function parseRunTimestamp(value: string): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

export function getRepoReviewRunLatestActivityTime(run: RepoReviewRun): number {
  const candidates = [
    run.updatedAt,
    run.completedAt,
    run.startedAt,
    run.createdAt,
  ];
  for (const value of candidates) {
    const parsed = parseRunTimestamp(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function pickRicherArray<T>(preferred: T[], fallback: T[]): T[] {
  return preferred.length > 0 ? preferred : fallback;
}

function pickRicherObject(
  preferred?: Record<string, unknown>,
  fallback?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (preferred && Object.keys(preferred).length > 0) return preferred;
  return fallback;
}

function getTurnActivityTime(turns: AssistantTurn[]): number {
  let latest = Number.NaN;
  for (const turn of turns) {
    const turnTime = parseRunTimestamp(turn.timestamp);
    if (!Number.isNaN(turnTime) && (Number.isNaN(latest) || turnTime > latest)) {
      latest = turnTime;
    }
    for (const item of turn.items) {
      const itemTime = parseRunTimestamp(item.timestamp);
      if (!Number.isNaN(itemTime) && (Number.isNaN(latest) || itemTime > latest)) {
        latest = itemTime;
      }
    }
  }
  return latest;
}

function countTurnItems(turns: AssistantTurn[]): number {
  return turns.reduce((total, turn) => total + turn.items.length, 0);
}

function pickRicherTurns(
  preferred: AssistantTurn[],
  fallback: AssistantTurn[],
): AssistantTurn[] {
  if (preferred.length === 0) return fallback;
  if (fallback.length === 0) return preferred;

  const preferredLatest = getTurnActivityTime(preferred);
  const fallbackLatest = getTurnActivityTime(fallback);
  if (!Number.isNaN(preferredLatest) || !Number.isNaN(fallbackLatest)) {
    if (Number.isNaN(fallbackLatest)) return preferred;
    if (Number.isNaN(preferredLatest)) return fallback;
    if (preferredLatest !== fallbackLatest) {
      return preferredLatest > fallbackLatest ? preferred : fallback;
    }
  }

  const preferredLiveCount = preferred.filter((turn) => turn.isLive).length;
  const fallbackLiveCount = fallback.filter((turn) => turn.isLive).length;
  if (preferredLiveCount !== fallbackLiveCount) {
    return preferredLiveCount > fallbackLiveCount ? preferred : fallback;
  }

  const preferredItemCount = countTurnItems(preferred);
  const fallbackItemCount = countTurnItems(fallback);
  if (preferredItemCount !== fallbackItemCount) {
    return preferredItemCount > fallbackItemCount ? preferred : fallback;
  }

  return preferred.length >= fallback.length ? preferred : fallback;
}

function pickRicherProgress(
  preferred: RepoReviewRun['reviewProgress'],
  fallback: RepoReviewRun['reviewProgress'],
): RepoReviewRun['reviewProgress'] {
  if (!preferred) return fallback;
  if (!fallback) return preferred;
  const preferredStepCount = preferred.steps?.length || 0;
  const fallbackStepCount = fallback.steps?.length || 0;
  if (preferredStepCount !== fallbackStepCount) {
    return preferredStepCount > fallbackStepCount ? preferred : fallback;
  }
  if ((preferred.turnCount || 0) !== (fallback.turnCount || 0)) {
    return (preferred.turnCount || 0) > (fallback.turnCount || 0)
      ? preferred
      : fallback;
  }
  return preferred.latestAssistantText || preferred.latestErrorText
    ? preferred
    : fallback;
}

function createRepoReviewTurnState(run: RepoReviewRun): ConversationChatState {
  return {
    messages: [],
    pendingMessages: [],
    turns: run.reviewTurns,
    approvals: [],
  };
}

function pickLatestRunTimestamp(
  currentValue: string,
  incomingValue?: string,
): string {
  const currentTime = parseRunTimestamp(currentValue);
  const incomingTime = parseRunTimestamp(incomingValue || '');
  if (Number.isNaN(incomingTime)) return currentValue;
  if (Number.isNaN(currentTime) || incomingTime >= currentTime) {
    return incomingValue || currentValue;
  }
  return currentValue;
}

export function getRepoReviewRunChatJid(
  run: RepoReviewRun,
  repository?: Pick<RepoReviewRepository, 'id' | 'reviewChatJid'> | null,
): string {
  const configuredJid = repository?.reviewChatJid?.trim();
  return configuredJid || `repo-review:${run.repositoryId}`;
}

export function applyRepoReviewRealtimeEventToRun(
  run: RepoReviewRun,
  event: Extract<NormalizedConversationRealtimeEvent, { kind: 'turn_event' | 'stream' }>,
): RepoReviewRun {
  const currentState = createRepoReviewTurnState(run);
  const nextState =
    event.kind === 'turn_event'
      ? applyConversationTurnEvent(currentState, event.event)
      : applyConversationStreamEvent(currentState, {
          chunk: event.chunk,
          done: event.done,
          timestamp: event.timestamp || new Date().toISOString(),
          runId: event.runId,
        });

  if (nextState.turns === run.reviewTurns) {
    return run;
  }

  const nextTimestamp = pickLatestRunTimestamp(run.updatedAt, event.timestamp);
  return {
    ...run,
    reviewTurns: nextState.turns,
    updatedAt: nextTimestamp,
    startedAt: run.startedAt || event.timestamp || run.startedAt,
    status: run.status === 'queued' ? 'running' : run.status,
  };
}

export function sortRepoReviewRunsByLatestActivity(
  runs: RepoReviewRun[],
): RepoReviewRun[] {
  return [...runs].sort((left, right) => {
    const timeDiff =
      getRepoReviewRunLatestActivityTime(right) -
      getRepoReviewRunLatestActivityTime(left);
    if (timeDiff !== 0) return timeDiff;
    return right.id.localeCompare(left.id, 'en');
  });
}

export function mergeRepoReviewRunSnapshot(
  summaryRun: RepoReviewRun | null,
  detailRun: RepoReviewRun | null,
): RepoReviewRun | null {
  if (!summaryRun) return detailRun;
  if (!detailRun) return summaryRun;

  const summaryIsFresher =
    getRepoReviewRunLatestActivityTime(summaryRun) >=
    getRepoReviewRunLatestActivityTime(detailRun);
  const fresh = summaryIsFresher ? summaryRun : detailRun;
  const stale = summaryIsFresher ? detailRun : summaryRun;

  return {
    ...stale,
    ...fresh,
    findings: pickRicherArray(fresh.findings, stale.findings),
    reviewTurns: pickRicherTurns(fresh.reviewTurns, stale.reviewTurns),
    reviewProgress: pickRicherProgress(
      fresh.reviewProgress,
      stale.reviewProgress,
    ),
    commitDetails: pickRicherArray(fresh.commitDetails, stale.commitDetails),
    commitReviews: pickRicherArray(fresh.commitReviews, stale.commitReviews),
    suggestions: pickRicherArray(fresh.suggestions, stale.suggestions),
    changedFiles: pickRicherArray(fresh.changedFiles, stale.changedFiles),
    effectiveRules: pickRicherObject(fresh.effectiveRules, stale.effectiveRules),
  };
}

export function mergeFetchedRepoReviewRunSnapshot(
  fetchedRun: RepoReviewRun | null,
  localRun: RepoReviewRun | null,
): RepoReviewRun | null {
  if (!fetchedRun) return localRun;
  if (!localRun) return fetchedRun;

  const fetchedIsFresher =
    getRepoReviewRunLatestActivityTime(fetchedRun) >=
    getRepoReviewRunLatestActivityTime(localRun);
  const fresh = fetchedIsFresher ? fetchedRun : localRun;
  const stale = fetchedIsFresher ? localRun : fetchedRun;

  return {
    ...stale,
    ...fresh,
    summary: fresh.summary || stale.summary,
    resultState: fresh.resultState || stale.resultState,
    baselineSource: fresh.baselineSource || stale.baselineSource,
    baselineRef: fresh.baselineRef || stale.baselineRef,
    baselineLabel: fresh.baselineLabel || stale.baselineLabel,
    idempotencyKey: fresh.idempotencyKey || stale.idempotencyKey,
    platformStatus: fresh.platformStatus || stale.platformStatus,
    platformCommentUrl: fresh.platformCommentUrl || stale.platformCommentUrl,
    platformCommentId: fresh.platformCommentId || stale.platformCommentId,
    chatDeliveryStatus: fresh.chatDeliveryStatus || stale.chatDeliveryStatus,
    platformStatusDeliveryStatus:
      fresh.platformStatusDeliveryStatus || stale.platformStatusDeliveryStatus,
    platformCommentDeliveryStatus:
      fresh.platformCommentDeliveryStatus ||
      stale.platformCommentDeliveryStatus,
    lastDeliveryError: fresh.lastDeliveryError || stale.lastDeliveryError,
    deliveryRetryCount: fresh.deliveryRetryCount ?? stale.deliveryRetryCount,
    manualDecision: fresh.manualDecision || stale.manualDecision,
    manualDecisionBy: fresh.manualDecisionBy || stale.manualDecisionBy,
    manualDecisionAt: fresh.manualDecisionAt || stale.manualDecisionAt,
    error: fresh.error || stale.error,
    startedAt: fresh.startedAt || stale.startedAt,
    completedAt: fresh.completedAt || stale.completedAt,
    updatedAt: fresh.updatedAt || stale.updatedAt,
    durationMs: fresh.durationMs ?? stale.durationMs,
    findings: pickRicherArray(fresh.findings, stale.findings),
    reviewTurns: pickRicherTurns(fresh.reviewTurns, stale.reviewTurns),
    reviewProgress: pickRicherProgress(
      fresh.reviewProgress,
      stale.reviewProgress,
    ),
    commitDetails: pickRicherArray(
      fresh.commitDetails,
      stale.commitDetails,
    ),
    commitReviews: pickRicherArray(
      fresh.commitReviews,
      stale.commitReviews,
    ),
    suggestions: pickRicherArray(fresh.suggestions, stale.suggestions),
    changedFiles: pickRicherArray(
      fresh.changedFiles,
      stale.changedFiles,
    ),
    effectiveRules: pickRicherObject(
      fresh.effectiveRules,
      stale.effectiveRules,
    ),
  };
}

export function mergeRepoReviewRunListSnapshots(
  freshRuns: RepoReviewRun[],
  staleRuns: RepoReviewRun[],
): RepoReviewRun[] {
  const staleById = new Map(staleRuns.map((run) => [run.id, run] as const));
  return freshRuns.map((run) => {
    const merged = mergeFetchedRepoReviewRunSnapshot(
      run,
      staleById.get(run.id) || null,
    );
    return merged || run;
  });
}
