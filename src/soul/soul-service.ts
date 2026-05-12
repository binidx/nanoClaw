import crypto from 'crypto';

import { logger } from '../logger.js';
import {
  getUserSoul,
  upsertUserSoul,
  deleteUserSoul,
  getUserCoreMemories,
  getUserMemories,
  getUserMemoryById,
  addUserMemory,
  updateUserMemory,
  deleteUserMemory,
  touchUserMemoryAccess,
  getActivePersonaInsights,
  recordMemoryEvent,
} from '../db.js';
import { resolvePromptText } from '../prompt/prompt-service.js';
import {
  deleteUserMemoryProjection,
  projectUserMemoryToDocument,
} from '../memory/user-memory-documents.js';
import { getSoulPreset } from './soul-presets.js';
import type {
  UserSoulRecord,
  UserMemoryRecord,
  UserMemoryCategory,
  BehaviorRule,
} from '../types.js';
import { t } from '../i18n/index.js';

function generateId(): string {
  return crypto.randomUUID();
}

const SOUL_SETTING_PATTERNS = [
  /(?:我希望|我想让|请你|你要|你得|你应该|你必须).*(?:变成|成为|扮演|像|是一个|做一个|当一个)/,
  /(?:你的)?(?:性格|人格|人设|灵魂|风格|口吻|语气|说话方式).*(?:设置|改成|换成|变成|调成|设为|是)/,
  /(?:用|以).*(?:方式|风格|口吻|语气|态度).*(?:回复|说话|交流|聊天|回答)/,
  /(?:从现在开始|以后).*(?:你就是|你是|叫你|称呼你)/,
];

// ---------------------------------------------------------------------------
// Soul CRUD
// ---------------------------------------------------------------------------

export async function getSoul(userId: string): Promise<UserSoulRecord | undefined> {
  return getUserSoul(userId);
}

export interface UpsertSoulInput {
  name?: string | null;
  emoji?: string | null;
  emojiEnabled?: boolean;
  creature?: string | null;
  vibe?: string | null;
  personaPrompt?: string | null;
  tone?: string | null;
  languagePreference?: string | null;
  extraInstructions?: string | null;
  userNickname?: string | null;
  behaviorRules?: string | null;
  autoEvolve?: boolean;
  consolidationConfig?: string | null;
  enabled?: boolean;
}

export async function upsertSoul(
  userId: string,
  input: UpsertSoulInput,
): Promise<UserSoulRecord> {
  const existing = await getUserSoul(userId);
  const now = new Date().toISOString();
  const record: UserSoulRecord = {
    id: existing?.id ?? generateId(),
    user_id: userId,
    name: input.name ?? existing?.name ?? null,
    emoji: input.emoji ?? existing?.emoji ?? null,
    emoji_enabled: input.emojiEnabled !== undefined
      ? (input.emojiEnabled ? 1 : 0)
      : (existing?.emoji_enabled ?? 0),
    creature: input.creature ?? existing?.creature ?? null,
    vibe: input.vibe ?? existing?.vibe ?? null,
    persona_prompt: input.personaPrompt ?? existing?.persona_prompt ?? null,
    tone: input.tone ?? existing?.tone ?? null,
    language_preference:
      input.languagePreference ?? existing?.language_preference ?? null,
    extra_instructions:
      input.extraInstructions ?? existing?.extra_instructions ?? null,
    user_nickname:
      input.userNickname ?? existing?.user_nickname ?? null,
    behavior_rules:
      input.behaviorRules ?? existing?.behavior_rules ?? null,
    auto_evolve: input.autoEvolve !== undefined
      ? (input.autoEvolve ? 1 : 0)
      : (existing?.auto_evolve ?? 1),
    consolidation_config:
      input.consolidationConfig ?? existing?.consolidation_config ?? null,
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing?.enabled ?? 1),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  await upsertUserSoul(record);
  return record;
}

export async function applySoulPreset(
  userId: string,
  presetId: string,
): Promise<UserSoulRecord | null> {
  const preset = getSoulPreset(presetId);
  if (!preset) return null;
  return upsertSoul(userId, {
    name: preset.config.name,
    emoji: preset.config.emoji,
    emojiEnabled: preset.config.emoji_enabled,
    creature: preset.config.creature,
    vibe: preset.config.vibe,
    personaPrompt: preset.config.persona_prompt,
    tone: preset.config.tone,
    extraInstructions: preset.config.extra_instructions,
    behaviorRules: preset.config.behavior_rules,
  });
}

export async function removeSoul(userId: string): Promise<void> {
  await deleteUserSoul(userId);
}

// ---------------------------------------------------------------------------
// Tone Guide
// ---------------------------------------------------------------------------

function buildToneGuide(tone: string): string {
  const guides: Record<string, string> = {
    warm: t('soul.auto_574d9c', {}, undefined),
    witty: t('soul.auto_45a22b', {}, undefined),
    professional: t('soul.auto_bee98f', {}, undefined),
    casual: t('soul.auto_a1c5ea', {}, undefined),
    gentle: t('soul.auto_5f36cc', {}, undefined),
    energetic: t('soul.auto_60d7bd', {}, undefined),
    cool: t('soul.auto_65cf6b', {}, undefined),
    academic: t('soul.auto_e5144d', {}, undefined),
    formal: t('soul.auto_8eef8c', {}, undefined),
    playful: t('soul.auto_c01cb6', {}, undefined),
  };
  return guides[tone] || tone;
}

// ---------------------------------------------------------------------------
// Dynamic Behavior Rules
// ---------------------------------------------------------------------------

const DEFAULT_BEHAVIOR_RULES: BehaviorRule[] = [
  { id: 'tone_consistency', text: '保持语气前后一致，不要突然切换成完全不同的口吻。', enabled: true },
  { id: 'natural_persona', text: '保留自然的人设表达，不要显得机械或模板化。', enabled: true },
  { id: 'word_style', text: '尽量保持统一的用词和语气风格。', enabled: true },
  { id: 'no_break_char', text: '不要频繁打断原有语气，也不要突然转成生硬的书面腔。', enabled: true },
  { id: 'nickname_use', text: '在适当的时候自然使用用户昵称，不要过度重复。', enabled: true },
];

function buildDynamicBehaviorRules(soul: UserSoulRecord): string {
  let rules: BehaviorRule[];
  if (soul.behavior_rules) {
    try {
      rules = JSON.parse(soul.behavior_rules) as BehaviorRule[];
    } catch {
      rules = DEFAULT_BEHAVIOR_RULES;
    }
  } else {
    rules = [...DEFAULT_BEHAVIOR_RULES];
  }

  if (soul.emoji_enabled && soul.emoji) {
    rules.push({
      id: 'emoji_use',
      text: t('soul.useEmojiHint', { emoji: soul.emoji }, undefined),
      enabled: true,
    });
  }

  const activeRules = rules.filter((r) => r.enabled);
  if (activeRules.length === 0) return '';

  return activeRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
}

// ---------------------------------------------------------------------------
// Prompt Assembly (v2 with layers, insights, optional emoji)
// ---------------------------------------------------------------------------

export async function buildSoulPrompt(
  userId: string,
  chatJid?: string,
  currentMessages?: string,
): Promise<string> {
  const soul = await getUserSoul(userId);

  const memorySection = await buildMemoryPromptSection(userId, chatJid, currentMessages);
  const insightsSection = await buildInsightsPromptSection(userId);

  if (!soul || !soul.enabled) {
    const parts: string[] = [];
    if (insightsSection) parts.push(insightsSection);
    if (memorySection) parts.push(memorySection);
    if (parts.length === 0) return '';
    const disabledWrapper = await resolvePromptText({
      promptKey: 'soul.disabled_context_wrapper',
      targetUserId: userId,
      variables: { parts: parts.join('\n\n') },
    });
    return disabledWrapper.text;
  }

  const sections: string[] = [];
  const enabledIntro = await resolvePromptText({
    promptKey: 'soul.enabled_intro',
    targetUserId: userId,
  });
  sections.push(enabledIntro.text);

  const identity: string[] = [];
  if (soul.name) identity.push(t('soul.yourName', { name: soul.name }, undefined));
  if (soul.user_nickname)
    identity.push(t('soul.userNickname', { nickname: soul.user_nickname }, undefined));
  if (soul.emoji_enabled && soul.emoji)
    identity.push(t('soul.representativeSymbol', { emoji: soul.emoji }, undefined));
  if (soul.creature) identity.push(t('soul.personaImage', { creature: soul.creature }, undefined));
  if (soul.vibe) identity.push(t('soul.overallVibe', { vibe: soul.vibe }, undefined));
  if (soul.tone && soul.tone !== 'default')
    identity.push(t('soul.toneGuide', { tone: buildToneGuide(soul.tone) }, undefined));
  if (soul.language_preference) identity.push(t('soul.languagePreference', { language: soul.language_preference }, undefined));
  if (identity.length > 0) sections.push(identity.join('\n'));

  if (soul.persona_prompt?.trim()) {
    const personaSection = await resolvePromptText({
      promptKey: 'soul.persona_core_section',
      targetUserId: userId,
      variables: { personaPrompt: soul.persona_prompt.trim() },
    });
    sections.push(personaSection.text);
  }

  const behaviorSection = buildDynamicBehaviorRules(soul);
  if (behaviorSection) {
    const behaviorWrapper = await resolvePromptText({
      promptKey: 'soul.behavior_rules_section',
      targetUserId: userId,
      variables: { rules: behaviorSection },
    });
    sections.push(behaviorWrapper.text);
  }

  if (soul.extra_instructions?.trim()) {
    const extraSection = await resolvePromptText({
      promptKey: 'soul.extra_instructions_section',
      targetUserId: userId,
      variables: { extraInstructions: soul.extra_instructions.trim() },
    });
    sections.push(extraSection.text);
  }

  if (insightsSection) sections.push(insightsSection);
  if (memorySection) sections.push(memorySection);

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Persona Insights Prompt Section
// ---------------------------------------------------------------------------

async function buildInsightsPromptSection(userId: string): Promise<string> {
  try {
    const insights = await getActivePersonaInsights(userId);
    if (insights.length === 0) return '';

    const lines = insights.map((ins) => {
      const conf = Math.round(ins.confidence * 100);
      return `- ${ins.content}（置信度 ${conf}%）`;
    });

    return ['## Persona Insights', ...lines].join('\n');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Chat-based soul detection
// ---------------------------------------------------------------------------

export function detectSoulSettingIntent(message: string): boolean {
  return SOUL_SETTING_PATTERNS.some((pattern) => pattern.test(message));
}

export function extractSoulDescription(message: string): string {
  return message
    .replace(/^@\S+\s*/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Unified User Memory (per-user, DB-backed)
// ---------------------------------------------------------------------------

export interface AddUnifiedMemoryInput {
  category?: UserMemoryCategory;
  content: string;
  importance?: number;
  source?: 'manual' | 'chat_auto' | 'llm_extract' | 'agent_tool' | 'consolidation';
  scope?: 'global' | 'conversation';
  conversationId?: string;
  tier?: 'durable' | 'core';
  promotedFrom?: string;
  expiresAt?: string | null;
}

export async function listUnifiedMemories(
  userId: string,
  opts?: {
    scope?: string;
    category?: string;
    conversationId?: string;
    tier?: string;
    limit?: number;
  },
): Promise<UserMemoryRecord[]> {
  return getUserMemories(userId, opts);
}

export async function addUnifiedMemory(
  userId: string,
  input: AddUnifiedMemoryInput,
): Promise<UserMemoryRecord> {
  const now = new Date().toISOString();
  const memoryId = generateId();
  const eventId = await recordMemoryEvent({
    user_id: userId,
    scope: input.scope ?? 'global',
    action_type: 'ADD',
    target_type: 'user_memory',
    target_id: memoryId,
    conversation_id: input.conversationId ?? null,
    source_message_id: null,
    before_snapshot: null,
    after_snapshot: JSON.stringify({ content: input.content.trim().slice(0, 500) }),
    decision_reason: `source=${input.source ?? 'manual'}`,
    metadata_json: null,
  }).catch(() => null);

  const record: UserMemoryRecord = {
    id: memoryId,
    user_id: userId,
    scope: input.scope ?? 'global',
    conversation_id: input.conversationId ?? null,
    category: input.category ?? 'general',
    content: input.content.trim(),
    importance: Math.min(10, Math.max(1, input.importance ?? 5)),
    confidence: 0.5,
    source: input.source ?? 'manual',
    tier: input.tier ?? 'durable',
    promoted_from: input.promotedFrom ?? null,
    last_verified_at: null,
    source_event_id: eventId ?? null,
    valid_from: null,
    valid_to: null,
    access_count: 0,
    last_accessed_at: null,
    expires_at: input.expiresAt ?? null,
    created_at: now,
    updated_at: now,
  };
  await addUserMemory(record);
  await projectUserMemoryToDocument(record.id);
  return record;
}

export async function editUnifiedMemory(
  id: string,
  userId: string,
  updates: {
    content?: string;
    category?: string;
    importance?: number;
    scope?: string;
    tier?: string;
  },
): Promise<void> {
  const before = await getUserMemoryById(id, userId);
  await updateUserMemory(id, userId, updates);
  const after = await getUserMemoryById(id, userId);
  if (after) {
    await projectUserMemoryToDocument(id);
  }
  if (before && after) {
    await recordMemoryEvent({
      user_id: userId,
      scope: after.scope,
      action_type: 'UPDATE',
      target_type: 'user_memory',
      target_id: id,
      conversation_id: after.conversation_id,
      source_message_id: null,
      before_snapshot: JSON.stringify({
        content: before.content.slice(0, 500),
        category: before.category,
        scope: before.scope,
        tier: before.tier,
      }),
      after_snapshot: JSON.stringify({
        content: after.content.slice(0, 500),
        category: after.category,
        scope: after.scope,
        tier: after.tier,
      }),
      decision_reason: 'manual_edit',
      metadata_json: null,
    }).catch(() => '');
  }
}

export async function removeUnifiedMemory(
  id: string,
  userId: string,
): Promise<void> {
  const before = await getUserMemoryById(id, userId);
  await deleteUserMemory(id, userId);
  await deleteUserMemoryProjection(id);
  if (before) {
    await recordMemoryEvent({
      user_id: userId,
      scope: before.scope,
      action_type: 'DELETE',
      target_type: 'user_memory',
      target_id: id,
      conversation_id: before.conversation_id,
      source_message_id: null,
      before_snapshot: JSON.stringify({
        content: before.content.slice(0, 500),
        category: before.category,
        scope: before.scope,
        tier: before.tier,
      }),
      after_snapshot: null,
      decision_reason: 'manual_delete',
      metadata_json: null,
    }).catch(() => '');
  }
}

// ---------------------------------------------------------------------------
// Layered Memory Recall
// ---------------------------------------------------------------------------

const MAX_MEMORY_PROMPT_ITEMS = 25;

export async function buildMemoryPromptSection(
  userId: string,
  _chatJid?: string,
  _currentMessages?: string,
): Promise<string> {
  const allMemories = (await getUserCoreMemories(userId)).slice(0, MAX_MEMORY_PROMPT_ITEMS);

  if (allMemories.length === 0) return '';

  for (const m of allMemories) {
    touchUserMemoryAccess(m.id).catch((err) => {
      logger.debug({ err, memoryId: m.id }, 'Failed to touch memory access time');
    });
  }

  const parts: string[] = ['## Memory'];

  // Core memories
  const coreLines = allMemories
    .filter((m) => m.tier === 'core')
    .map((m) => `- [${m.category}] ${m.content}`);
  if (coreLines.length > 0) {
    parts.push(['### Core Memories', ...coreLines].join('\n'));
  }

  parts.push('Long-term or topic-specific memory should be queried with tools when needed.');

  return parts.join('\n');
}
