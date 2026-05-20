import type { RetrievalStrategy } from './types.js';

const MAX_QUERY_VARIANTS = 5;

function normalizeQuery(query: string): string {
  return String(query || '').replace(/\s+/g, ' ').trim();
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeQuery(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function splitQuestionClauses(query: string): string[] {
  return query
    .split(/[?？;；。.!！\n]+/u)
    .map((part) => normalizeQuery(part))
    .filter((part) => part.length >= 4);
}

function stripPoliteNoise(query: string): string {
  return normalizeQuery(
    query
      .replace(/^(请问|麻烦问下|我想问一下|想问下|那个|就是)\s*/u, '')
      .replace(/\b(please|can you|could you|tell me about)\b/giu, ' ')
      .replace(/\s+/g, ' '),
  );
}

function keywordVariant(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !/^(the|a|an|and|or|of|to|for|with|about)$/i.test(token));
  return normalizeQuery(tokens.join(' '));
}

export function buildQueryVariants(
  query: string,
  strategy: RetrievalStrategy = {},
): string[] {
  const normalized = normalizeQuery(query);
  if (!normalized) return [];

  const explicit = Array.isArray(strategy.queryVariants)
    ? strategy.queryVariants
    : [];
  if (!strategy.multiQuery && explicit.length === 0) {
    return [normalized];
  }

  return dedupe([
    normalized,
    ...explicit,
    stripPoliteNoise(normalized),
    ...splitQuestionClauses(normalized),
    keywordVariant(normalized),
  ]).slice(0, MAX_QUERY_VARIANTS);
}
