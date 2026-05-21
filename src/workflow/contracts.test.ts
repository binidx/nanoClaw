import { describe, expect, it } from 'vitest';

import {
  applyWorkflowContextPolicy,
  edgeConditionRequiresVerdict,
  evaluateWorkflowOutputContract,
} from './contracts.js';

describe('workflow output contracts', () => {
  it('blocks conditional routing when verdict is required but missing', () => {
    const result = evaluateWorkflowOutputContract({
      output: 'Looks good to me.',
      taskConfig: {},
      verdictRequired: true,
    });

    expect(result.verdict).toBe('blocked');
    expect(result.hasExplicitVerdict).toBe(false);
    expect(result.blockedByContract).toBe(true);
    expect(result.validationErrors).toContain(
      'Output contract requires an explicit verdict',
    );
  });

  it('validates lightweight output schema when blocking is enabled', () => {
    const result = evaluateWorkflowOutputContract({
      output: JSON.stringify({ verdict: 'pass', reason: 123 }),
      taskConfig: {
        outputSchema: JSON.stringify({
          required: ['verdict', 'reason'],
          properties: {
            verdict: { type: 'string' },
            reason: { type: 'string' },
          },
        }),
        outputContract: {
          verdictRequired: true,
          strictJson: true,
          schemaValidation: 'block',
        },
      },
    });

    expect(result.verdict).toBe('blocked');
    expect(result.validationErrors).toContain(
      'Output field "reason" expected string, got number',
    );
  });

  it('accepts explicit pass verdict with valid schema', () => {
    const result = evaluateWorkflowOutputContract({
      output: JSON.stringify({ verdict: 'pass', reason: 'ok' }),
      taskConfig: {
        outputSchema: JSON.stringify({
          required: ['verdict', 'reason'],
          properties: {
            verdict: { type: 'string' },
            reason: { type: 'string' },
          },
        }),
        outputContract: {
          verdictRequired: true,
          strictJson: true,
          schemaValidation: 'block',
        },
      },
    });

    expect(result.verdict).toBe('pass');
    expect(result.blockedByContract).toBe(false);
    expect(result.validationErrors).toEqual([]);
  });
});

describe('workflow context policy', () => {
  it('keeps latest message per edge and enforces total character budget', () => {
    const messages = applyWorkflowContextPolicy(
      [
        { from: 'A', to: 'B', direction: 'one_way', edgeId: 'ab', content: 'old' },
        { from: 'A', to: 'B', direction: 'one_way', edgeId: 'ab', content: 'new' },
        { from: 'C', to: 'B', direction: 'one_way', edgeId: 'cb', content: 'context' },
      ],
      { mode: 'latest', maxTotalChars: 10 },
    );

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.content).join('')).toContain('new');
    expect(
      messages.reduce((sum, message) => sum + message.content.length, 0),
    ).toBeLessThanOrEqual(10);
  });

  it('recognizes verdict-gated edges', () => {
    expect(edgeConditionRequiresVerdict('on_pass')).toBe(true);
    expect(edgeConditionRequiresVerdict('always')).toBe(false);
    expect(edgeConditionRequiresVerdict('always', true)).toBe(true);
  });
});
