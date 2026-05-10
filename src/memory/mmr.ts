import { cosineSimilarity, deserializeEmbedding } from '../embedding/vector-store.js';
import { getEmbeddingByOwner } from '../db.js';

export interface MMRCandidate {
  id: string;
  score: number;
}

export async function applyMMR<T extends { id: string; score: number }>(
  results: T[],
  lambda: number = 0.7,
  topK: number = 10,
): Promise<T[]> {
  if (results.length <= 1 || lambda >= 1) return results.slice(0, topK);

  const embeddings = new Map<string, number[]>();
  for (const r of results) {
    const rec = await getEmbeddingByOwner('memory', r.id);
    if (rec) {
      embeddings.set(r.id, deserializeEmbedding(rec.embedding));
    }
  }

  if (embeddings.size === 0) return results.slice(0, topK);

  const selected: T[] = [];
  const remaining = [...results];

  const first = remaining.shift()!;
  selected.push(first);

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = -1;
    let bestMmrScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const candidateEmb = embeddings.get(candidate.id);

      let maxSimToSelected = 0;
      if (candidateEmb) {
        for (const sel of selected) {
          const selEmb = embeddings.get(sel.id);
          if (selEmb) {
            maxSimToSelected = Math.max(
              maxSimToSelected,
              cosineSimilarity(candidateEmb, selEmb),
            );
          }
        }
      }

      const mmrScore = lambda * candidate.score - (1 - lambda) * maxSimToSelected;
      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) break;
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}
