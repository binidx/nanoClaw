import { describe, expect, it } from 'vitest';

import {
  computeWikiQualityMultiplier,
  computeWikiTitleMultiplier,
} from './knowledge/retrieval.js';

describe('knowledge wiki ranking helpers', () => {
  it('boosts exact title matches above partial matches', () => {
    const exact = computeWikiTitleMultiplier('NanoClaw 部署指南', 'nanoclaw 部署指南', ['nanoclaw', '部署', '指南']);
    const partial = computeWikiTitleMultiplier('NanoClaw 指南', 'nanoclaw 部署指南', ['nanoclaw', '部署', '指南']);

    expect(exact).toBeGreaterThan(partial);
    expect(exact).toBeGreaterThan(1);
  });

  it('penalizes overview pages and rewards synthesis pages with evidenced claims', () => {
    const overview = computeWikiQualityMultiplier('overview', 4, 'x'.repeat(600), 0, 0);
    const synthesis = computeWikiQualityMultiplier('synthesis', 4, 'x'.repeat(600), 4, 4);

    expect(synthesis).toBeGreaterThan(overview);
  });

  it('prefers pages with evidenced claims over equally sized pages without claims', () => {
    const noClaims = computeWikiQualityMultiplier('entity', 3, 'x'.repeat(600), 0, 0);
    const withClaims = computeWikiQualityMultiplier('entity', 3, 'x'.repeat(600), 3, 3);

    expect(withClaims).toBeGreaterThan(noClaims);
  });
});
