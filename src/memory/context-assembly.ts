import {
  getContextEntries,
  getConversationIdentityBinding,
  getConversationOwnerUserId,
  getLatestContextCompaction,
  listMemoryDocuments,
  recordMemoryEvent,
  searchMemoryDocuments,
  touchUserMemoryAccess,
  updateMemoryPromptStats,
} from '../db.js';
import { getConfigValue } from '../config-store.js';
import { resolveEmbeddingProvider } from '../embedding/resolve.js';
import { cachedEmbedQuery, searchByVector } from '../embedding/vector-store.js';
import { logger } from '../logger.js';
import { escapeXml, formatMessages } from '../router.js';
import type {
  ContextCompactionRecord,
  ContextEntryRecord,
  MemoryDocumentRecord,
  NewMessage,
} from '../types.js';

import { getMemoryContextConfig } from './context-config.js';
import { applyTemporalDecay } from './temporal-decay.js';

const MAX_PROMPT_CONTEXT_ENTRY_CHARS = 600;
const MAX_PROMPT_RECALL_ENTRY_CHARS = 800;

function escapePromptAttr(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncatePromptContextTextForSource(
  text: string,
  sourceType: ContextEntryRecord['source_type'],
): string {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  const maxChars =
    sourceType === 'memory_recall'
      ? MAX_PROMPT_RECALL_ENTRY_CHARS
      : MAX_PROMPT_CONTEXT_ENTRY_CHARS;
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}\n...[truncated]...`;
}

function shouldIncludePromptContextEntry(
  entry: ContextEntryRecord,
  currentMessageIds: Set<string>,
): boolean {
  if (entry.source_ref && currentMessageIds.has(entry.source_ref)) {
    return false;
  }
  return (
    entry.source_type === 'chat_message' ||
    entry.source_type === 'assistant_message' ||
    entry.source_type === 'compaction_summary' ||
    entry.source_type === 'memory_recall' ||
    entry.source_type === 'post_compaction_context'
  );
}

function formatPromptContextEntries(entries: ContextEntryRecord[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map((entry) => {
    const text = truncatePromptContextTextForSource(
      entry.content_text,
      entry.source_type,
    );
    return `<entry role="${escapePromptAttr(entry.role)}" source="${escapePromptAttr(
      entry.source_type,
    )}" memory_source="${escapePromptAttr(
      inferPromptMemorySource(entry),
    )}" time="${escapePromptAttr(entry.created_at)}">${escapeXml(text)}</entry>`;
  });
  return `<recent_context>\n${lines.join('\n')}\n</recent_context>`;
}

function parseEntryJson(entry: ContextEntryRecord): Record<string, unknown> {
  try {
    const parsed = entry.content_json ? JSON.parse(entry.content_json) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function inferPromptMemorySource(entry: ContextEntryRecord): string {
  if (entry.source_type === 'memory_recall') {
    const parsed = parseEntryJson(entry);
    const sourceType = typeof parsed.sourceType === 'string'
      ? parsed.sourceType
      : '';
    return sourceType || 'durable_memory';
  }
  if (entry.source_type === 'post_compaction_context') {
    const parsed = parseEntryJson(entry);
    return parsed.visibility === 'session_only'
      ? 'session_memory'
      : 'recent_context';
  }
  if (entry.source_type === 'compaction_summary') return 'compaction_summary';
  return 'recent_context';
}

function parseCompactedSourceEntryIds(
  summary: ContextCompactionRecord | undefined,
): Set<string> {
  if (!summary?.source_entry_ids_json) return new Set<string>();
  try {
    const parsed = JSON.parse(summary.source_entry_ids_json) as unknown;
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(
      parsed.filter((value): value is string => typeof value === 'string'),
    );
  } catch {
    return new Set<string>();
  }
}

function createPromptSummaryEntry(
  summary: ContextCompactionRecord,
): ContextEntryRecord {
  return {
    id: `summary:${summary.id}`,
    group_folder: summary.group_folder,
    chat_jid: summary.chat_jid,
    run_id: null,
    provider: 'system',
    role: 'summary',
    source_type: 'compaction_summary',
    source_ref: summary.id,
    content_text: summary.summary_text,
    content_json: summary.source_entry_ids_json,
    token_estimate: null,
    created_at: summary.created_at,
  };
}

function estimatePromptEntryTokens(entry: ContextEntryRecord): number {
  if (
    typeof entry.token_estimate === 'number' &&
    Number.isFinite(entry.token_estimate) &&
    entry.token_estimate > 0
  ) {
    return entry.token_estimate;
  }
  const normalized = String(entry.content_text || '').trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 100) return 100;
  return Math.floor(value);
}

function buildPromptEntriesWithBudget(input: {
  latestSummary?: ContextCompactionRecord;
  recallEntries?: ContextEntryRecord[];
  recentRecallEntries?: ContextEntryRecord[];
  recentRawEntries: ContextEntryRecord[];
  maxSnippets: number;
  tokenBudget: number;
  summaryRatio: number;
  recallRatio: number;
  recentRatio: number;
}): ContextEntryRecord[] {
  const entries: ContextEntryRecord[] = [];
  let remainingSnippets = input.maxSnippets;
  let remainingBudget = Math.max(0, Math.floor(input.tokenBudget));
  if (remainingSnippets <= 0 || remainingBudget <= 0) return entries;

  const summaryBudget = Math.floor(
    remainingBudget * (clampRatio(input.summaryRatio) / 100),
  );
  const recallBudget = Math.floor(
    remainingBudget * (clampRatio(input.recallRatio) / 100),
  );
  const recentBudget = Math.floor(
    remainingBudget * (clampRatio(input.recentRatio) / 100),
  );

  const bucketBudgets = {
    summary: summaryBudget,
    recall: recallBudget,
    recent: recentBudget,
  };
  let carryBudget = Math.max(
    0,
    remainingBudget - summaryBudget - recallBudget - recentBudget,
  );

  const tryConsumeEntry = (
    entry: ContextEntryRecord,
    bucket: 'summary' | 'recall' | 'recent',
  ): boolean => {
    if (remainingSnippets <= 0 || remainingBudget <= 0) return false;
    const tokens = estimatePromptEntryTokens(entry);
    if (tokens > remainingBudget) {
      return false;
    }
    const bucketBudget = bucketBudgets[bucket];
    if (tokens > bucketBudget + carryBudget) {
      return false;
    }

    const bucketSpent = Math.min(bucketBudget, tokens);
    const sharedSpent = Math.max(0, tokens - bucketSpent);
    bucketBudgets[bucket] -= bucketSpent;
    carryBudget -= sharedSpent;
    remainingBudget -= tokens;
    remainingSnippets -= 1;
    return true;
  };

  const releaseBucketBudget = (bucket: 'summary' | 'recall' | 'recent') => {
    carryBudget += bucketBudgets[bucket];
    bucketBudgets[bucket] = 0;
  };

  if (input.latestSummary) {
    const summaryEntry = createPromptSummaryEntry(input.latestSummary);
    if (tryConsumeEntry(summaryEntry, 'summary')) {
      entries.push(summaryEntry);
    }
  }
  releaseBucketBudget('summary');

  const recallEntries = input.recallEntries || input.recentRecallEntries || [];
  for (const entry of recallEntries) {
    if (!tryConsumeEntry(entry, 'recall')) break;
    entries.push(entry);
  }
  releaseBucketBudget('recall');

  const selectedRawEntries: ContextEntryRecord[] = [];
  for (let index = input.recentRawEntries.length - 1; index >= 0; index -= 1) {
    if (remainingSnippets <= 0) break;
    const entry = input.recentRawEntries[index]!;
    if (!tryConsumeEntry(entry, 'recent')) continue;
    selectedRawEntries.push(entry);
  }
  entries.push(...selectedRawEntries.reverse());

  return entries;
}

function summarizePromptEntryTokens(entries: ContextEntryRecord[]): {
  total: number;
  recent: number;
  summary: number;
  recall: number;
} {
  const totals = {
    total: 0,
    recent: 0,
    summary: 0,
    recall: 0,
  };
  for (const entry of entries) {
    const tokens = estimatePromptEntryTokens(entry);
    totals.total += tokens;
    if (entry.source_type === 'compaction_summary') {
      totals.summary += tokens;
    } else if (entry.source_type === 'memory_recall') {
      totals.recall += tokens;
    } else {
      totals.recent += tokens;
    }
  }
  return totals;
}

function buildCurrentMemoryQuery(sourceMessages: NewMessage[]): string {
  return sourceMessages
    .map((message) => String(message.content || '').trim())
    .filter(Boolean)
    .slice(-2)
    .join(' ')
    .slice(0, 300);
}

function createPromptMemoryEntry(input: {
  chatJid: string;
  groupFolder: string;
  pathRef: string;
  scope: 'group' | 'global';
  sourceType: MemoryDocumentRecord['source_type'];
  memoryClass: 'identity' | 'user_memory' | 'global_durable' | 'group_durable';
  body: string;
  updatedAt: string;
  metadataJson?: string | null;
}): ContextEntryRecord {
  return {
    id: `prompt-memory:${input.pathRef}:${input.updatedAt}`,
    group_folder: input.groupFolder,
    chat_jid: input.chatJid,
    run_id: null,
    provider: 'system',
    role: 'memory',
    source_type: 'memory_recall',
    source_ref: input.pathRef,
    content_text: input.body,
    content_json: JSON.stringify({
      path: input.pathRef,
      scope: input.scope,
      sourceType: input.sourceType,
      memoryClass: input.memoryClass,
      metadata: safeParseDocumentMetadata(input.metadataJson),
      lineStart: 1,
      lineEnd: Math.max(1, input.body.split(/\r?\n/).length),
    }),
    token_estimate: null,
    created_at: input.updatedAt,
  };
}

const VECTOR_ALPHA = 0.3;
const VECTOR_MIN_SCORE = 0.25;

const DEFAULT_PRETHINK_MIN_QUERY_LENGTH = 4;
const PRETHINK_SKIP_PATTERNS = /^(你好|嗨|hi|hello|hey|ok|好的|嗯|谢谢|thanks|thank you|bye|再见|晚安)[\s!！。.?？]*$/i;

let prethinkMinQueryLength: number | null = null;

function safeParseDocumentMetadata(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = value ? JSON.parse(value) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isCurrentUserMemoryDocument(
  result: {
    metadataJson: string | null;
    sourceType: string;
  },
  chatJid: string,
): boolean {
  if (result.sourceType !== 'user_memory') return true;
  const metadata = safeParseDocumentMetadata(result.metadataJson);
  const now = new Date().toISOString();
  const validFrom = typeof metadata.validFrom === 'string' ? metadata.validFrom : null;
  const validTo = typeof metadata.validTo === 'string' ? metadata.validTo : null;
  const expiresAt = typeof metadata.expiresAt === 'string' ? metadata.expiresAt : null;
  if (validFrom && validFrom > now) return false;
  if (validTo && validTo <= now) return false;
  if (expiresAt && expiresAt <= now) return false;
  if (metadata.scope === 'conversation') {
    return metadata.conversationId === chatJid;
  }
  return true;
}

function getUserMemoryImportance(result: {
  metadataJson: string | null;
}): number {
  const metadata = safeParseDocumentMetadata(result.metadataJson);
  return typeof metadata.importance === 'number' && Number.isFinite(metadata.importance)
    ? metadata.importance
    : 5;
}

function getUserMemoryConfidence(result: {
  metadataJson: string | null;
}): number {
  const metadata = safeParseDocumentMetadata(result.metadataJson);
  return typeof metadata.confidence === 'number' && Number.isFinite(metadata.confidence)
    ? metadata.confidence
    : 0.5;
}

function isCoreUserMemoryDocument(result: {
  metadataJson: string | null;
}): boolean {
  const metadata = safeParseDocumentMetadata(result.metadataJson);
  return metadata.tier === 'core' || getUserMemoryImportance(result) >= 8;
}

function getUserMemoryIdFromEntry(entry: ContextEntryRecord): string | null {
  const parsed = parseEntryJson(entry);
  const metadata = parsed.metadata && typeof parsed.metadata === 'object'
    ? parsed.metadata as Record<string, unknown>
    : {};
  return typeof metadata.memoryId === 'string' ? metadata.memoryId : null;
}

async function recordMemoryRecallEvents(
  chatJid: string,
  entries: ContextEntryRecord[],
): Promise<void> {
  const ownerUserId = await getConversationOwnerUserId(chatJid);
  const events = entries
    .filter((entry) => entry.source_type === 'memory_recall')
    .map((entry) => {
      const parsed = parseEntryJson(entry);
      const sourceType = typeof parsed.sourceType === 'string'
        ? parsed.sourceType
        : null;
      const metadata = parsed.metadata && typeof parsed.metadata === 'object'
        ? parsed.metadata as Record<string, unknown>
        : {};
      const userMemoryId = getUserMemoryIdFromEntry(entry);
      if (userMemoryId) {
        touchUserMemoryAccess(userMemoryId).catch((err) => {
          logger.debug({ err, memoryId: userMemoryId }, 'Failed to touch recalled user memory');
        });
      }
      return recordMemoryEvent({
        user_id:
          sourceType === 'user_memory' && typeof metadata.userId === 'string'
            ? metadata.userId
            : ownerUserId,
        scope:
          typeof parsed.scope === 'string'
            ? parsed.scope
            : entry.group_folder || 'global',
        action_type: 'RECALL',
        target_type: sourceType === 'user_memory' ? 'user_memory' : 'memory_document',
        target_id: userMemoryId || entry.source_ref || null,
        conversation_id: chatJid,
        source_message_id: null,
        before_snapshot: null,
        after_snapshot: JSON.stringify({
          sourceType,
          memoryClass:
            typeof parsed.memoryClass === 'string' ? parsed.memoryClass : null,
          path: entry.source_ref,
          content: entry.content_text.slice(0, 500),
        }),
        decision_reason: 'prompt_injection',
        metadata_json: JSON.stringify({
          sourceType,
          promptEntryId: entry.id,
          createdAt: entry.created_at,
        }),
      }).catch((err) => {
        logger.debug({ err, entryId: entry.id }, 'Failed to record memory recall event');
        return '';
      });
    });
  await Promise.all(events);
}

async function getPrethinkMinQueryLength(): Promise<number> {
  if (prethinkMinQueryLength !== null) return prethinkMinQueryLength;
  try {
    const val = await getConfigValue('PRETHINK_MIN_QUERY_LENGTH');
    prethinkMinQueryLength = val ? parseInt(val, 10) || DEFAULT_PRETHINK_MIN_QUERY_LENGTH : DEFAULT_PRETHINK_MIN_QUERY_LENGTH;
  } catch {
    prethinkMinQueryLength = DEFAULT_PRETHINK_MIN_QUERY_LENGTH;
  }
  return prethinkMinQueryLength;
}

async function shouldSkipDurableRecall(query: string): Promise<boolean> {
  const trimmed = query.trim();
  const minLen = await getPrethinkMinQueryLength();
  if (trimmed.length < minLen) return true;
  if (PRETHINK_SKIP_PATTERNS.test(trimmed)) return true;
  return false;
}

async function collectVectorScores(
  query: string,
  limit: number,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const enabled = await getConfigValue('VECTOR_SEARCH_ENABLED').catch(() => 'true');
    if (enabled === 'false') return map;
    const provider = await resolveEmbeddingProvider();
    if (!provider) return map;
    const queryVec = await cachedEmbedQuery(provider, query);
    const hits = await searchByVector(queryVec, 'memory_doc', limit * 3, VECTOR_MIN_SCORE);
    for (const h of hits) {
      map.set(h.ownerId, h.score);
    }
  } catch (err) {
    logger.debug({ err }, 'Vector search unavailable for memory recall, using BM25 only');
  }
  return map;
}

function dedupeRecallEntries(entries: ContextEntryRecord[]): ContextEntryRecord[] {
  const seen = new Set<string>();
  const result: ContextEntryRecord[] = [];
  for (const entry of entries) {
    const key = `${entry.source_ref || ''}:${entry.content_text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

async function collectDurablePromptEntries(input: {
  chatJid: string;
  groupFolder: string;
  query: string;
  maxEntries: number;
}): Promise<ContextEntryRecord[]> {
  const entries: ContextEntryRecord[] = [];
  const ownerUserId = await getConversationOwnerUserId(input.chatJid);
  const identityBinding = await getConversationIdentityBinding(input.chatJid);
  if (identityBinding?.person_id) {
    const identityDocs = await listMemoryDocuments({
      ownerType: 'person',
      ownerId: identityBinding.person_id,
      limit: 8,
    });
    const identityDoc = identityDocs.find(
      (doc) => doc.source_type === 'identity_memory' && doc.path_ref,
    );
    if (identityDoc?.path_ref) {
      entries.push(
        createPromptMemoryEntry({
          chatJid: input.chatJid,
          groupFolder: input.groupFolder,
          pathRef: identityDoc.path_ref,
          scope: 'global',
          sourceType: 'identity_memory',
          memoryClass: 'identity',
          body: identityDoc.body,
          updatedAt: identityDoc.updated_at,
          metadataJson: identityDoc.metadata_json,
        }),
      );
    }
  }

  if (ownerUserId) {
    const userMemoryDocs = (await listMemoryDocuments({
      ownerType: 'global',
      ownerId: ownerUserId,
      sourceType: 'user_memory',
      limit: Math.max(8, input.maxEntries * 3),
    })).filter((doc) =>
      isCurrentUserMemoryDocument(
        {
          sourceType: doc.source_type,
          metadataJson: doc.metadata_json,
        },
        input.chatJid,
      ),
    );
    for (const doc of userMemoryDocs.filter((item) =>
      isCoreUserMemoryDocument({ metadataJson: item.metadata_json }),
    )) {
      if (!doc.path_ref) continue;
      entries.push(
        createPromptMemoryEntry({
          chatJid: input.chatJid,
          groupFolder: input.groupFolder,
          pathRef: doc.path_ref,
          scope: 'global',
          sourceType: 'user_memory',
          memoryClass: 'user_memory',
          body: doc.body,
          updatedAt: doc.updated_at,
          metadataJson: doc.metadata_json,
        }),
      );
    }
  }

  const query = String(input.query || '').trim();
  if (!query || await shouldSkipDurableRecall(query)) {
    return entries.slice(0, input.maxEntries);
  }

  const bm25Results = [
    ...(ownerUserId
      ? (await searchMemoryDocuments(query, {
          limit: input.maxEntries,
          scopes: ['global'],
          ownerType: 'global',
          ownerId: ownerUserId,
          sourceTypes: ['user_memory'],
        })).filter((result) =>
          isCurrentUserMemoryDocument(result, input.chatJid),
        )
      : []),
    ...(await searchMemoryDocuments(query, {
      limit: input.maxEntries,
      scopes: ['global'],
      ownerType: 'global',
      ownerId: 'global',
      sourceTypes: ['memory_file'],
    })),
    ...(await searchMemoryDocuments(query, {
      limit: input.maxEntries,
      scopes: ['group'],
      ownerType: 'group',
      ownerId: input.groupFolder,
      sourceTypes: ['memory_file'],
    })),
  ];

  const vectorScoreMap = await collectVectorScores(query, input.maxEntries);

  const ranked = bm25Results
    .map((result) => {
      const vectorScore = vectorScoreMap.get(result.docId) ?? 0;
      const hybridScore = vectorScore > 0
        ? VECTOR_ALPHA * vectorScore + (1 - VECTOR_ALPHA) * result.score
        : result.score;
      const userMemoryBoost =
        result.sourceType === 'user_memory'
          ? 1 + (getUserMemoryImportance(result) / 10) * 0.25 + getUserMemoryConfidence(result) * 0.15
          : 1;
      return {
        ...result,
        score: applyTemporalDecay(hybridScore * userMemoryBoost, result.updatedAt),
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.exactMatchBoost !== left.exactMatchBoost) {
        return right.exactMatchBoost - left.exactMatchBoost;
      }
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt.localeCompare(left.updatedAt);
      }
      return left.docId.localeCompare(right.docId);
    })
    .slice(0, input.maxEntries * 2);

  for (const result of ranked) {
    if (!result.pathRef) continue;
    entries.push(
      createPromptMemoryEntry({
        chatJid: input.chatJid,
        groupFolder: input.groupFolder,
        pathRef: result.pathRef,
        scope: result.scope === 'global' ? 'global' : 'group',
        sourceType:
          result.sourceType === 'identity_memory'
            ? 'identity_memory'
            : result.sourceType === 'user_memory'
              ? 'user_memory'
              : 'memory_file',
        memoryClass:
          result.sourceType === 'user_memory'
            ? 'user_memory'
            : result.scope === 'global'
              ? 'global_durable'
              : 'group_durable',
        body: result.body,
        updatedAt: result.updatedAt,
        metadataJson: result.metadataJson,
      }),
    );
  }

  // Knowledge base retrieval is now handled via the knowledge_search MCP tool
  // (tool-based, on-demand) rather than automatic server-side injection.

  return dedupeRecallEntries(entries).slice(0, input.maxEntries);
}

export async function assembleAgentContext(
  chatJid: string,
  sourceMessages: NewMessage[],
): Promise<string> {
  const memoryConfig = await getMemoryContextConfig();
  if (!memoryConfig.memoryEnabled || !memoryConfig.memoryReadEnabled) {
    return formatMessages(sourceMessages);
  }

  const currentMessages = formatMessages(sourceMessages);
  if (
    !memoryConfig.promptInjectionEnabled ||
    memoryConfig.promptMaxSnippets <= 0
  ) {
    return currentMessages;
  }

  const currentMessageIds = new Set(sourceMessages.map((message) => message.id));
  const latestSummary = memoryConfig.compactionEnabled
    ? await getLatestContextCompaction(chatJid)
    : undefined;
  const compactedSourceEntryIds = parseCompactedSourceEntryIds(latestSummary);
  const promptEntries = await (async () => {
    try {
      const recentEntriesRaw = await getContextEntries(
        chatJid,
        Math.max(
          64,
          memoryConfig.compactionKeepRecentEntries +
            memoryConfig.promptMaxSnippets +
            8,
        ),
      );
      const recentEntries = recentEntriesRaw.filter((entry) =>
        shouldIncludePromptContextEntry(entry, currentMessageIds) &&
        !compactedSourceEntryIds.has(entry.id),
      );
      // Durable memory is now tool-first. Prompt assembly only reuses explicit
      // memory recall entries already written into the session ledger, instead
      // of performing another automatic recall pass on every turn.
      const storedRecallEntries = recentEntries
        .filter((entry) => entry.source_type === 'memory_recall')
        .slice(-1);
      const recallEntries = dedupeRecallEntries(storedRecallEntries);
      const recentRawEntries = recentEntries.filter(
        (entry) => entry.source_type !== 'memory_recall',
      );
      if (memoryConfig.promptTokenBudget > 0) {
        return buildPromptEntriesWithBudget({
          latestSummary,
          recallEntries,
          recentRawEntries,
          maxSnippets: memoryConfig.promptMaxSnippets,
          tokenBudget: memoryConfig.promptTokenBudget,
          summaryRatio: memoryConfig.promptSummaryRatio,
          recallRatio: memoryConfig.promptRecallRatio,
          recentRatio: memoryConfig.promptRecentRatio,
        });
      }

      const entries: ContextEntryRecord[] = [];
      let remainingSlots = memoryConfig.promptMaxSnippets;
      if (latestSummary && remainingSlots > 0) {
        entries.push(createPromptSummaryEntry(latestSummary));
        remainingSlots -= 1;
      }
      if (remainingSlots > 0 && recallEntries.length > 0) {
        const selectedRecallEntries = recallEntries.slice(0, remainingSlots);
        entries.push(...selectedRecallEntries);
        remainingSlots -= selectedRecallEntries.length;
      }
      if (remainingSlots > 0) {
        entries.push(...recentRawEntries.slice(-remainingSlots));
      }
      return entries;
    } catch {
      return [];
    }
  })();
  try {
    await recordMemoryRecallEvents(chatJid, promptEntries);
  } catch {
    /* recall audit must not block prompt assembly */
  }
  try {
    const promptStats = summarizePromptEntryTokens(promptEntries);
    await updateMemoryPromptStats({
      scope: chatJid,
      lastAssembledTokenEstimate: promptStats.total,
      lastRecentTokens: promptStats.recent,
      lastSummaryTokens: promptStats.summary,
      lastRecallTokens: promptStats.recall,
    });
  } catch {
    /* observability writeback must not block prompt assembly */
  }
  const recentContext = formatPromptContextEntries(promptEntries);
  return recentContext ? `${recentContext}\n\n${currentMessages}` : currentMessages;
}

export const __testing = {
  buildPromptEntriesWithBudget,
  estimatePromptEntryTokens,
  summarizePromptEntryTokens,
};
