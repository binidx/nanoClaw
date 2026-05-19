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
import type { PromptSegment } from '../types/prompt.js';

import { getChatContextConfig } from './chat-context-config.js';
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
    entry.source_type === 'tool_call_recent' ||
    entry.source_type === 'tool_call_summary' ||
    entry.source_type === 'compaction_summary' ||
    entry.source_type === 'memory_recall' ||
    entry.source_type === 'post_compaction_context'
  );
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
  if (entry.source_type === 'tool_call_recent') return 'tool_recent';
  if (entry.source_type === 'tool_call_summary') return 'tool_summary';
  if (entry.source_type === 'compaction_summary') return 'compaction_summary';
  if (
    entry.source_type === 'chat_message' ||
    entry.source_type === 'assistant_message'
  ) {
    return 'recent_chat';
  }
  return 'recent_context';
}

function formatPromptContextEntry(entry: ContextEntryRecord): string {
  const text = truncatePromptContextTextForSource(
    entry.content_text,
    entry.source_type,
  );
  return `<entry role="${escapePromptAttr(entry.role)}" source="${escapePromptAttr(
    entry.source_type,
  )}" memory_source="${escapePromptAttr(
    inferPromptMemorySource(entry),
  )}" time="${escapePromptAttr(entry.created_at)}">${escapeXml(text)}</entry>`;
}

function formatPromptContextEntries(entries: ContextEntryRecord[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map((entry) => formatPromptContextEntry(entry));
  return `<recent_context>\n${lines.join('\n')}\n</recent_context>`;
}

function derivePromptSegmentSource(entry: ContextEntryRecord): PromptSegment['source'] {
  if (entry.source_type === 'compaction_summary') return 'context_chat_summary';
  if (entry.source_type === 'tool_call_summary') return 'context_tool_summary';
  if (entry.source_type === 'memory_recall') return 'memory_recall_tool';
  if (entry.source_type === 'post_compaction_context') {
    const parsed = parseEntryJson(entry);
    return parsed.visibility === 'session_only'
      ? 'memory_recall_session'
      : 'context_recent';
  }
  if (entry.source_type === 'tool_call_recent') return 'context_tool_recent';
  if (
    entry.source_type === 'chat_message' ||
    entry.source_type === 'assistant_message'
  ) {
    return 'context_chat_recent';
  }
  return 'context_recent';
}

function derivePromptSegmentLabel(entry: ContextEntryRecord): string {
  if (entry.source_type === 'compaction_summary') return 'Chat Summary';
  if (entry.source_type === 'tool_call_summary') return 'Tool Summary';
  if (entry.source_type === 'memory_recall') return 'Memory Recall';
  if (entry.source_type === 'post_compaction_context') {
    const parsed = parseEntryJson(entry);
    return parsed.visibility === 'session_only'
      ? 'Session Memory'
      : 'Recent Context';
  }
  if (entry.source_type === 'tool_call_recent') return 'Recent Tool Activity';
  if (
    entry.source_type === 'chat_message' ||
    entry.source_type === 'assistant_message'
  ) {
    return 'Recent Chat';
  }
  return 'Recent Context';
}

function buildPromptContextSegments(entries: ContextEntryRecord[]): PromptSegment[] {
  return entries.map((entry) => ({
    id: `prompt-context:${entry.id}`,
    label: derivePromptSegmentLabel(entry),
    layer:
      entry.source_type === 'memory_recall' ||
      (entry.source_type === 'post_compaction_context' &&
        parseEntryJson(entry).visibility === 'session_only')
        ? 'context_memory'
        : 'context_runtime',
    mutability: 'derived',
    cacheSection: 'volatile',
    source: derivePromptSegmentSource(entry),
    content: formatPromptContextEntry(entry),
  }));
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

function parseContextEntrySourceIds(entry: ContextEntryRecord | undefined): Set<string> {
  if (!entry?.content_json) return new Set<string>();
  try {
    const parsed = JSON.parse(entry.content_json) as Record<string, unknown>;
    const candidate = Array.isArray(parsed.sourceEntryIds)
      ? parsed.sourceEntryIds
      : Array.isArray(parsed.source_entry_ids)
        ? parsed.source_entry_ids
        : null;
    if (!candidate) return new Set<string>();
    return new Set(
      candidate.filter((value): value is string => typeof value === 'string'),
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

interface LanePromptEntries {
  recentChatEntries: ContextEntryRecord[];
  recentToolEntries: ContextEntryRecord[];
  memoryRecallEntries: ContextEntryRecord[];
  summaryEntries: ContextEntryRecord[];
  activeChatCompactionId: string | null;
  activeToolSummaryId: string | null;
}

interface LanePromptSelection {
  orderedEntries: ContextEntryRecord[];
  activeChatCompactionId: string | null;
  activeToolSummaryId: string | null;
  stats: {
    totalTokens: number;
    recentTokens: number;
    summaryTokens: number;
    recallTokens: number;
    recentChatTokens: number;
    recentToolTokens: number;
    memoryRecallTokens: number;
    compactedSummaryTokens: number;
    recentChatCount: number;
    recentToolCount: number;
    memoryRecallCount: number;
    compactedSummaryCount: number;
    toolContextMode: 'recent' | 'summary' | 'mixed' | 'none';
  };
}

function selectNewestEntriesWithinBudget(
  entries: ContextEntryRecord[],
  budget: number,
  maxCount?: number,
): ContextEntryRecord[] {
  if (entries.length === 0) return [];
  const selected: ContextEntryRecord[] = [];
  let remainingBudget = Math.max(0, budget);
  let remainingCount = typeof maxCount === 'number' ? Math.max(0, maxCount) : Number.POSITIVE_INFINITY;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (remainingBudget <= 0 || remainingCount <= 0) break;
    const entry = entries[index]!;
    const tokens = estimatePromptEntryTokens(entry);
    if (tokens > remainingBudget) continue;
    selected.push(entry);
    remainingBudget -= tokens;
    remainingCount -= 1;
  }
  return selected.reverse();
}

function selectSummaryEntriesWithinBudget(
  entries: ContextEntryRecord[],
  budget: number,
): ContextEntryRecord[] {
  if (entries.length === 0 || budget <= 0) return [];
  const selected: ContextEntryRecord[] = [];
  let remainingBudget = budget;
  for (const entry of entries) {
    const tokens = estimatePromptEntryTokens(entry);
    if (tokens > remainingBudget) continue;
    selected.push(entry);
    remainingBudget -= tokens;
  }
  return selected;
}

function buildLanePromptSelection(
  laneEntries: LanePromptEntries,
  config: {
    tokenBudget: number;
    recentChatRatio: number;
    recentToolRatio: number;
    memoryRecallRatio: number;
    summaryRatio: number;
    memoryRecallMaxEntries: number;
  },
): LanePromptSelection {
  const totalBudget = Math.max(0, Math.floor(config.tokenBudget));
  const recentChatBudget = Math.floor(totalBudget * (clampRatio(config.recentChatRatio) / 100));
  const recentToolBudget = Math.floor(totalBudget * (clampRatio(config.recentToolRatio) / 100));
  const memoryRecallBudget = Math.floor(
    totalBudget * (clampRatio(config.memoryRecallRatio) / 100),
  );
  const summaryBudget = Math.floor(totalBudget * (clampRatio(config.summaryRatio) / 100));
  let carryBudget = Math.max(
    0,
    totalBudget -
      recentChatBudget -
      recentToolBudget -
      memoryRecallBudget -
      summaryBudget,
  );

  const recentChatSelected = selectNewestEntriesWithinBudget(
    laneEntries.recentChatEntries,
    recentChatBudget + carryBudget,
  );
  carryBudget += recentChatBudget - recentChatSelected.reduce(
    (sum, entry) => sum + estimatePromptEntryTokens(entry),
    0,
  );

  const recentToolSelected = selectNewestEntriesWithinBudget(
    laneEntries.recentToolEntries,
    recentToolBudget + carryBudget,
  );
  carryBudget += recentToolBudget - recentToolSelected.reduce(
    (sum, entry) => sum + estimatePromptEntryTokens(entry),
    0,
  );

  const memoryRecallSelected = selectNewestEntriesWithinBudget(
    laneEntries.memoryRecallEntries,
    memoryRecallBudget + carryBudget,
    config.memoryRecallMaxEntries,
  );
  carryBudget += memoryRecallBudget - memoryRecallSelected.reduce(
    (sum, entry) => sum + estimatePromptEntryTokens(entry),
    0,
  );

  const summarySelected = selectSummaryEntriesWithinBudget(
    laneEntries.summaryEntries,
    summaryBudget + carryBudget,
  );

  const orderedEntries = [
    ...recentChatSelected,
    ...recentToolSelected,
    ...memoryRecallSelected,
    ...summarySelected,
  ];

  const recentChatTokens = recentChatSelected.reduce(
    (sum, entry) => sum + estimatePromptEntryTokens(entry),
    0,
  );
  const recentToolTokens = recentToolSelected.reduce(
    (sum, entry) => sum + estimatePromptEntryTokens(entry),
    0,
  );
  const memoryRecallTokens = memoryRecallSelected.reduce(
    (sum, entry) => sum + estimatePromptEntryTokens(entry),
    0,
  );
  const compactedSummaryTokens = summarySelected.reduce(
    (sum, entry) => sum + estimatePromptEntryTokens(entry),
    0,
  );

  const hasRecentTools = recentToolSelected.length > 0;
  const hasToolSummary = summarySelected.some(
    (entry) => entry.source_type === 'tool_call_summary',
  );

  return {
    orderedEntries,
    activeChatCompactionId: laneEntries.activeChatCompactionId,
    activeToolSummaryId: laneEntries.activeToolSummaryId,
    stats: {
      totalTokens:
        recentChatTokens +
        recentToolTokens +
        memoryRecallTokens +
        compactedSummaryTokens,
      recentTokens: recentChatTokens + recentToolTokens,
      summaryTokens: compactedSummaryTokens,
      recallTokens: memoryRecallTokens,
      recentChatTokens,
      recentToolTokens,
      memoryRecallTokens,
      compactedSummaryTokens,
      recentChatCount: recentChatSelected.length,
      recentToolCount: recentToolSelected.length,
      memoryRecallCount: memoryRecallSelected.length,
      compactedSummaryCount: summarySelected.length,
      toolContextMode:
        hasRecentTools && hasToolSummary
          ? 'mixed'
          : hasRecentTools
            ? 'recent'
            : hasToolSummary
              ? 'summary'
              : 'none',
    },
  };
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

export interface AssembledAgentContext {
  text: string;
  userPrompt: string;
  contextBlocks: PromptSegment[];
}

export async function assembleAgentContextEnvelope(
  chatJid: string,
  sourceMessages: NewMessage[],
): Promise<AssembledAgentContext> {
  const [memoryConfig, chatContextConfig] = await Promise.all([
    getMemoryContextConfig(),
    getChatContextConfig(),
  ]);
  const currentMessages = formatMessages(sourceMessages);
  if (!memoryConfig.memoryEnabled || !memoryConfig.memoryReadEnabled) {
    return {
      text: currentMessages,
      userPrompt: currentMessages,
      contextBlocks: [],
    };
  }

  if (
    !memoryConfig.promptInjectionEnabled ||
    memoryConfig.promptMaxSnippets <= 0
  ) {
    return {
      text: currentMessages,
      userPrompt: currentMessages,
      contextBlocks: [],
    };
  }

  const currentMessageIds = new Set(sourceMessages.map((message) => message.id));
  const latestSummary = chatContextConfig.compactionEnabled
    ? await getLatestContextCompaction(chatJid)
    : undefined;
  const compactedSourceEntryIds = parseCompactedSourceEntryIds(latestSummary);
  const laneSelection = await (async (): Promise<LanePromptSelection> => {
    try {
      const recentEntriesRaw = await getContextEntries(
        chatJid,
        Math.max(
          96,
          chatContextConfig.rawChatKeepEntries +
            chatContextConfig.rawToolKeepCalls +
            memoryConfig.promptMaxSnippets +
            12,
        ),
      );
      const recentEntries = recentEntriesRaw.filter((entry) =>
        shouldIncludePromptContextEntry(entry, currentMessageIds) &&
        !compactedSourceEntryIds.has(entry.id),
      );
      const latestToolSummary = [...recentEntriesRaw]
        .filter((entry) => entry.source_type === 'tool_call_summary')
        .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
      const toolSummaryCoveredIds = parseContextEntrySourceIds(latestToolSummary);

      const recentChatEntries = recentEntries.filter(
        (entry) =>
          entry.source_type === 'chat_message' ||
          entry.source_type === 'assistant_message',
      );
      const recentToolEntries = recentEntries.filter(
        (entry) =>
          entry.source_type === 'tool_call_recent' &&
          !toolSummaryCoveredIds.has(entry.id),
      );
      const memoryRecallEntries = dedupeRecallEntries(
        recentEntries.filter(
          (entry) =>
            entry.source_type === 'memory_recall' ||
            entry.source_type === 'post_compaction_context',
        ),
      );
      const summaryEntries: ContextEntryRecord[] = [];
      if (latestToolSummary && toolSummaryCoveredIds.size > 0) {
        summaryEntries.push(latestToolSummary);
      }
      if (latestSummary) {
        summaryEntries.push(createPromptSummaryEntry(latestSummary));
      }

      const laneEntries: LanePromptEntries = {
        recentChatEntries,
        recentToolEntries,
        memoryRecallEntries,
        summaryEntries,
        activeChatCompactionId: latestSummary?.id || null,
        activeToolSummaryId: latestToolSummary?.id || null,
      };

      if (chatContextConfig.tokenBudget > 0) {
        return buildLanePromptSelection(laneEntries, {
          tokenBudget: chatContextConfig.tokenBudget,
          recentChatRatio: chatContextConfig.recentChatRatio,
          recentToolRatio: chatContextConfig.recentToolRatio,
          memoryRecallRatio: chatContextConfig.memoryRecallRatio,
          summaryRatio: chatContextConfig.summaryRatio,
          memoryRecallMaxEntries: memoryConfig.promptMaxSnippets,
        });
      }

      const orderedEntries = [
        ...recentChatEntries.slice(-chatContextConfig.rawChatKeepEntries),
        ...recentToolEntries.slice(-chatContextConfig.rawToolKeepCalls),
        ...memoryRecallEntries.slice(-memoryConfig.promptMaxSnippets),
        ...summaryEntries,
      ];
      const recentChatCount = orderedEntries.filter(
        (entry) =>
          entry.source_type === 'chat_message' ||
          entry.source_type === 'assistant_message',
      ).length;
      const recentToolCount = orderedEntries.filter(
        (entry) => entry.source_type === 'tool_call_recent',
      ).length;
      const memoryRecallCount = orderedEntries.filter(
        (entry) =>
          entry.source_type === 'memory_recall' ||
          entry.source_type === 'post_compaction_context',
      ).length;
      const compactedSummaryCount = orderedEntries.filter(
        (entry) =>
          entry.source_type === 'tool_call_summary' ||
          entry.source_type === 'compaction_summary',
      ).length;
      const hasToolSummary = orderedEntries.some(
        (entry) => entry.source_type === 'tool_call_summary',
      );
      const recentChatTokens = orderedEntries
        .filter(
          (entry) =>
            entry.source_type === 'chat_message' ||
            entry.source_type === 'assistant_message',
        )
        .reduce((sum, entry) => sum + estimatePromptEntryTokens(entry), 0);
      const recentToolTokens = orderedEntries
        .filter((entry) => entry.source_type === 'tool_call_recent')
        .reduce((sum, entry) => sum + estimatePromptEntryTokens(entry), 0);
      const memoryRecallTokens = orderedEntries
        .filter(
          (entry) =>
            entry.source_type === 'memory_recall' ||
            entry.source_type === 'post_compaction_context',
        )
        .reduce((sum, entry) => sum + estimatePromptEntryTokens(entry), 0);
      const compactedSummaryTokens = orderedEntries
        .filter(
          (entry) =>
            entry.source_type === 'tool_call_summary' ||
            entry.source_type === 'compaction_summary',
        )
        .reduce((sum, entry) => sum + estimatePromptEntryTokens(entry), 0);
      return {
        orderedEntries,
        activeChatCompactionId: laneEntries.activeChatCompactionId,
        activeToolSummaryId: laneEntries.activeToolSummaryId,
        stats: {
          totalTokens:
            recentChatTokens +
            recentToolTokens +
            memoryRecallTokens +
            compactedSummaryTokens,
          recentTokens: recentChatTokens + recentToolTokens,
          summaryTokens: compactedSummaryTokens,
          recallTokens: memoryRecallTokens,
          recentChatTokens,
          recentToolTokens,
          memoryRecallTokens,
          compactedSummaryTokens,
          recentChatCount,
          recentToolCount,
          memoryRecallCount,
          compactedSummaryCount,
          toolContextMode:
            recentToolCount > 0 && hasToolSummary
              ? 'mixed'
            : recentToolCount > 0
              ? 'recent'
                : hasToolSummary
                  ? 'summary'
                  : 'none',
        },
      };
    } catch {
      return {
        orderedEntries: [],
        activeChatCompactionId: null,
        activeToolSummaryId: null,
        stats: {
          totalTokens: 0,
          recentTokens: 0,
          summaryTokens: 0,
          recallTokens: 0,
          recentChatTokens: 0,
          recentToolTokens: 0,
          memoryRecallTokens: 0,
          compactedSummaryTokens: 0,
          recentChatCount: 0,
          recentToolCount: 0,
          memoryRecallCount: 0,
          compactedSummaryCount: 0,
          toolContextMode: 'none',
        },
      };
    }
  })();
  const promptEntries = laneSelection.orderedEntries;
  try {
    await recordMemoryRecallEvents(chatJid, promptEntries);
  } catch {
    /* recall audit must not block prompt assembly */
  }
  try {
    await updateMemoryPromptStats({
      scope: chatJid,
      lastAssembledTokenEstimate: laneSelection.stats.totalTokens,
      lastRecentTokens: laneSelection.stats.recentTokens,
      lastSummaryTokens: laneSelection.stats.summaryTokens,
      lastRecallTokens: laneSelection.stats.recallTokens,
      lastRecentChatTokens: laneSelection.stats.recentChatTokens,
      lastRecentToolTokens: laneSelection.stats.recentToolTokens,
      lastMemoryRecallTokens: laneSelection.stats.memoryRecallTokens,
      lastCompactedSummaryTokens: laneSelection.stats.compactedSummaryTokens,
      lastRecentChatCount: laneSelection.stats.recentChatCount,
      lastRecentToolCount: laneSelection.stats.recentToolCount,
      lastMemoryRecallCount: laneSelection.stats.memoryRecallCount,
      lastCompactedSummaryCount: laneSelection.stats.compactedSummaryCount,
      activeChatCompactionId: laneSelection.activeChatCompactionId,
      activeToolSummaryId: laneSelection.activeToolSummaryId,
      toolContextMode: laneSelection.stats.toolContextMode,
    });
  } catch {
    /* observability writeback must not block prompt assembly */
  }
  const contextBlocks = buildPromptContextSegments(promptEntries);
  const recentContext = formatPromptContextEntries(promptEntries);
  return {
    text: recentContext ? `${recentContext}\n\n${currentMessages}` : currentMessages,
    userPrompt: currentMessages,
    contextBlocks,
  };
}

export async function assembleAgentContext(
  chatJid: string,
  sourceMessages: NewMessage[],
): Promise<string> {
  const assembled = await assembleAgentContextEnvelope(chatJid, sourceMessages);
  return assembled.text;
}

export const __testing = {
  buildPromptEntriesWithBudget,
  estimatePromptEntryTokens,
  summarizePromptEntryTokens,
};
