export function createPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

export function estimateTokenCount(text: string): number {
  const normalized = String(text || '').trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function normalizeMemoryText(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
