import fs from 'fs';
import path from 'path';
import { t } from '../i18n/index.js';

export type AccessMode = 'allowall' | 'allowlist' | 'readonly';

export interface AccessPolicy {
  mode: AccessMode;
  directories: string[];
}

export interface ResolvedAccessPolicy extends AccessPolicy {
  inheritedFrom: 'global' | 'assistant' | 'conversation';
  locked: boolean;
  editable: boolean;
}

export interface ConversationAccessPolicyLayers {
  global: AccessPolicy;
  assistant: AccessPolicy | null;
  conversation: AccessPolicy | null;
}

export interface ResolvedConversationAccessState {
  policy: ResolvedAccessPolicy;
  policyLayers: ConversationAccessPolicyLayers;
}

export interface EffectiveConversationAccessState {
  persistentPolicy: ResolvedAccessPolicy;
  temporaryCommandReuseCount: number;
  temporaryApprovedDirectories: string[];
  hasTemporaryElevation: boolean;
  summary: string;
}

interface RuntimeApprovalPatchLike {
  scope: 'current_tool_call' | 'current_runtime';
  cwd?: string;
}

const DEFAULT_ACCESS_MODE: AccessMode = 'allowall';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizePolicyDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    let resolved = trimmed;
    try {
      if (fs.existsSync(trimmed)) {
        resolved = fs.realpathSync(trimmed);
      } else if (path.isAbsolute(trimmed)) {
        // Preserve caller-provided absolute paths even when they do not exist on
        // the current host yet. Runtime wiring and UI surfaces rely on the
        // original policy string instead of coercing it to the local drive.
        resolved = trimmed;
      } else {
        resolved = path.resolve(trimmed);
      }
    } catch {
      resolved = trimmed;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized;
}

export function normalizeAccessMode(
  value: unknown,
  fallback: AccessMode = DEFAULT_ACCESS_MODE,
): AccessMode {
  return value === 'allowlist' || value === 'readonly' || value === 'allowall'
    ? value
    : fallback;
}

export function createDefaultAccessPolicy(
  mode: AccessMode = DEFAULT_ACCESS_MODE,
): AccessPolicy {
  return {
    mode,
    directories: [],
  };
}

export function normalizeAccessPolicy(
  value: unknown,
  options: {
    fallback?: AccessPolicy;
    legacyAllowedDirectories?: unknown;
    legacyStrictAllowedDirectories?: unknown;
    legacyDefaultMode?: AccessMode;
  } = {},
): AccessPolicy {
  const fallback = options.fallback || createDefaultAccessPolicy();
  const legacyPolicy = normalizeLegacyAccessPolicy(
    options.legacyAllowedDirectories,
    options.legacyStrictAllowedDirectories,
    options.legacyDefaultMode,
  );
  const base = legacyPolicy || fallback;

  if (!isRecord(value)) {
    return {
      mode: normalizeAccessMode(base.mode),
      directories: normalizePolicyDirectories(base.directories),
    };
  }

  const mode = normalizeAccessMode(value.mode, base.mode);
  const directories = Array.isArray(value.directories)
    ? normalizePolicyDirectories(value.directories)
    : normalizePolicyDirectories(base.directories);

  return {
    mode,
    directories,
  };
}

export function normalizeLegacyAccessPolicy(
  allowedDirectories: unknown,
  strictAllowedDirectories: unknown,
  defaultMode: AccessMode = DEFAULT_ACCESS_MODE,
): AccessPolicy | undefined {
  if (!Array.isArray(allowedDirectories)) return undefined;
  const directories = normalizePolicyDirectories(allowedDirectories);
  return {
    mode:
      strictAllowedDirectories === true
        ? 'allowlist'
        : normalizeAccessMode(defaultMode, DEFAULT_ACCESS_MODE),
    directories,
  };
}

export function resolveLegacyAccessPolicy(
  value:
    | {
        accessPolicy?: unknown;
        allowedDirectories?: unknown;
        strictAllowedDirectories?: unknown;
      }
    | null
    | undefined,
  options: {
    defaultMode?: AccessMode;
    fallback?: AccessPolicy;
  } = {},
): AccessPolicy | undefined {
  if (!value) return options.fallback;
  if (value.accessPolicy) {
    return normalizeAccessPolicy(value.accessPolicy, {
      fallback: options.fallback,
      legacyAllowedDirectories: value.allowedDirectories,
      legacyStrictAllowedDirectories: value.strictAllowedDirectories,
      legacyDefaultMode: options.defaultMode,
    });
  }
  return (
    normalizeLegacyAccessPolicy(
      value.allowedDirectories,
      value.strictAllowedDirectories,
      options.defaultMode,
    ) || options.fallback
  );
}

export function resolveRuntimeAccessPolicy(input: {
  defaultPolicy?: AccessPolicy | null;
  defaultMode?: unknown;
  defaultDirectories?: unknown;
  assistantPolicy?: AccessPolicy | null;
  assistantManaged?: boolean;
  override?: {
    mode?: unknown;
    directories?: unknown;
  } | null;
  configured?: {
    accessPolicy?: unknown;
    allowedDirectories?: unknown;
    strictAllowedDirectories?: unknown;
  } | null;
  overrideFallbackMode?: AccessMode;
}): AccessPolicy {
  const defaultPolicy = input.defaultPolicy
    ? normalizeAccessPolicy(input.defaultPolicy, {
        fallback: createDefaultAccessPolicy(),
      })
    : normalizeAccessPolicy(
        {
          mode: normalizeAccessMode(input.defaultMode, DEFAULT_ACCESS_MODE),
          directories: normalizePolicyDirectories(input.defaultDirectories),
        },
        {
          fallback: createDefaultAccessPolicy(),
        },
      );

  const override = input.override;
  const persistentPolicy = resolveConversationAccessPolicy({
    defaultPolicy,
    conversationPolicy: resolveLegacyAccessPolicy(input.configured, {
      defaultMode: defaultPolicy.mode,
    }),
    assistantPolicy: input.assistantPolicy,
    assistantManaged: input.assistantManaged,
  });
  const hasOverrideMode = override?.mode !== undefined;
  const hasOverrideDirectories = override?.directories !== undefined;
  if (!hasOverrideMode && !hasOverrideDirectories) {
    return {
      mode: persistentPolicy.mode,
      directories: persistentPolicy.directories,
    };
  }

  return normalizeAccessPolicy(
    {
      mode: override?.mode,
      directories: override?.directories,
    },
    {
      fallback: {
        mode:
          !hasOverrideMode && hasOverrideDirectories
            ? (input.overrideFallbackMode || 'allowlist')
            : persistentPolicy.mode,
        directories: persistentPolicy.directories,
      },
    },
  );
}

export function accessPolicyToLegacyDirectories(
  policy: AccessPolicy | null | undefined,
): string[] {
  return Array.isArray(policy?.directories) ? policy!.directories : [];
}

export function serializeAccessPolicy(policy: AccessPolicy): AccessPolicy {
  return normalizeAccessPolicy(policy);
}

export function accessPoliciesEqual(
  left: AccessPolicy | null | undefined,
  right: AccessPolicy | null | undefined,
): boolean {
  const a = left ? normalizeAccessPolicy(left) : null;
  const b = right ? normalizeAccessPolicy(right) : null;
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.mode !== b.mode) return false;
  if (a.directories.length !== b.directories.length) return false;
  return a.directories.every((entry, index) => entry === b.directories[index]);
}

export function resolveConversationAccessPolicy(input: {
  defaultPolicy: AccessPolicy;
  conversationPolicy?: AccessPolicy | null;
  assistantPolicy?: AccessPolicy | null;
  assistantManaged?: boolean;
}): ResolvedAccessPolicy {
  const defaultPolicy = normalizeAccessPolicy(input.defaultPolicy, {
    fallback: createDefaultAccessPolicy(),
  });
  if (input.assistantManaged && input.assistantPolicy) {
    const assistantPolicy = normalizeAccessPolicy(input.assistantPolicy, {
      fallback: defaultPolicy,
    });
    return {
      ...assistantPolicy,
      inheritedFrom: 'assistant',
      locked: true,
      editable: false,
    };
  }
  if (input.conversationPolicy) {
    const conversationPolicy = normalizeAccessPolicy(input.conversationPolicy, {
      fallback: defaultPolicy,
    });
    return {
      ...conversationPolicy,
      inheritedFrom: 'conversation',
      locked: false,
      editable: true,
    };
  }
  return {
    ...defaultPolicy,
    inheritedFrom: 'global',
    locked: false,
    editable: true,
  };
}

export function resolveConversationAccessState(input: {
  defaultPolicy: AccessPolicy;
  conversationPolicy?: AccessPolicy | null;
  assistantPolicy?: AccessPolicy | null;
  assistantManaged?: boolean;
}): ResolvedConversationAccessState {
  const defaultPolicy = normalizeAccessPolicy(input.defaultPolicy, {
    fallback: createDefaultAccessPolicy(),
  });
  const assistantPolicy = input.assistantPolicy
    ? normalizeAccessPolicy(input.assistantPolicy, {
        fallback: defaultPolicy,
      })
    : null;
  const conversationPolicy = input.conversationPolicy
    ? normalizeAccessPolicy(input.conversationPolicy, {
        fallback: defaultPolicy,
      })
    : null;

  return {
    policy: resolveConversationAccessPolicy({
      defaultPolicy,
      assistantPolicy,
      conversationPolicy,
      assistantManaged: input.assistantManaged,
    }),
    policyLayers: {
      global: defaultPolicy,
      assistant: assistantPolicy,
      conversation: conversationPolicy,
    },
  };
}

function getAccessModeLabel(mode: AccessMode): string {
  switch (mode) {
    case 'readonly':
      return t('accessPolicy.readonly', {}, undefined);
    case 'allowlist':
      return t('accessPolicy.allowlist', {}, undefined);
    case 'allowall':
    default:
      return t('accessPolicy.allowAll', {}, undefined);
  }
}

function getAccessSourceLabel(source: ResolvedAccessPolicy['inheritedFrom']): string {
  switch (source) {
    case 'assistant':
      return t('trash.entityAssistant', {}, undefined);
    case 'conversation':
      return t('accessPolicy.currentConversation', {}, undefined);
    case 'global':
    default:
      return t('accessPolicy.globalDefault', {}, undefined);
  }
}

export function resolveEffectiveConversationAccessState(input: {
  persistentPolicy: ResolvedAccessPolicy;
  runtimeApprovalPatches?: RuntimeApprovalPatchLike[] | null;
}): EffectiveConversationAccessState {
  const runtimeApprovalPatches = Array.isArray(input.runtimeApprovalPatches)
    ? input.runtimeApprovalPatches
    : [];
  const reusablePatches = runtimeApprovalPatches.filter(
    (patch) => patch.scope === 'current_runtime',
  );
  const temporaryApprovedDirectories = Array.from(
    new Set(
      reusablePatches
        .map((patch) => patch.cwd?.trim() || '')
        .filter(Boolean),
    ),
  );
  const temporaryCommandReuseCount = reusablePatches.length;
  const hasTemporaryElevation = temporaryCommandReuseCount > 0;
  const sourceLabel = getAccessSourceLabel(
    input.persistentPolicy.inheritedFrom,
  );
  const modeLabel = getAccessModeLabel(input.persistentPolicy.mode);
  const summary = hasTemporaryElevation
    ? (temporaryApprovedDirectories.length > 0
      ? t('permissions.currentPolicyWithTempDirs', { source: sourceLabel, mode: modeLabel, count: temporaryCommandReuseCount, dirCount: temporaryApprovedDirectories.length }, undefined)
      : t('permissions.currentPolicyWithTemp', { source: sourceLabel, mode: modeLabel, count: temporaryCommandReuseCount }, undefined))
    : t('permissions.currentPolicySimple', { source: sourceLabel, mode: modeLabel }, undefined);

  return {
    persistentPolicy: input.persistentPolicy,
    temporaryCommandReuseCount,
    temporaryApprovedDirectories,
    hasTemporaryElevation,
    summary,
  };
}

export function isReadOnlyAccessMode(mode: AccessMode): boolean {
  return mode === 'readonly';
}
