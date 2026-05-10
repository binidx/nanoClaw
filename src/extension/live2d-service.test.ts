import { describe, expect, it } from 'vitest';

import { decodeZipEntryName } from './live2d-service.js';

describe('decodeZipEntryName', () => {
  it('decodes UTF-8 zip entry names unchanged', () => {
    const raw = Buffer.from('naxida_live2d/sounds/没去过的地方还有很多呢.mp3', 'utf8');

    expect(decodeZipEntryName(raw)).toBe('naxida_live2d/sounds/没去过的地方还有很多呢.mp3');
  });

  it('falls back to GBK for non-UTF8 zip entry names', () => {
    const raw = Buffer.from([
      0x73, 0x6f, 0x75, 0x6e, 0x64, 0x73, 0x2f,
      0xc4, 0xe3, 0xba, 0xc3,
      0x2e, 0x6d, 0x70, 0x33,
    ]);

    expect(decodeZipEntryName(raw)).toBe('sounds/你好.mp3');
  });
});
