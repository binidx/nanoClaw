export interface TemporalDecayOptions {
  halfLifeDays?: number;
  exemptTiers?: string[];
}

const DEFAULT_HALF_LIFE_DAYS = 30;

export function applyTemporalDecay(
  score: number,
  timestamp: string,
  options: TemporalDecayOptions = {},
): number {
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return score;
  const ageMs = Math.max(0, Date.now() - parsed);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return score * Math.pow(0.5, ageDays / halfLifeDays);
}

export function isExemptFromDecay(
  tier: string | undefined,
  options: TemporalDecayOptions = {},
): boolean {
  const exemptTiers = options.exemptTiers ?? ['core'];
  return tier !== undefined && exemptTiers.includes(tier);
}

export function applyTemporalDecayBatch<
  T extends { score: number; createdAt: string; tier?: string },
>(
  items: T[],
  options: TemporalDecayOptions = {},
): T[] {
  return items.map((item) => {
    if (isExemptFromDecay(item.tier, options)) return item;
    return { ...item, score: applyTemporalDecay(item.score, item.createdAt, options) };
  });
}
