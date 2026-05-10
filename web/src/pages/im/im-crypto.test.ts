import { describe, expect, it } from 'vitest';

import { getImSubtleCrypto, type ImCryptoSource } from './im-crypto';

describe('IM WebCrypto support', () => {
  it('uses standard crypto.subtle when available', () => {
    const subtle = {} as SubtleCrypto;

    expect(getImSubtleCrypto({ subtle })).toBe(subtle);
  });

  it('falls back to legacy webkitSubtle when available', () => {
    const subtle = {} as SubtleCrypto;

    expect(getImSubtleCrypto({ webkitSubtle: subtle })).toBe(subtle);
  });

  it('fails clearly when SubtleCrypto is unavailable', () => {
    expect(() => getImSubtleCrypto({} as ImCryptoSource)).toThrow(
      '端到端加密需要浏览器支持 Web Crypto crypto.subtle。',
    );
  });
});
