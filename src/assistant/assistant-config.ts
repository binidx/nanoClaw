export type AssistantRuleMode = 'append' | 'replace' | 'locked';

export interface AssistantRulesConfig {
  mode?: AssistantRuleMode | null;
  systemPrompt?: string | null;
  extraInstructions?: string | null;
}

export interface AssistantPersona {
  role: string;
  style: string;
  guidelines: string;
  constraints: string;
}

export interface AssistantConfig {
  skillIds: string[];
  mcpServerIds: string[];
  userSkillIds: string[];
  userMcpServerIds: string[];
  kbIds: string[];
  rules: AssistantRulesConfig;
  persona: AssistantPersona;
  providerId?: string | null;
  model?: string | null;
  inheritSoulConfig?: boolean;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizeAssistantRuleMode(
  value: unknown,
): AssistantRuleMode {
  return value === 'replace' || value === 'locked' ? value : 'append';
}

export function normalizeAssistantId(
  value: unknown,
  fallbackName = '',
): string {
  const raw = String(value || fallbackName || 'assistant').trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || `assistant-${Date.now().toString(36)}`;
}

export function createDefaultPersona(): AssistantPersona {
  return { role: '', style: '', guidelines: '', constraints: '' };
}

export function createDefaultAssistantConfig(): AssistantConfig {
  return {
    skillIds: [],
    mcpServerIds: [],
    userSkillIds: [],
    userMcpServerIds: [],
    kbIds: [],
    rules: {
      mode: 'append',
    },
    persona: createDefaultPersona(),
    providerId: null,
    model: null,
  };
}

function normalizePersona(value: unknown): AssistantPersona {
  const defaults = createDefaultPersona();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
  const raw = value as Record<string, unknown>;
  return {
    role: typeof raw.role === 'string' ? raw.role.trim() : defaults.role,
    style: typeof raw.style === 'string' ? raw.style.trim() : defaults.style,
    guidelines: typeof raw.guidelines === 'string' ? raw.guidelines.trim() : defaults.guidelines,
    constraints: typeof raw.constraints === 'string' ? raw.constraints.trim() : defaults.constraints,
  };
}

export function normalizeAssistantConfig(value: unknown): AssistantConfig {
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const rawRules =
    input.rules && typeof input.rules === 'object' && !Array.isArray(input.rules)
      ? (input.rules as Record<string, unknown>)
      : {};

  return {
    skillIds: normalizeStringArray(input.skillIds),
    mcpServerIds: normalizeStringArray(input.mcpServerIds),
    userSkillIds: normalizeStringArray(input.userSkillIds),
    userMcpServerIds: normalizeStringArray(input.userMcpServerIds),
    kbIds: normalizeStringArray(input.kbIds),
    rules: {
      mode: normalizeAssistantRuleMode(rawRules.mode),
      systemPrompt: normalizeOptionalString(rawRules.systemPrompt),
      extraInstructions: normalizeOptionalString(rawRules.extraInstructions),
    },
    persona: normalizePersona(input.persona),
    providerId: normalizeOptionalString(input.providerId),
    model: normalizeOptionalString(input.model),
    ...(input.inheritSoulConfig === true ? { inheritSoulConfig: true } : {}),
  };
}

export function serializeAssistantConfig(config: AssistantConfig): string {
  return JSON.stringify(normalizeAssistantConfig(config));
}
