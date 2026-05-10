import { describe, expect, it } from 'vitest';

import {
  loadBuiltinWebFetchSiteProfilePresets,
  loadBuiltinWebFetchSiteProfiles,
} from './web/web-fetch-site-profiles.js';

describe('web-fetch-site-profiles', () => {
  it('loads builtin presets from the shared source of truth', () => {
    const presets = loadBuiltinWebFetchSiteProfilePresets();
    const profiles = loadBuiltinWebFetchSiteProfiles();

    expect(presets.length).toBeGreaterThan(0);
    expect(profiles).toHaveLength(presets.length);
    expect(presets.map((preset) => preset.id)).toEqual([
      'cloud-tencent',
      'wechat-article',
      'zhihu-zhuanlan',
      'juejin-post',
      '36kr-article',
    ]);
    expect(profiles).toEqual(presets.map((preset) => preset.profile));
    expect(presets[0]?.profile).toMatchObject({
      domains: ['cloud.tencent.com'],
      pathPrefixes: ['/developer/article/'],
      forceProvider: 'browser_cli',
      waitSelector:
        '.com-markdown-collpase-main,.article-detail__content,.J-articlePanel',
      viewport: '1440x1200',
      userAgent: '',
    });
  });
});
