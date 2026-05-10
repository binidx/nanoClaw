import { describe, expect, it } from 'vitest';

import {
  buildRepoReviewDiffIndex,
  getRepoReviewDiffSlice,
} from './repo-review-diff-index.js';

const sampleDiff = [
  'diff --git a/A.java b/A.java',
  'index 1111111..2222222 100644',
  '--- a/A.java',
  '+++ b/A.java',
  '@@ -1 +1 @@',
  '-class A {}',
  '+class A { int v = 1; }',
  'diff --git a/B.xml b/B.xml',
  'index 3333333..4444444 100644',
  '--- a/B.xml',
  '+++ b/B.xml',
  '@@ -1 +1 @@',
  '-<a/>',
  '+<a attr="1"/>',
  'diff --git a/CTest.java b/CTest.java',
  'index 5555555..6666666 100644',
  '--- a/CTest.java',
  '+++ b/CTest.java',
  '@@ -1 +1 @@',
  '-class CTest {}',
  '+class CTest { boolean ok = true; }',
].join('\n');

describe('repo-review-diff-index', () => {
  it('indexes files in diff order with stable offsets', () => {
    const index = buildRepoReviewDiffIndex(sampleDiff);

    expect(index.files).toEqual(['A.java', 'B.xml', 'CTest.java']);
    expect(index.entries.map((entry) => entry.filePath)).toEqual(index.files);

    for (const entry of index.entries) {
      const slice = sampleDiff.slice(entry.startOffset, entry.endOffset).trim();
      expect(slice).toContain(`diff --git a/${entry.filePath} b/${entry.filePath}`);
      expect(entry.estimatedBytes).toBe(Buffer.byteLength(slice, 'utf8'));
    }
  });

  it('extracts single-file and multi-file slices without unrelated files', () => {
    const index = buildRepoReviewDiffIndex(sampleDiff);

    expect(getRepoReviewDiffSlice(index, ['B.xml'])).toContain(
      'diff --git a/B.xml b/B.xml',
    );

    const multiSlice = getRepoReviewDiffSlice(index, ['A.java', 'CTest.java']);
    expect(multiSlice).toContain('diff --git a/A.java b/A.java');
    expect(multiSlice).toContain('diff --git a/CTest.java b/CTest.java');
    expect(multiSlice).not.toContain('diff --git a/B.xml b/B.xml');
  });

  it('indexes quoted diff headers for paths with spaces', () => {
    const quotedDiff = [
      'diff --git "a/src/foo bar.ts" "b/src/foo bar.ts"',
      'index 1234567..89abcde 100644',
      '--- "a/src/foo bar.ts"',
      '+++ "b/src/foo bar.ts"',
      '@@ -1 +1 @@',
      '-export const mode = "before";',
      '+export const mode = "after";',
    ].join('\n');

    const index = buildRepoReviewDiffIndex(quotedDiff);
    expect(index.files).toEqual(['src/foo bar.ts']);
    expect(getRepoReviewDiffSlice(index, ['src/foo bar.ts'])).toContain(
      'diff --git "a/src/foo bar.ts" "b/src/foo bar.ts"',
    );
  });
});
