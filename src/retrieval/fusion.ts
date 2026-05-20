import type { RetrievalCandidate } from './types.js';

function normalizeScores(candidates: RetrievalCandidate[]): Map<string, number> {
  const scores = candidates.map((candidate) => candidate.rawScore);
  const max = Math.max(...scores, 0);
  const min = Math.min(...scores, 0);
  const range = max - min;
  const out = new Map<string, number>();
  for (const candidate of candidates) {
    const normalized = range > 0 ? (candidate.rawScore - min) / range : candidate.rawScore > 0 ? 1 : 0;
    out.set(candidate.id, normalized);
  }
  return out;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseStringArray(parsed);
    } catch {
      return value.split(',').map((part) => part.trim()).filter(Boolean);
    }
  }
  return [];
}

function candidateTags(candidate: RetrievalCandidate): Set<string> {
  const raw = candidate.metadata.tags ?? candidate.metadata.tags_json;
  return new Set(parseStringArray(raw).map((tag) => tag.toLowerCase()));
}

export function filterCandidatesByTags(
  candidates: RetrievalCandidate[],
  requiredTags: string[] = [],
): RetrievalCandidate[] {
  const required = requiredTags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  if (required.length === 0) return candidates;
  return candidates.filter((candidate) => {
    const tags = candidateTags(candidate);
    return required.every((tag) => tags.has(tag));
  });
}

export function fuseCandidates(candidates: RetrievalCandidate[]): RetrievalCandidate[] {
  if (candidates.length === 0) return [];

  const bySource = new Map<string, RetrievalCandidate[]>();
  for (const candidate of candidates) {
    const list = bySource.get(candidate.source) ?? [];
    list.push(candidate);
    bySource.set(candidate.source, list);
  }

  const normalized = new Map<string, number>();
  for (const group of bySource.values()) {
    for (const [id, score] of normalizeScores(group)) {
      normalized.set(id, Math.max(normalized.get(id) ?? 0, score));
    }
  }

  const merged = new Map<string, RetrievalCandidate>();
  for (const candidate of candidates) {
    const prior = merged.get(candidate.id);
    const rankScore = 1 / (candidate.rank + 60);
    const sourceBoost =
      candidate.source === 'identity_memory'
        ? 1.12
        : candidate.source === 'user_memory'
          ? 1.08
          : candidate.source === 'knowledge_wiki'
            ? 1.04
            : 1;
    const score = ((normalized.get(candidate.id) ?? 0) * 0.82 + rankScore * 0.18) * sourceBoost;
    if (!prior || score > prior.score) {
      merged.set(candidate.id, {
        ...candidate,
        score,
      });
    }
  }

  return [...merged.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.id.localeCompare(right.id);
  });
}

function tokenize(text: string): Set<string> {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 2),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

export function applyLocalRerank(
  query: string,
  candidates: RetrievalCandidate[],
): RetrievalCandidate[] {
  const queryTokens = tokenize(query);
  const phrase = String(query || '').trim().toLowerCase();
  return candidates
    .map((candidate) => {
      const content = `${candidate.title ?? ''}\n${candidate.content}`;
      const contentTokens = tokenize(content);
      const lexical = jaccard(queryTokens, contentTokens);
      const exact = phrase && content.toLowerCase().includes(phrase) ? 0.12 : 0;
      return {
        ...candidate,
        score: candidate.score * 0.55 + lexical * 0.45 + exact,
      };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function applyTextMmr(
  candidates: RetrievalCandidate[],
  topK: number,
  lambda = 0.72,
): RetrievalCandidate[] {
  if (candidates.length <= topK) return candidates.slice(0, topK);
  const tokenCache = new Map<string, Set<string>>();
  const tokensFor = (candidate: RetrievalCandidate): Set<string> => {
    const cached = tokenCache.get(candidate.id);
    if (cached) return cached;
    const tokens = tokenize(`${candidate.title ?? ''}\n${candidate.content}`);
    tokenCache.set(candidate.id, tokens);
    return tokens;
  };

  const selected: RetrievalCandidate[] = [];
  const remaining = [...candidates];
  while (selected.length < topK && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const maxSimilarity = selected.reduce(
        (max, chosen) => Math.max(max, jaccard(tokensFor(candidate), tokensFor(chosen))),
        0,
      );
      const mmrScore = lambda * candidate.score - (1 - lambda) * maxSimilarity;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = i;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}
