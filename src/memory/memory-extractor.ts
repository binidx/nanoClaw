import crypto from 'crypto';

import { generateTextWithDefaultProvider } from '../provider/provider-api.js';
import { t } from '../i18n/index.js';
import {
  addUserMemory,
  findSimilarUserMemories,
  updateUserMemory,
  addMemoryExtractionLog,
  addUserMemoryObservation,
  findSimilarObservations,
  updateUserMemoryObservation,
  addPersonaInsight,
  findSimilarInsights,
  updatePersonaInsight,
  getUserSoul,
  recordMemoryEvent,
} from '../db.js';
import { logger } from '../logger.js';
import { resolvePromptText } from '../prompt/prompt-service.js';
import type {
  UserMemoryRecord,
  UserMemoryCategory,
  UserMemoryObservationRecord,
  PersonaInsightRecord,
  ObservationType,
  InsightType,
  MemoryExtractionLogRecord,
} from '../types.js';

// ---------------------------------------------------------------------------
// Regex pre-filter: cheap first pass before calling LLM
// ---------------------------------------------------------------------------

const MEMORY_CANDIDATE_PATTERNS = [
  /(?:我叫|我是|我的名字|叫我|称呼我|我姓)/,
  /(?:我喜欢|我不喜欢|我偏好|我讨厌|我爱|我恨)/,
  /(?:我习惯|我一般|我通常|我每天|我经常|我总是)/,
  /(?:我有|我养了|我住在|我在.{1,6}工作|我家)/,
  /(?:我会|我不会|我擅长|我不懂|我学过|我做过)/,
  /(?:记住|别忘了|以后|从现在开始|你要记得)/,
  /(?:我的(?:同事|老板|朋友|老婆|老公|女朋友|男朋友|孩子))/,
  /(?:我(?:\d{1,2}岁|今年|出生))/,
];

const INTERACTION_PATTERN_SIGNALS = [
  /(?:不要|别|少).{0,6}(?:废话|啰嗦|表情|emoji|颜文字)/,
  /(?:简洁|简短|直接|省略).{0,6}(?:一点|些|点)/,
  /(?:详细|展开|多说|解释).{0,6}(?:一点|些|点)/,
  /(?:你说的|回答).{0,6}(?:太长|太短|太啰嗦|太简单)/,
  /(?:喜欢|偏好|希望).{0,6}(?:你|AI|助手).{0,6}(?:方式|风格|语气)/,
  /(?:能不能|可以|请).{0,6}(?:用|以).{0,6}(?:方式|风格|口吻)/,
];

export function shouldExtractMemory(message: string): boolean {
  const clean = message.replace(/^@\S+\s*/, '').trim();
  if (!clean || clean.length < 4) return false;
  return MEMORY_CANDIDATE_PATTERNS.some((p) => p.test(clean))
    || INTERACTION_PATTERN_SIGNALS.some((p) => p.test(clean));
}

// ---------------------------------------------------------------------------
// LLM extraction (enhanced: facts + interaction patterns)
// ---------------------------------------------------------------------------

interface ExtractedFact {
  type: 'fact';
  category: UserMemoryCategory;
  content: string;
  importance: number;
  reasoning: string;
}

interface ExtractedInsight {
  type: 'insight';
  insight_type: InsightType;
  content: string;
  reasoning: string;
}

type ExtractedItem = ExtractedFact | ExtractedInsight;

const EXTRACTION_PROMPT = t('prompts.memoryExtractionPrompt', {}, undefined);

export async function extractFromMessages(
  messages: string[],
  existingContext: string,
): Promise<ExtractedItem[]> {
  const userInput = messages.join('\n---\n');
  const prompt = `${EXTRACTION_PROMPT}${existingContext}\n\n' + t('prompts.userMessageLabel', {}, undefined) + '\n${userInput}`;
  const resolvedPrompt = await resolvePromptText({
    promptKey: 'memory.extractor',
    variables: {
      existingContext,
      userInput,
    },
    fallbackText: prompt,
  });

  try {
    const raw = await generateTextWithDefaultProvider(resolvedPrompt.text, {
      promptTrace: {
        promptKey: 'memory.extractor',
        featureScope: 'memory',
        metadata: {
          messageCount: messages.length,
        },
      },
    });
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    return parsed
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && 'type' in item,
      )
      .map((item): ExtractedItem | null => {
        if (item.type === 'fact' && 'category' in item && 'content' in item) {
          return {
            type: 'fact',
            category: validateCategory(String(item.category)),
            content: String(item.content).trim(),
            importance: Math.min(10, Math.max(1, Number(item.importance) || 5)),
            reasoning: String(item.reasoning || ''),
          };
        }
        if (item.type === 'insight' && 'insight_type' in item && 'content' in item) {
          return {
            type: 'insight',
            insight_type: validateInsightType(String(item.insight_type)),
            content: String(item.content).trim(),
            reasoning: String(item.reasoning || ''),
          };
        }
        return null;
      })
      .filter((item): item is ExtractedItem => item !== null && item.content.length > 0);
  } catch (err) {
    logger.warn({ err }, 'Memory extraction LLM call failed');
    return [];
  }
}

function validateCategory(cat: string): UserMemoryCategory {
  const valid: UserMemoryCategory[] = [
    'identity', 'preference', 'habit', 'fact', 'skill', 'relationship', 'general',
  ];
  return valid.includes(cat as UserMemoryCategory)
    ? (cat as UserMemoryCategory)
    : 'general';
}

function validateInsightType(t: string): InsightType {
  const valid: InsightType[] = [
    'communication_style', 'response_preference', 'topic_depth',
    'humor_tolerance', 'formality_level', 'emoji_preference',
  ];
  return valid.includes(t as InsightType)
    ? (t as InsightType)
    : 'communication_style';
}

function mapCategoryToObservationType(category: UserMemoryCategory): ObservationType {
  if (category === 'preference') return 'preference_signal';
  if (category === 'habit') return 'interaction_pattern';
  return 'fact';
}

// ---------------------------------------------------------------------------
// Merge extracted items into DB
// ---------------------------------------------------------------------------

function contentOverlaps(existing: string, incoming: string): boolean {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[，。、！？\s]/g, '');
  const a = normalize(existing);
  const b = normalize(incoming);
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  return a.includes(b) || b.includes(a);
}

async function mergeFactAsObservation(
  userId: string,
  fact: ExtractedFact,
  conversationId?: string,
): Promise<void> {
  const now = new Date().toISOString();
  const similar = await findSimilarObservations(userId, fact.category, fact.content);
  const match = similar.find((o) => contentOverlaps(o.content, fact.content));

  if (match) {
    await updateUserMemoryObservation(match.id, userId, {
      frequency: match.frequency + 1,
      confidence: Math.min(1.0, match.confidence + 0.1),
      last_seen_at: now,
      content: fact.content,
    });
  } else {
    const record: UserMemoryObservationRecord = {
      id: crypto.randomUUID(),
      user_id: userId,
      conversation_id: conversationId ?? null,
      category: fact.category,
      content: fact.content,
      observation_type: mapCategoryToObservationType(fact.category),
      frequency: 1,
      last_seen_at: now,
      confidence: 0.3 + (fact.importance >= 8 ? 0.3 : fact.importance >= 5 ? 0.1 : 0),
      source: 'llm_extract',
      promoted_to: null,
      expires_at: null,
      created_at: now,
      updated_at: now,
    };
    await addUserMemoryObservation(record);
  }
}

async function mergeInsight(
  userId: string,
  insight: ExtractedInsight,
): Promise<void> {
  const now = new Date().toISOString();
  const similar = await findSimilarInsights(userId, insight.insight_type, insight.content);
  const match = similar.find((i) => contentOverlaps(i.content, insight.content));

  if (match) {
    await updatePersonaInsight(match.id, userId, {
      evidence_count: match.evidence_count + 1,
      confidence: Math.min(1.0, match.confidence + 0.15),
      content: insight.content,
    });
  } else {
    const record: PersonaInsightRecord = {
      id: crypto.randomUUID(),
      user_id: userId,
      insight_type: insight.insight_type,
      content: insight.content,
      evidence_count: 1,
      confidence: 0.3,
      status: 'candidate',
      created_at: now,
      updated_at: now,
    };
    await addPersonaInsight(record);
  }
}

export async function mergeExtractedItems(
  userId: string,
  items: ExtractedItem[],
  conversationId?: string,
): Promise<{ facts: number; insights: number }> {
  let facts = 0;
  let insights = 0;

  for (const item of items) {
    try {
      if (item.type === 'fact') {
        await mergeFactAsObservation(userId, item, conversationId);
        facts++;
      } else {
        await mergeInsight(userId, item);
        insights++;
      }
    } catch (err) {
      logger.warn({ err, content: item.content }, 'Failed to save extracted item');
    }
  }

  return { facts, insights };
}

// ---------------------------------------------------------------------------
// Legacy compat: still export for callers using old API
// ---------------------------------------------------------------------------

/** @deprecated Use extractFromMessages + mergeExtractedItems instead */
export async function extractMemoriesFromMessages(
  messages: string[],
  existingMemories: UserMemoryRecord[],
): Promise<ExtractedFact[]> {
  const existingSummary = existingMemories.length > 0
    ? t('prompts.existingMemoriesHeader', {}, undefined) + '\n' + existingMemories.map((m) => `- [${m.category}] ${m.content}`).join('\n')
    : '';
  const items = await extractFromMessages(messages, existingSummary);
  return items.filter((i): i is ExtractedFact => i.type === 'fact');
}

/** @deprecated Use mergeExtractedItems instead */
export async function mergeExtractedMemories(
  userId: string,
  extracted: ExtractedFact[],
  conversationId?: string,
): Promise<number> {
  let saved = 0;
  for (const item of extracted) {
    try {
      const similar = await findSimilarUserMemories(userId, item.category, item.content);
      const match = similar.find((m) => contentOverlaps(m.content, item.content));

      if (match) {
        const boostedConfidence = Math.min(1.0, (match.confidence ?? 0.5) + 0.15);
        await updateUserMemory(match.id, userId, {
          content: item.content,
          importance: Math.max(match.importance, item.importance),
          confidence: boostedConfidence,
        });
      } else {
        const now = new Date().toISOString();
        const eventId = await recordMemoryEvent({
          user_id: userId,
          scope: 'global',
          action_type: 'ADD',
          target_type: 'user_memory',
          target_id: null,
          conversation_id: conversationId ?? null,
          source_message_id: null,
          before_snapshot: null,
          after_snapshot: JSON.stringify({ content: item.content.slice(0, 500) }),
          decision_reason: 'llm_extract',
          metadata_json: JSON.stringify({ category: item.category }),
        }).catch(() => null);
        const record: UserMemoryRecord = {
          id: crypto.randomUUID(),
          user_id: userId,
          scope: 'global',
          conversation_id: conversationId ?? null,
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
      logger.warn({ err, content: item.content }, 'Failed to save extracted memory');
    }
  }
  return saved;
}

// ---------------------------------------------------------------------------
// Full extraction pipeline (called from message processing)
// ---------------------------------------------------------------------------

export async function runMemoryExtraction(
  userId: string,
  messages: Array<{ id?: string; content: string }>,
  conversationId?: string,
): Promise<void> {
  const texts = messages
    .map((m) => m.content.replace(/^@\S+\s*/, '').trim())
    .filter((t) => t.length > 0);

  if (texts.length === 0) return;
  if (!texts.some(shouldExtractMemory)) return;

  // Check if auto_evolve is enabled for this user
  const soul = await getUserSoul(userId);
  const autoEvolve = soul?.auto_evolve !== 0;

  const { getUserMemories } = await import('../db.js');
  const existingMemories = await getUserMemories(userId, { limit: 30 });
  const existingSummary = existingMemories.length > 0
    ? t('prompts.existingMemoriesHeader', {}, undefined) + '\n' + existingMemories.map((m) => `- [${m.category}] ${m.content}`).join('\n')
    : '';

  const items = await extractFromMessages(texts, existingSummary);
  if (items.length === 0) return;

  // Filter out insights if auto_evolve is off
  const filteredItems = autoEvolve
    ? items
    : items.filter((i) => i.type === 'fact');

  const result = await mergeExtractedItems(userId, filteredItems, conversationId);

  const logRecord: MemoryExtractionLogRecord = {
    id: crypto.randomUUID(),
    user_id: userId,
    conversation_id: conversationId ?? null,
    source_message_ids: JSON.stringify(
      messages.map((m) => m.id).filter(Boolean),
    ),
    extracted_memories: JSON.stringify(items),
    model_used: null,
    tokens_used: null,
    created_at: new Date().toISOString(),
  };
  await addMemoryExtractionLog(logRecord).catch((err) => {
    logger.debug({ err, userId }, 'Failed to write memory extraction log');
  });

  logger.info(
    { userId, facts: result.facts, insights: result.insights, conversationId },
    'Memory extraction completed',
  );
}
