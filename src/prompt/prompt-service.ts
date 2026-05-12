import crypto from 'crypto';

import {
  deletePromptConfig,
  getPromptConfig,
  recordPromptTrace as persistPromptTrace,
  upsertPromptConfig,
} from '../db/prompt-configs.js';
import { getPromptDefinition } from './prompt-registry.js';
import type {
  CompiledPromptEnvelope,
  PromptConfigRecord,
  PromptCacheSection,
  PromptLayer,
  PromptPreviewEnvelope,
  PromptScopeKind,
  PromptSegment,
  PromptTraceInput,
} from '../types/prompt.js';

const OBSOLETE_REPO_REVIEW_VARIABLES = [
  'diffText',
  'filteredDiff',
  'diffStats',
  'projectContextBlock',
  'fileDiff',
  'fileContent',
];

function templateUsesVariable(template: string, variableName: string): boolean {
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`).test(template);
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function normalizeFingerprintText(value: string | null | undefined): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function inferSegmentLayer(segment: PromptSegment): PromptLayer {
  if (segment.layer) return segment.layer;
  if (segment.source === 'conversation_context') return 'context_runtime';
  if (segment.source === 'context_summary') return 'context_runtime';
  if (segment.source === 'context_recent') return 'context_runtime';
  if (segment.source === 'upload_context') return 'context_runtime';
  if (segment.source === 'memory_recall_tool') return 'context_memory';
  if (segment.source === 'memory_recall_session') return 'context_memory';
  if (segment.source === 'memory') return 'context_memory';
  if (segment.source === 'assistant_config') return 'system_persona';
  if (segment.source === 'soul') return 'system_persona';
  if (segment.source === 'custom') return 'system_policy';
  return 'system_base';
}

function inferSegmentCacheSection(segment: PromptSegment): PromptCacheSection {
  if (segment.cacheSection) return segment.cacheSection;
  const layer = inferSegmentLayer(segment);
  if (
    layer === 'system_base' ||
    layer === 'system_persona' ||
    layer === 'system_policy' ||
    layer === 'system_tools'
  ) {
    return 'stable';
  }
  return 'volatile';
}

function normalizeSegmentsForFingerprint(segments: PromptSegment[] = []): string {
  return JSON.stringify(
    segments.map((segment) => ({
      id: segment.id,
      layer: inferSegmentLayer(segment),
      cacheSection: inferSegmentCacheSection(segment),
      source: segment.source,
      promptKey: segment.promptKey || null,
      content: normalizeFingerprintText(segment.content),
    })),
  );
}

function buildCombinedSystemPrompt(input: {
  stableSystemPrompt?: string | null;
  volatileSystemPrompt?: string | null;
  systemPromptText?: string | null;
}): {
  stableSystemPrompt: string;
  volatileSystemPrompt: string;
  systemPromptText: string;
} {
  const stableSystemPrompt = normalizeFingerprintText(
    input.stableSystemPrompt ?? input.systemPromptText,
  );
  const volatileSystemPrompt = normalizeFingerprintText(input.volatileSystemPrompt);
  const systemPromptText =
    input.systemPromptText !== undefined && input.systemPromptText !== null
      ? normalizeFingerprintText(input.systemPromptText)
      : [stableSystemPrompt, volatileSystemPrompt].filter(Boolean).join('\n\n');
  return {
    stableSystemPrompt,
    volatileSystemPrompt,
    systemPromptText,
  };
}

export function buildPromptFingerprintMeta(input: {
  stableSystemPrompt?: string | null;
  volatileSystemPrompt?: string | null;
  systemPromptText?: string | null;
  userPromptText: string;
  providerInputText?: string | null;
  segments?: PromptSegment[];
}): {
  stablePrefixFingerprint: string;
  cacheFingerprint: string;
} {
  const systemParts = buildCombinedSystemPrompt(input);
  const userPromptText = normalizeFingerprintText(input.userPromptText);
  const providerInputText = normalizeFingerprintText(input.providerInputText);
  const segments = normalizeSegmentsForFingerprint(input.segments || []);
  const stablePrefixFingerprint = sha256(systemParts.stableSystemPrompt);
  const cacheFingerprint = sha256(
    [
      systemParts.stableSystemPrompt,
      systemParts.volatileSystemPrompt,
      providerInputText || userPromptText,
      userPromptText,
      segments,
    ].join('\n---\n'),
  );
  return { stablePrefixFingerprint, cacheFingerprint };
}

export function buildCompiledPromptEnvelope(input: {
  stableSystemPrompt?: string | null;
  volatileSystemPrompt?: string | null;
  contextBlocks?: PromptSegment[];
  userPrompt: string;
  providerInputText?: string | null;
  segments?: PromptSegment[];
}): CompiledPromptEnvelope {
  const systemParts = buildCombinedSystemPrompt({
    stableSystemPrompt: input.stableSystemPrompt,
    volatileSystemPrompt: input.volatileSystemPrompt,
  });
  const contextBlocks = [...(input.contextBlocks || [])];
  const providerInputText =
    input.providerInputText != null
      ? String(input.providerInputText)
      : input.userPrompt;
  const fingerprints = buildPromptFingerprintMeta({
    stableSystemPrompt: systemParts.stableSystemPrompt,
    volatileSystemPrompt: systemParts.volatileSystemPrompt,
    userPromptText: input.userPrompt,
    providerInputText,
    segments: input.segments || contextBlocks,
  });
  return {
    stableSystemPrompt: systemParts.stableSystemPrompt,
    volatileSystemPrompt: systemParts.volatileSystemPrompt,
    systemPromptText: systemParts.systemPromptText,
    contextBlocks,
    userPrompt: input.userPrompt,
    providerInputText,
    stablePrefixFingerprint: fingerprints.stablePrefixFingerprint,
    cacheFingerprint: fingerprints.cacheFingerprint,
  };
}

export function buildDirectProviderPromptEnvelope(input: {
  stableSystemPrompt?: string | null;
  volatileSystemPrompt?: string | null;
  contextBlocks?: PromptSegment[];
  userPrompt: string;
  providerInputText?: string | null;
  taskSegments?: PromptSegment[];
}): {
  envelope: CompiledPromptEnvelope;
  segments: PromptSegment[];
} {
  const contextBlocks = [...(input.contextBlocks || [])];
  const userPromptSegment: PromptSegment = {
    id: 'direct_provider.user_prompt',
    label: 'Direct Provider User Prompt',
    layer: 'user_input',
    mutability: 'derived',
    cacheSection: 'volatile',
    source: 'conversation_context',
    content: input.userPrompt,
  };
  const segments = [
    ...(input.taskSegments || []),
    ...contextBlocks,
    userPromptSegment,
  ];
  const envelope = buildCompiledPromptEnvelope({
    stableSystemPrompt: input.stableSystemPrompt,
    volatileSystemPrompt: input.volatileSystemPrompt,
    contextBlocks,
    userPrompt: input.userPrompt,
    providerInputText: input.providerInputText ?? input.userPrompt,
    segments,
  });
  return { envelope, segments };
}

export function isPromptConfigTemplateCompatible(
  promptKey: string,
  template: string,
): boolean {
  if (!promptKey.startsWith('repo_review.')) return true;
  return !OBSOLETE_REPO_REVIEW_VARIABLES.some((variable) =>
    templateUsesVariable(template, variable),
  );
}

function stringifyPromptVariable(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === 'string')
      ? value.join('\n')
      : JSON.stringify(value, null, 2);
  }
  return JSON.stringify(value, null, 2);
}

export function renderPromptTemplate(
  template: string,
  variables: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_full, key) =>
    stringifyPromptVariable(variables[key]),
  );
}

export async function resolvePromptText(input: {
  promptKey: string;
  targetUserId?: string | null;
  variables?: Record<string, unknown>;
  fallbackText?: string;
}): Promise<{
  text: string;
  resolution: {
    promptKey: string;
    featureScope: string;
    source: 'builtin' | 'system_default' | 'user_override';
    ownerUserId: string;
    configured: boolean;
  };
  config: PromptConfigRecord | null;
}> {
  const definition = getPromptDefinition(input.promptKey);
  const ownerUserId = input.targetUserId?.trim() || '';
  const variables = input.variables || {};

  let config: PromptConfigRecord | null = null;
  try {
    if (ownerUserId) {
      const userConfig = await getPromptConfig('user', ownerUserId, input.promptKey);
      if (
        userConfig &&
        isPromptConfigTemplateCompatible(input.promptKey, userConfig.template_text)
      ) {
        config = userConfig;
      }
    }
    if (!config) {
      const systemConfig = await getPromptConfig('system', '', input.promptKey);
      if (
        systemConfig &&
        isPromptConfigTemplateCompatible(input.promptKey, systemConfig.template_text)
      ) {
        config = systemConfig;
      }
    }
  } catch {
    config = null;
  }

  let source: 'builtin' | 'system_default' | 'user_override' = 'builtin';
  let template = input.fallbackText || definition?.defaultTemplate || '';
  if (config) {
    template = config.template_text;
    source = config.scope_kind === 'user' ? 'user_override' : 'system_default';
  }

  return {
    text: renderPromptTemplate(template, variables),
    config,
    resolution: {
      promptKey: input.promptKey,
      featureScope: definition?.featureScope || 'unknown',
      source,
      ownerUserId: config?.owner_user_id || '',
      configured: Boolean(config),
    },
  };
}

export async function savePromptConfig(input: {
  scopeKind: PromptScopeKind;
  ownerUserId?: string | null;
  promptKey: string;
  featureScope: string;
  templateText: string;
  notes?: string | null;
}): Promise<PromptConfigRecord> {
  return upsertPromptConfig({
    scopeKind: input.scopeKind,
    ownerUserId:
      input.scopeKind === 'system' ? '' : input.ownerUserId?.trim() || '',
    promptKey: input.promptKey,
    featureScope: input.featureScope,
    templateText: input.templateText,
    notes: input.notes ?? null,
  });
}

export async function removePromptConfig(input: {
  scopeKind: PromptScopeKind;
  ownerUserId?: string | null;
  promptKey: string;
}): Promise<void> {
  await deletePromptConfig(
    input.scopeKind,
    input.scopeKind === 'system' ? '' : input.ownerUserId?.trim() || '',
    input.promptKey,
  );
}

export function buildPromptPreviewEnvelope(input: PromptPreviewEnvelope): PromptPreviewEnvelope {
  const systemParts = buildCombinedSystemPrompt(input);
  const fingerprints = buildPromptFingerprintMeta({
    stableSystemPrompt: systemParts.stableSystemPrompt,
    volatileSystemPrompt: systemParts.volatileSystemPrompt,
    userPromptText: input.userPromptText,
    providerInputText: input.providerInputText ?? null,
    segments: input.segments,
  });
  return {
    ...input,
    stableSystemPrompt: systemParts.stableSystemPrompt || null,
    volatileSystemPrompt: systemParts.volatileSystemPrompt || null,
    systemPromptText: systemParts.systemPromptText || null,
    stablePrefixFingerprint: input.stablePrefixFingerprint || fingerprints.stablePrefixFingerprint,
    cacheFingerprint: input.cacheFingerprint || fingerprints.cacheFingerprint,
  };
}

export async function recordPromptTrace(input: PromptTraceInput): Promise<void> {
  const systemParts = buildCombinedSystemPrompt(input);
  const fingerprints = buildPromptFingerprintMeta({
    stableSystemPrompt: systemParts.stableSystemPrompt,
    volatileSystemPrompt: systemParts.volatileSystemPrompt,
    userPromptText: input.userPromptText,
    providerInputText: input.providerInputText ?? null,
    segments: input.segments,
  });
  await persistPromptTrace({
    ...input,
    stableSystemPrompt: systemParts.stableSystemPrompt || null,
    volatileSystemPrompt: systemParts.volatileSystemPrompt || null,
    systemPromptText: systemParts.systemPromptText || null,
    cacheFingerprint: input.cacheFingerprint || fingerprints.cacheFingerprint,
    stablePrefixFingerprint:
      input.stablePrefixFingerprint || fingerprints.stablePrefixFingerprint,
    metadata: {
      ...(input.metadata || {}),
      stableSystemPrompt: systemParts.stableSystemPrompt || null,
      volatileSystemPrompt: systemParts.volatileSystemPrompt || null,
      cacheFingerprint: input.cacheFingerprint || fingerprints.cacheFingerprint,
      stablePrefixFingerprint:
        input.stablePrefixFingerprint || fingerprints.stablePrefixFingerprint,
    },
  });
}
