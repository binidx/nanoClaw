export interface TavernGlobalConfig {
  skillIds: string[];
  mcpServerIds: string[];
  providerId?: string | null;
  model?: string | null;
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

export function createDefaultTavernGlobalConfig(): TavernGlobalConfig {
  return {
    skillIds: [],
    mcpServerIds: [],
    providerId: null,
    model: null,
  };
}

export function normalizeTavernGlobalConfig(value: unknown): TavernGlobalConfig {
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    skillIds: normalizeStringArray(input.skillIds),
    mcpServerIds: normalizeStringArray(input.mcpServerIds),
    providerId: normalizeOptionalString(input.providerId),
    model: normalizeOptionalString(input.model),
  };
}

export function serializeTavernGlobalConfig(config: TavernGlobalConfig): string {
  return JSON.stringify(normalizeTavernGlobalConfig(config));
}
