import { describe, expect, it } from 'vitest';

import {
  estimateRepoReviewPayloadBytes,
  splitTasksByByteBudget,
} from './repo-review-budget.js';

describe('repo-review-budget', () => {
  it('estimates payload bytes from diff, file content, and related findings', () => {
    expect(
      estimateRepoReviewPayloadBytes({
        diffBytes: 1200,
        fileContentBytes: 8000,
        relatedFindingBytes: 300,
      }),
    ).toBeGreaterThan(9000);
  });

  it('splits tasks by byte budget deterministically', () => {
    const groups = splitTasksByByteBudget(
      [
        { filePath: 'A.java', estimatedBytes: 90_000 },
        { filePath: 'B.xml', estimatedBytes: 70_000 },
        { filePath: 'CTest.java', estimatedBytes: 60_000 },
      ],
      120_000,
    );

    expect(groups.map((group) => group.map((task) => task.filePath))).toEqual([
      ['A.java'],
      ['B.xml'],
      ['CTest.java'],
    ]);
  });

  it('keeps oversized tasks isolated while packing smaller tasks in order', () => {
    const groups = splitTasksByByteBudget(
      [
        { filePath: 'huge.java', estimatedBytes: 250_000 },
        { filePath: 'a.ts', estimatedBytes: 40_000 },
        { filePath: 'b.ts', estimatedBytes: 35_000 },
        { filePath: 'c.ts', estimatedBytes: 20_000 },
      ],
      100_000,
    );

    expect(groups.map((group) => group.map((task) => task.filePath))).toEqual([
      ['huge.java'],
      ['a.ts', 'b.ts', 'c.ts'],
    ]);
  });
});
