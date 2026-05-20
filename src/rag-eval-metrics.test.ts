import { describe, expect, it } from 'vitest';

import { evaluateRagSample } from './rag-eval/metrics.js';

describe('rag eval metrics', () => {
  it('scores retrieval and generation quality from deterministic lexical evidence', () => {
    const scores = evaluateRagSample({
      userInput: 'What causes dough to rise?',
      reference: 'Yeast fermentation produces carbon dioxide. Gluten traps the gas.',
      response: 'Dough rises because yeast fermentation produces carbon dioxide, and gluten traps the gas.',
      retrievedContexts: [
        {
          id: 'ctx-1',
          content: 'Yeast fermentation produces carbon dioxide. Gluten traps the gas in dough.',
        },
        {
          id: 'ctx-2',
          content: 'Unrelated travel policy text.',
        },
      ],
      referenceContextIds: ['ctx-1'],
    });

    expect(scores.metricKind).toBe('local_lexical_heuristic');
    expect(scores.contextPrecision).toBeCloseTo(1);
    expect(scores.contextRecall).toBeCloseTo(1);
    expect(scores.faithfulness).toBeCloseTo(1);
    expect(scores.answerRelevancy).toBeGreaterThan(0);
    expect(scores.noiseSensitivity).toBeCloseTo(0);
  });

  it('penalizes unsupported response claims', () => {
    const scores = evaluateRagSample({
      userInput: 'What is the refund deadline?',
      reference: 'Refund requests must be submitted within 15 work days.',
      response: 'Refund requests must be submitted within 15 work days. Managers always approve them.',
      retrievedContexts: [
        {
          id: 'ctx-1',
          content: 'Refund requests must be submitted within 15 work days. Managers always approve them.',
        },
      ],
    });

    expect(scores.faithfulness).toBeCloseTo(1);
    expect(scores.noiseSensitivity).toBeGreaterThan(0);
  });
});
