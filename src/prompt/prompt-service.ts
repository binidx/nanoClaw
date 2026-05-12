import crypto from 'crypto';

import {
  deletePromptConfig,
  getPromptConfig,
  recordPromptTrace as persistPromptTrace,
  upsertPromptConfig,
} from '../db/prompt-configs.js';
import { getPromptDefinition } from './prompt-registry.js';
import type {
  PromptConfigRecord,
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
  if (segment.source === 'memory') return 'context_memory';
  if (segment.source === 'assistant_config') return 'system_persona';
  if (segment.source === 'soul') return 'system_persona';
  if (segment.source === 'custom') return 'system_policy';
  return 'system_base';
}

function normalizeSegmentsForFingerprint(segments: PromptSegment[] = []): string {
  return JSON.stringify(
    segments.map((segment) => ({
      id: segment.id,
      layer: inferSegmentLayer(segment),
      source: segment.source,
      promptKey: segment.promptKey || null,
      content: normalizeFingerprintText(segment.content),
    })),
  );
}

export function buildPromptFingerprintMeta(input: {
  systemPromptText?: string | null;
  userPromptText: string;
  providerInputText?: string | null;
  segments?: PromptSegment[];
}): {
  stablePrefixFingerprint: string;
  cacheFingerprint: string;
} {
  const systemPromptText = normalizeFingerprintText(input.systemPromptText);
  const userPromptText = normalizeFingerprintText(input.userPromptText);
  const providerInputText = normalizeFingerprintText(input.providerInputText);
  const segments = normalizeSegmentsForFingerprint(input.segments || []);
  const stablePrefixFingerprint = sha256(systemPromptText);
  const cacheFingerprint = sha256(
    [systemPromptText, providerInputText || userPromptText, userPromptText, segments].join(
      '\n---\n',
    ),
  );
  return { stablePrefixFingerprint, cacheFingerprint };
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
  const fingerprints = buildPromptFingerprintMeta({
    systemPromptText: input.systemPromptText ?? null,
    userPromptText: input.userPromptText,
    providerInputText: input.providerInputText ?? null,
    segments: input.segments,
  });
  return {
    ...input,
    stablePrefixFingerprint: input.stablePrefixFingerprint || fingerprints.stablePrefixFingerprint,
    cacheFingerprint: input.cacheFingerprint || fingerprints.cacheFingerprint,
  };
}

export async function recordPromptTrace(input: PromptTraceInput): Promise<void> {
  const fingerprints = buildPromptFingerprintMeta({
    systemPromptText: input.systemPromptText ?? null,
    userPromptText: input.userPromptText,
    providerInputText: input.providerInputText ?? null,
    segments: input.segments,
  });
  await persistPromptTrace({
    ...input,
    cacheFingerprint: input.cacheFingerprint || fingerprints.cacheFingerprint,
    stablePrefixFingerprint:
      input.stablePrefixFingerprint || fingerprints.stablePrefixFingerprint,
    metadata: {
      ...(input.metadata || {}),
      cacheFingerprint: input.cacheFingerprint || fingerprints.cacheFingerprint,
      stablePrefixFingerprint:
        input.stablePrefixFingerprint || fingerprints.stablePrefixFingerprint,
    },
  });
}
