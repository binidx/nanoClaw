import { describe, expect, it } from 'vitest';

import { buildQueryVariants } from './retrieval/query-planner.js';
import {
  applyLocalRerank,
  applyTextMmr,
  filterCandidatesByTags,
  fuseCandidates,
} from './retrieval/fusion.js';
import type { RetrievalCandidate } from './retrieval/types.js';

function candidate(
  id: string,
  content: string,
  rawScore: number,
  rank: number,
  metadata: Record<string, unknown> = {},
): RetrievalCandidate {
  return {
    id,
    source: 'knowledge_chunk',
    sourceType: 'knowledge_chunk',
    content,
    rawScore,
    score: rawScore,
    rank,
    queryVariant: 'q',
    metadata,
  };
}

describe('retrieval query planner and fusion', () => {
  it('builds bounded query variants from explicit and local rewrites', () => {
    expect(
      buildQueryVariants('请问 RAG 检索如何优化？Doc2Query 怎么用？', {
        multiQuery: true,
        queryVariants: ['RAG recall optimization'],
      }),
    ).toEqual([
      '请问 RAG 检索如何优化？Doc2Query 怎么用？',
      'RAG recall optimization',
      'RAG 检索如何优化？Doc2Query 怎么用？',
      '请问 RAG 检索如何优化',
      'Doc2Query 怎么用',
    ]);
  });

  it('fuses duplicate candidates and applies required tag filters', () => {
    const fused = fuseCandidates(
      filterCandidatesByTags(
        [
          candidate('a', 'RAG rerank', 0.7, 2, { tags: ['rag'] }),
          candidate('a', 'RAG rerank duplicate', 0.9, 1, { tags: ['rag'] }),
          candidate('b', 'unrelated', 0.8, 1, { tags: ['other'] }),
        ],
        ['rag'],
      ),
    );

    expect(fused).toHaveLength(1);
    expect(fused[0]).toMatchObject({
      id: 'a',
      rawScore: 0.9,
      rank: 1,
    });
  });

  it('reranks lexical matches and keeps MMR diverse', () => {
    const reranked = applyLocalRerank('graph rag multi hop', [
      candidate('a', 'graph rag multi hop entity relationship', 0.5, 1),
      candidate('b', 'general memory preference', 0.9, 2),
      candidate('c', 'graph rag multi hop entity relationship repeated', 0.49, 3),
      candidate('d', 'rerank provider cross encoder', 0.48, 4),
    ]);

    expect(reranked[0].id).toBe('a');
    const diversified = applyTextMmr(reranked, 3, 0.5);
    expect(diversified.map((item) => item.id)).toContain('d');
  });
});
