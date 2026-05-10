import {
  deletePromptConfig,
  getPromptConfig,
  recordPromptTrace as persistPromptTrace,
  upsertPromptConfig,
} from '../db/prompt-configs.js';
import { getPromptDefinition } from './prompt-registry.js';
import type {
  PromptConfigRecord,
  PromptPreviewEnvelope,
  PromptScopeKind,
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
  return input;
}

export async function recordPromptTrace(input: PromptTraceInput): Promise<void> {
  await persistPromptTrace(input);
}
