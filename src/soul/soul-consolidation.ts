import crypto from 'crypto';

import {
  getPromotionCandidateObservations,
  pruneExpiredObservations,
  updateUserMemoryObservation,
  addUserMemory,
  findSimilarUserMemories,
  updateUserMemory,
  listPersonaInsights,
  updatePersonaInsight,
  deletePersonaInsight,
  addMemoryConsolidationLog,
  getLastConsolidationTime,
  setRuntimeState,
  getRuntimeState,
  deleteRuntimeState,
  getUserSoul,
  listUserMemoryObservations,
  recordMemoryEvent,
} from '../db.js';
import { logger } from '../logger.js';
import {
  deleteUserMemoryProjection,
  projectUserMemoryToDocument,
} from '../memory/user-memory-documents.js';
import type {
  UserMemoryRecord,
  UserMemoryObservationRecord,
  PersonaInsightRecord,
  MemoryConsolidationLogRecord,
} from '../types.js';
import { t } from '../i18n/index.js';

const DEFAULT_MIN_FREQUENCY = 2;
const DEFAULT_MIN_CONFIDENCE = 0.5;
const DEFAULT_INSIGHT_ACTIVATION = 0.6;
const LOW_CONFIDENCE_RETIRE_THRESHOLD = 0.15;
const DEFAULT_COOLDOWN_HOURS = 24;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

export interface ConsolidationThresholds {
  minFrequency: number;
  minConfidence: number;
  insightActivation: number;
  cooldownHours: number;
}

function lockKey(userId: string): string {
  return `consolidation_lock:${userId}`;
}

async function acquireLock(userId: string): Promise<boolean> {
  const key = lockKey(userId);
  const existing = await getRuntimeState(key);
  if (existing) {
    const lockTime = new Date(existing).getTime();
    if (Date.now() - lockTime < LOCK_TIMEOUT_MS) {
      return false;
    }
  }
  await setRuntimeState(key, new Date().toISOString());
  return true;
}

async function releaseLock(userId: string): Promise<void> {
  await deleteRuntimeState(lockKey(userId));
}

async function getThresholds(userId: string): Promise<ConsolidationThresholds> {
  const soul = await getUserSoul(userId);
  if (!soul?.consolidation_config) {
    return {
      minFrequency: DEFAULT_MIN_FREQUENCY,
      minConfidence: DEFAULT_MIN_CONFIDENCE,
      insightActivation: DEFAULT_INSIGHT_ACTIVATION,
      cooldownHours: DEFAULT_COOLDOWN_HOURS,
    };
  }
  try {
    const cfg = JSON.parse(soul.consolidation_config) as Partial<ConsolidationThresholds>;
    return {
      minFrequency: cfg.minFrequency ?? DEFAULT_MIN_FREQUENCY,
      minConfidence: cfg.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
      insightActivation: cfg.insightActivation ?? DEFAULT_INSIGHT_ACTIVATION,
      cooldownHours: cfg.cooldownHours ?? DEFAULT_COOLDOWN_HOURS,
    };
  } catch {
    return {
      minFrequency: DEFAULT_MIN_FREQUENCY,
      minConfidence: DEFAULT_MIN_CONFIDENCE,
      insightActivation: DEFAULT_INSIGHT_ACTIVATION,
      cooldownHours: DEFAULT_COOLDOWN_HOURS,
    };
  }
}

function contentOverlaps(a: string, b: string): boolean {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[，。、！？\s]/g, '');
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (na.length < 5 || nb.length < 5) return false;
  return na.includes(nb) || nb.includes(na);
}

// ---------------------------------------------------------------------------
// Phase 1: Promote high-signal observations to durable memories
// ---------------------------------------------------------------------------

async function promoteObservations(
  userId: string,
  thresholds: ConsolidationThresholds,
): Promise<{ promoted: number }> {
  const candidates = await getPromotionCandidateObservations(
    userId,
    thresholds.minFrequency,
    thresholds.minConfidence,
  );

  let promoted = 0;
  const now = new Date().toISOString();

  for (const obs of candidates) {
    try {
      const similar = await findSimilarUserMemories(
        userId,
        obs.category,
        obs.content,
      );
      const existing = similar.find((m) => contentOverlaps(m.content, obs.content));

      if (existing) {
        await updateUserMemory(existing.id, userId, {
          content: obs.content,
          confidence: Math.min(1.0, existing.confidence + 0.1),
          importance: Math.max(existing.importance, importanceFromObservation(obs)),
        });
        await projectUserMemoryToDocument(existing.id);
        await updateUserMemoryObservation(obs.id, userId, {
          promoted_to: existing.id,
        });
      } else {
        const memoryId = crypto.randomUUID();
        const eventId = await recordMemoryEvent({
          user_id: userId,
          scope: 'global',
          action_type: 'PROMOTE',
          target_type: 'user_memory',
          target_id: memoryId,
          conversation_id: null,
          source_message_id: null,
          before_snapshot: JSON.stringify({ observation_id: obs.id }),
          after_snapshot: JSON.stringify({ content: obs.content.slice(0, 500) }),
          decision_reason: 'consolidation_promote',
          metadata_json: JSON.stringify({ category: obs.category }),
        }).catch(() => null);
        const record: UserMemoryRecord = {
          id: memoryId,
          user_id: userId,
          scope: 'global',
          conversation_id: null,
          category: obs.category,
          content: obs.content,
          importance: importanceFromObservation(obs),
          confidence: obs.confidence,
          source: 'consolidation',
          tier: obs.confidence >= 0.8 ? 'core' : 'durable',
          promoted_from: obs.id,
          last_verified_at: now,
          source_event_id: eventId ?? null,
          valid_from: null,
          valid_to: null,
          access_count: 0,
          last_accessed_at: null,
          expires_at: null,
          created_at: now,
          updated_at: now,
        };
        await addUserMemory(record);
        await projectUserMemoryToDocument(record.id);
        await updateUserMemoryObservation(obs.id, userId, {
          promoted_to: memoryId,
        });
      }
      promoted++;
    } catch (err) {
      logger.warn({ err, obsId: obs.id }, 'Failed to promote observation');
    }
  }

  return { promoted };
}

function importanceFromObservation(obs: UserMemoryObservationRecord): number {
  if (obs.observation_type === 'fact' && obs.category === 'identity') {
    return Math.min(10, 7 + obs.frequency);
  }
  const base = obs.frequency >= 5 ? 7 : obs.frequency >= 3 ? 6 : 5;
  return Math.min(10, base + Math.round(obs.confidence * 2));
}

// ---------------------------------------------------------------------------
// Phase 2: Activate/retire persona insights
// ---------------------------------------------------------------------------

async function consolidateInsights(
  userId: string,
  thresholds: ConsolidationThresholds,
): Promise<{ activated: number; retired: number; merged: number }> {
  const allInsights = await listPersonaInsights(userId, { limit: 100 });
  let activated = 0;
  let retired = 0;
  let merged = 0;

  const byType = new Map<string, PersonaInsightRecord[]>();
  for (const ins of allInsights) {
    const list = byType.get(ins.insight_type) || [];
    list.push(ins);
    byType.set(ins.insight_type, list);
  }

  for (const [, insights] of byType) {
    for (let i = 0; i < insights.length; i++) {
      for (let j = i + 1; j < insights.length; j++) {
        if (contentOverlaps(insights[i].content, insights[j].content)) {
          const keep = insights[i].evidence_count >= insights[j].evidence_count
            ? insights[i] : insights[j];
          const remove = keep === insights[i] ? insights[j] : insights[i];

          await updatePersonaInsight(keep.id, userId, {
            evidence_count: keep.evidence_count + remove.evidence_count,
            confidence: Math.min(1.0, Math.max(keep.confidence, remove.confidence) + 0.1),
          });
          await deletePersonaInsight(remove.id, userId);
          merged++;
        }
      }
    }
  }

  const refreshed = await listPersonaInsights(userId, { limit: 100 });
  for (const ins of refreshed) {
    if (ins.status === 'candidate' && ins.confidence >= thresholds.insightActivation) {
      await updatePersonaInsight(ins.id, userId, { status: 'active' });
      activated++;
    }

    if (ins.status === 'candidate' && ins.confidence < LOW_CONFIDENCE_RETIRE_THRESHOLD
      && ins.evidence_count <= 1) {
      await updatePersonaInsight(ins.id, userId, { status: 'retired' });
      retired++;
    }
  }

  return { activated, retired, merged };
}

// ---------------------------------------------------------------------------
// Phase 3: Prune stale observations
// ---------------------------------------------------------------------------

async function pruneObservations(userId: string): Promise<number> {
  return pruneExpiredObservations(userId);
}

// ---------------------------------------------------------------------------
// Phase 4: Affinity-based memory consolidation (SimpleMem-style)
// ---------------------------------------------------------------------------

const AFFINITY_THRESHOLD = 0.6;
const MAX_AFFINITY_BATCH = 100;

function computeTokenAffinity(a: string, b: string): number {
  const tokenize = (s: string) =>
    s
      .toLowerCase()
      .match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) ?? [];
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  return (2 * intersection) / (tokensA.size + tokensB.size);
}

function pickMemoryMergeWinner(
  left: UserMemoryRecord,
  right: UserMemoryRecord,
): { keep: UserMemoryRecord; close: UserMemoryRecord } {
  const leftScore = left.confidence * 10 + left.importance;
  const rightScore = right.confidence * 10 + right.importance;
  if (leftScore !== rightScore) {
    return leftScore >= rightScore
      ? { keep: left, close: right }
      : { keep: right, close: left };
  }
  if (left.updated_at !== right.updated_at) {
    return left.updated_at >= right.updated_at
      ? { keep: left, close: right }
      : { keep: right, close: left };
  }
  return left.content.length >= right.content.length
    ? { keep: left, close: right }
    : { keep: right, close: left };
}

function mergeMemoryContent(
  keep: UserMemoryRecord,
  close: UserMemoryRecord,
): string {
  if (contentOverlaps(keep.content, close.content)) return keep.content;
  return `${keep.content}\n${close.content}`;
}

async function consolidateByAffinity(userId: string): Promise<number> {
  const { getUserMemories } = await import('../db.js');
  const all = await getUserMemories(userId, { limit: MAX_AFFINITY_BATCH, timeScope: 'current' });
  if (all.length < 2) return 0;

  const byCategory = new Map<string, UserMemoryRecord[]>();
  for (const m of all) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m);
    byCategory.set(m.category, list);
  }

  let merged = 0;
  const deleted = new Set<string>();

  for (const [, memories] of byCategory) {
    if (memories.length < 2) continue;
    for (let i = 0; i < memories.length; i++) {
      if (deleted.has(memories[i].id)) continue;
      for (let j = i + 1; j < memories.length; j++) {
        if (deleted.has(memories[j].id)) continue;
        const affinity = computeTokenAffinity(memories[i].content, memories[j].content);
        if (affinity < AFFINITY_THRESHOLD) continue;

        const { keep, close } = pickMemoryMergeWinner(memories[i], memories[j]);
        const mergedContent = mergeMemoryContent(keep, close);
        const closedAt = new Date().toISOString();

        await updateUserMemory(keep.id, userId, {
          content: mergedContent,
          importance: Math.max(keep.importance, close.importance),
          confidence: Math.min(1.0, Math.max(keep.confidence, close.confidence) + 0.05),
        });
        await projectUserMemoryToDocument(keep.id);
        await updateUserMemory(close.id, userId, { validTo: closedAt });
        await deleteUserMemoryProjection(close.id);
        deleted.add(close.id);
        merged++;
        recordMemoryEvent({
          user_id: userId,
          scope: 'global',
          action_type: 'MERGE',
          target_type: 'user_memory',
          target_id: keep.id,
          conversation_id: null,
          source_message_id: null,
          before_snapshot: JSON.stringify({ keep: keep.content.slice(0, 300), close: close.content.slice(0, 300) }),
          after_snapshot: JSON.stringify({ content: mergedContent.slice(0, 500), closedId: close.id, closedAt }),
          decision_reason: `affinity_merge: score=${affinity.toFixed(3)}`,
          metadata_json: JSON.stringify({ closed_id: close.id, closed_at: closedAt }),
        }).catch((err) => {
          logger.debug({ err }, 'Failed to record soul consolidation event');
        });
      }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Main consolidation entry point
// ---------------------------------------------------------------------------

export async function runConsolidation(
  userId: string,
  runType: 'scheduled' | 'manual' = 'scheduled',
): Promise<MemoryConsolidationLogRecord> {
  const locked = await acquireLock(userId);
  if (!locked) {
    throw new Error(t('soul.auto_34411c', {}, undefined));
  }

  try {
    const startTime = Date.now();
    const thresholds = await getThresholds(userId);

    const promoteResult = await promoteObservations(userId, thresholds);
    const insightResult = await consolidateInsights(userId, thresholds);
    const pruned = await pruneObservations(userId);
    let affinityMerged = 0;
    try {
      affinityMerged = await consolidateByAffinity(userId);
    } catch (err) {
      logger.warn({ err, userId }, 'Affinity consolidation failed');
    }

    const duration = Date.now() - startTime;
    const now = new Date().toISOString();

    const logRecord: MemoryConsolidationLogRecord = {
      id: crypto.randomUUID(),
      user_id: userId,
      run_type: runType,
      observations_reviewed: promoteResult.promoted + pruned,
      promoted: promoteResult.promoted,
      merged: insightResult.merged + affinityMerged,
      pruned,
      insights_generated: insightResult.activated,
      duration_ms: duration,
      created_at: now,
    };

    await addMemoryConsolidationLog(logRecord);

    logger.info(
      {
        userId,
        promoted: promoteResult.promoted,
        merged: insightResult.merged + affinityMerged,
        affinityMerged,
        activated: insightResult.activated,
        retired: insightResult.retired,
        pruned,
        durationMs: duration,
      },
      'Memory consolidation completed',
    );

    return logRecord;
  } finally {
    await releaseLock(userId);
  }
}

// ---------------------------------------------------------------------------
// Single observation manual promotion
// ---------------------------------------------------------------------------

export async function promoteObservationById(
  userId: string,
  observationId: string,
): Promise<{ memoryId: string }> {
  const allObs = await listUserMemoryObservations(userId, { limit: 500 });
  const obs = allObs.find((o) => o.id === observationId);
  if (!obs) throw new Error(t('soul.auto_1be763', {}, undefined));
  if (obs.user_id !== userId) throw new Error(t('soul.auto_3e3951', {}, undefined));
  if (obs.promoted_to) throw new Error(t('soul.auto_9f3a0b', {}, undefined));

  const now = new Date().toISOString();
  const similar = await findSimilarUserMemories(userId, obs.category, obs.content);
  const existing = similar.find((m) => contentOverlaps(m.content, obs.content));

  let memoryId: string;
  if (existing) {
    memoryId = existing.id;
    await updateUserMemory(existing.id, userId, {
      content: obs.content,
      confidence: Math.min(1.0, existing.confidence + 0.15),
      importance: Math.max(existing.importance, importanceFromObservation(obs)),
    });
    await projectUserMemoryToDocument(existing.id);
  } else {
    memoryId = crypto.randomUUID();
    const eventId = await recordMemoryEvent({
      user_id: userId,
      scope: 'global',
      action_type: 'PROMOTE',
      target_type: 'user_memory',
      target_id: memoryId,
      conversation_id: null,
      source_message_id: null,
      before_snapshot: JSON.stringify({ observation_id: obs.id }),
      after_snapshot: JSON.stringify({ content: obs.content.slice(0, 500) }),
      decision_reason: 'manual_promote',
      metadata_json: JSON.stringify({ category: obs.category }),
    }).catch(() => null);
    const record: UserMemoryRecord = {
      id: memoryId,
      user_id: userId,
      scope: 'global',
      conversation_id: null,
      category: obs.category,
      content: obs.content,
      importance: importanceFromObservation(obs),
      confidence: Math.max(obs.confidence, 0.6),
      source: 'consolidation',
      tier: 'durable',
      promoted_from: obs.id,
      last_verified_at: now,
      source_event_id: eventId ?? null,
      valid_from: null,
      valid_to: null,
      access_count: 0,
      last_accessed_at: null,
      expires_at: null,
      created_at: now,
      updated_at: now,
    };
    await addUserMemory(record);
    await projectUserMemoryToDocument(record.id);
  }

  await updateUserMemoryObservation(obs.id, userId, { promoted_to: memoryId });
  return { memoryId };
}

// ---------------------------------------------------------------------------
// Consolidation gate check (for scheduled runs)
// ---------------------------------------------------------------------------

export async function shouldRunConsolidation(userId: string): Promise<boolean> {
  const thresholds = await getThresholds(userId);
  const cooldownMs = thresholds.cooldownHours * 60 * 60 * 1000;
  const lastRun = await getLastConsolidationTime(userId);
  if (!lastRun) return true;

  const elapsed = Date.now() - new Date(lastRun).getTime();
  return elapsed >= cooldownMs;
}
