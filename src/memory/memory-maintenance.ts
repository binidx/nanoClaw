import { logger } from '../logger.js';
import {
  buildDirectProviderPromptEnvelope,
  resolvePromptText,
} from '../prompt/prompt-service.js';
import {
  getUserMemories,
  updateUserMemory,
  deleteUserMemory,
  recordMemoryEvent,
} from '../db.js';
import { generateTextWithDefaultProvider } from '../provider/provider-api.js';
import type { UserMemoryRecord } from '../types.js';
import { t } from '../i18n/index.js';

const MERGE_BATCH_SIZE = 50;
const MERGE_SIMILARITY_PROMPT = t('prompts.memoryMergePrompt', {}, undefined);

/**
 * Run periodic memory maintenance for a user:
 * LLM-assisted merge of semantically duplicate memories within each category.
 * Eviction is handled separately by the caller to avoid redundant global scans.
 */
export async function runMemoryMaintenance(userId: string): Promise<{
  merged: number;
}> {
  let merged = 0;

  try {
    merged = await mergeOverlappingMemories(userId);
  } catch (err) {
    logger.warn({ err, userId }, 'Memory merge failed');
  }

  if (merged > 0) {
    logger.info({ userId, merged }, 'Memory maintenance completed');
  }

  return { merged };
}

async function mergeOverlappingMemories(userId: string): Promise<number> {
  const all = await getUserMemories(userId, { limit: 200 });
  if (all.length < 2) return 0;

  const byCategory = new Map<string, UserMemoryRecord[]>();
  for (const m of all) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m);
    byCategory.set(m.category, list);
  }

  let totalMerged = 0;

  for (const [category, memories] of byCategory.entries()) {
    if (memories.length < 2) continue;

    const batch = memories.slice(0, MERGE_BATCH_SIZE);
    const memorySummary = batch
      .map((m) => `- id="${m.id}" content="${m.content}" importance=${m.importance}`)
      .join('\n');

    const prompt = `${MERGE_SIMILARITY_PROMPT}\n\n' + t('prompts.categoryLabel', { category }, undefined) + '\n' + t('prompts.memoryListLabel', {}, undefined) + '\n${memorySummary}`;
    const resolvedPrompt = await resolvePromptText({
      promptKey: 'memory.merge_similarity',
      targetUserId: userId,
      variables: {
        category,
        memorySummary,
      },
      fallbackText: prompt,
    });

    try {
      const directPrompt = buildDirectProviderPromptEnvelope({
        userPrompt: resolvedPrompt.text,
      });
      const raw = await generateTextWithDefaultProvider(resolvedPrompt.text, {
        promptTrace: {
          promptKey: 'memory.merge_similarity',
          featureScope: 'memory',
          targetUserId: userId,
          stableSystemPrompt: directPrompt.envelope.stableSystemPrompt,
          volatileSystemPrompt: directPrompt.envelope.volatileSystemPrompt,
          contextBlocks: directPrompt.envelope.contextBlocks,
          userPromptText: directPrompt.envelope.userPrompt,
          providerInputText: directPrompt.envelope.providerInputText,
          segments: directPrompt.segments,
          stablePrefixFingerprint: directPrompt.envelope.stablePrefixFingerprint || null,
          cacheFingerprint: directPrompt.envelope.cacheFingerprint || null,
          metadata: {
            category,
            batchSize: batch.length,
          },
        },
      });
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;

      const merges = JSON.parse(jsonMatch[0]) as Array<{
        keep_id: string;
        remove_id: string;
        merged_content: string;
      }>;

      const validIds = new Set(batch.map((m) => m.id));

      for (const merge of merges) {
        if (!validIds.has(merge.keep_id) || !validIds.has(merge.remove_id)) continue;
        if (merge.keep_id === merge.remove_id) continue;

        const keepMemory = batch.find((m) => m.id === merge.keep_id);
        const removeMemory = batch.find((m) => m.id === merge.remove_id);
        if (!keepMemory || !removeMemory) continue;

        const mergedContent = merge.merged_content || keepMemory.content;
        await updateUserMemory(merge.keep_id, userId, {
          content: mergedContent,
          importance: Math.max(keepMemory.importance, removeMemory.importance),
          confidence: Math.min(1.0, Math.max(keepMemory.confidence ?? 0.5, removeMemory.confidence ?? 0.5) + 0.1),
        });
        await deleteUserMemory(merge.remove_id, userId);
        validIds.delete(merge.remove_id);
        totalMerged++;
        recordMemoryEvent({
          user_id: userId,
          scope: 'global',
          action_type: 'MERGE',
          target_type: 'user_memory',
          target_id: merge.keep_id,
          conversation_id: null,
          source_message_id: null,
          before_snapshot: JSON.stringify({ keep: keepMemory.content, remove: removeMemory.content }),
          after_snapshot: JSON.stringify({ content: mergedContent }),
          decision_reason: 'llm_merge_duplicate',
          metadata_json: JSON.stringify({ removed_id: merge.remove_id, category }),
        }).catch((err) => {
          logger.debug({ err }, 'Failed to record memory merge event');
        });
      }
    } catch (err) {
      logger.warn({ err, category, userId }, 'Memory merge LLM call failed for category');
    }
  }

  return totalMerged;
}

/**
 * Check if maintenance should run based on memory count threshold.
 */
export async function shouldRunMaintenance(
  userId: string,
  threshold = 100,
): Promise<boolean> {
  const memories = await getUserMemories(userId, { limit: threshold + 1 });
  return memories.length > threshold;
}
