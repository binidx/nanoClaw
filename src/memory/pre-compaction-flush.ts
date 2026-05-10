import { generateTextWithDefaultProvider } from '../provider/provider-api.js';
import { logger } from '../logger.js';
import { resolvePromptText } from '../prompt/prompt-service.js';
import { getConfigValue } from '../config-store.js';
import { isFeatureEnabled } from '../auth/web-security.js';
import type { ContextEntryRecord, UserMemoryRecord, UserMemoryCategory } from '../types.js';
import {
  addUserMemory,
  findSimilarUserMemories,
  updateUserMemory,
  getUserMemories,
  recordMemoryEvent,
} from '../db.js';
import { searchKnowledge } from '../knowledge/retrieval.js';
import { listKnowledgeBases } from '../db/assistants.js';
import { listEnabledKbIdsForUser } from '../knowledge/user-kb-service.js';
import { resolveEmbeddingProvider } from '../embedding/resolve.js';
import { embedAndStore } from '../embedding/vector-store.js';
import crypto from 'crypto';
import { t } from '../i18n/index.js';

import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';

const FLUSH_TIMEOUT_MS = 30_000;

const FLUSH_PROMPT = t('prompts.memoryFlushPrompt', {}, undefined);

const VALID_CATEGORIES: UserMemoryCategory[] = [
  'identity', 'preference', 'habit', 'fact', 'skill', 'relationship', 'general',
];

function validateCategory(cat: string): UserMemoryCategory {
  return VALID_CATEGORIES.includes(cat as UserMemoryCategory)
    ? (cat as UserMemoryCategory)
    : 'general';
}

function contentOverlaps(existing: string, incoming: string): boolean {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[，。、！？\s]/g, '');
  const a = normalize(existing);
  const b = normalize(incoming);
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  return a.includes(b) || b.includes(a);
}

function formatEntriesForFlush(entries: ContextEntryRecord[]): string {
  return entries.map((entry) => {
    const speaker = entry.role === 'assistant' ? 'assistant' : 'user';
    const text = String(entry.content_text || '').replace(/\s+/g, ' ').trim();
    const clipped = text.length <= 300 ? text : `${text.slice(0, 300)}...`;
    return `[${speaker}] ${clipped}`;
  }).join('\n');
}

export async function isFlushEnabled(): Promise<boolean> {
  const val = await getConfigValue('MEMORY_PRE_COMPACTION_FLUSH_ENABLED');
  if (!val) return true;
  return isFeatureEnabled(val);
}

/**
 * Run pre-compaction memory flush: extract durable memories from entries
 * that are about to be compressed, and save them to user_memories.
 */
export async function runPreCompactionFlush(
  chatJid: string,
  entries: ContextEntryRecord[],
): Promise<number> {
  if (entries.length === 0) return 0;
  if (!(await isFlushEnabled())) return 0;

  const userEntries = entries.filter((e) => e.role === 'user');
  if (userEntries.length === 0) return 0;

  const userId = await resolveUserIdFromEntries(entries);
  if (!userId) {
    logger.debug({ chatJid }, 'pre-compaction flush: no user_id resolved, skipping');
    return 0;
  }

  const conversationText = formatEntriesForFlush(entries);
  const existingMemories = await getUserMemories(userId, { limit: 30 });
  const existingSummary = existingMemories.length > 0
    ? t('prompts.knownMemoriesHeader', {}, undefined) + '\n' + existingMemories.map((m) => `- [${m.category}] ${m.content}`).join('\n')
    : '';

  const prompt = `${FLUSH_PROMPT}${existingSummary}\n\n' + t('prompts.conversationContentLabel', {}, undefined) + '\n${conversationText}`;
  const resolvedPrompt = await resolvePromptText({
    promptKey: 'memory.pre_compaction_flush',
    targetUserId: userId,
    variables: {
      existingSummary,
      conversationText,
    },
    fallbackText: prompt,
  });

  try {
    const raw = await Promise.race([
      generateTextWithDefaultProvider(resolvedPrompt.text, {
        promptTrace: {
          promptKey: 'memory.pre_compaction_flush',
          featureScope: 'memory',
          targetUserId: userId,
          chatJid,
          metadata: {
            entryCount: entries.length,
          },
        },
      }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('flush timeout')), FLUSH_TIMEOUT_MS),
      ),
    ]);

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return 0;

    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    const items = parsed
      .filter(
        (item): item is { category: string; content: string; importance: number } =>
          typeof item === 'object' &&
          item !== null &&
          'content' in item &&
          'importance' in item,
      )
      .map((item) => ({
        category: validateCategory(String((item as { category?: string }).category || 'general')),
        content: String(item.content).trim(),
        importance: Math.min(10, Math.max(1, Number(item.importance) || 5)),
      }))
      .filter((item) => item.content.length > 0);

    if (items.length === 0) return 0;

    let saved = 0;
    for (const item of items) {
      try {
        const similar = await findSimilarUserMemories(userId, item.category, item.content);
        const match = similar.find((m) => contentOverlaps(m.content, item.content));

        if (match) {
          await updateUserMemory(match.id, userId, {
            content: item.content,
            importance: Math.max(match.importance, item.importance),
          });
        } else {
          const now = new Date().toISOString();
          const eventId = await recordMemoryEvent({
            user_id: userId,
            scope: 'global',
            action_type: 'ADD',
            target_type: 'user_memory',
            target_id: null,
            conversation_id: chatJid,
            source_message_id: null,
            before_snapshot: null,
            after_snapshot: JSON.stringify({ content: item.content.slice(0, 500) }),
            decision_reason: 'pre_compaction_flush',
            metadata_json: JSON.stringify({ category: item.category }),
          }).catch(() => null);
          const record: UserMemoryRecord = {
            id: crypto.randomUUID(),
            user_id: userId,
            scope: 'global',
            conversation_id: chatJid,
            category: item.category,
            content: item.content,
            importance: item.importance,
            confidence: 0.5,
            source: 'llm_extract',
            tier: 'durable',
            promoted_from: null,
            last_verified_at: null,
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
        }
        saved++;
      } catch (err) {
        logger.warn({ err, contentLength: item.content?.length ?? 0 }, 'pre-compaction flush: failed to save memory');
      }
    }

    // Embed newly saved memories for vector search
    try {
      const provider = await resolveEmbeddingProvider();
      if (provider) {
        const allMems = await getUserMemories(userId, { limit: 50 });
        const recentMems = allMems.filter(
          (m) => m.created_at > new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        );
        for (const m of recentMems) {
          await embedAndStore('memory', m.id, m.content, provider);
        }
      }
    } catch {
      // embedding is optional
    }

    // Cross-reference with knowledge base (scoped to user-visible KBs)
    try {
      const topic = items.map((i) => i.content).join(' ').slice(0, 200);
      const allKbs = await listKnowledgeBases();
      const userBindings = userId ? new Set(await listEnabledKbIdsForUser(userId)) : new Set<string>();
      const visibleKbIds = allKbs
        .filter((kb) => kb.enabled && (
          userBindings.has(kb.id) ||
          kb.user_id === userId ||
          kb.user_id === SYSTEM_USER_ID ||
          kb.visibility === 'shared'
        ))
        .map((kb) => kb.id);
      const kbResults = await searchKnowledge(topic, { kbIds: visibleKbIds, topK: 2, minScore: 0.5 });
      if (kbResults.chunks.length > 0) {
        logger.debug(
          { chatJid, kbMatches: kbResults.chunks.length },
          'Pre-compaction found relevant knowledge base entries',
        );
      }
    } catch {
      // knowledge cross-reference is optional
    }

    logger.info(
      { chatJid, extracted: items.length, saved },
      'Pre-compaction memory flush completed',
    );
    return saved;
  } catch (err) {
    logger.warn({ err, chatJid }, 'Pre-compaction memory flush failed');
    return 0;
  }
}

async function resolveUserIdFromEntries(
  entries: ContextEntryRecord[],
): Promise<string | null> {
  const { getUserByUsername } = await import('../user/user-service.js');

  for (const entry of entries) {
    if (entry.role !== 'user') continue;
    const ref = entry.source_ref;
    if (!ref) continue;
    const user = await getUserByUsername(ref);
    if (user) return user.id;
  }

  return null;
}
