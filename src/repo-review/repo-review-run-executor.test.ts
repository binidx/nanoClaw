import { describe, expect, it } from 'vitest';

import { stripRepoReviewExecutionContext } from './repo-review-run-executor.js';

describe('repo review rerun context', () => {
  it('drops inherited execution progress while preserving rerun metadata', () => {
    const result = stripRepoReviewExecutionContext({
      manualReview: {
        baselineMode: 'last_reviewed',
      },
      commitSummaryLines: ['old summary'],
      commitDetails: [{ commit: 'abc123', title: 'old' }],
      reviewTurns: [{ id: 'turn-1' }],
      reviewProgress: { turnCount: 1 },
      scopeLimitations: ['old limit'],
      fileReviews: [{ file: 'src/a.ts' }],
      commitReviews: [{ commit: 'abc123' }],
      executionStats: { workerCount: 9 },
    });

    expect(result).toEqual({
      manualReview: {
        baselineMode: 'last_reviewed',
      },
    });
  });
});
