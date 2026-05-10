import { describe, expect, it } from 'vitest';

import { createImUuid, type ImRandomSource } from './im-random';

describe('IM random IDs', () => {
  it('uses native randomUUID when available', () => {
    const source: ImRandomSource = {
      randomUUID: () => 'native-id',
      getRandomValues: (array) => {
        throw new Error(`unexpected getRandomValues call: ${array.length}`);
      },
    };

    expect(createImUuid(source)).toBe('native-id');
  });

  it('falls back to getRandomValues with an RFC 4122 v4 UUID', () => {
    const source: ImRandomSource = {
      getRandomValues: (array) => {
        array.set(
          new Uint8Array([
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
            0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
          ]),
        );
        return array;
      },
    };

    expect(createImUuid(source)).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('fails clearly when no secure random source exists', () => {
    expect(() => createImUuid({})).toThrow(
      'Secure random source is required to create an IM UUID',
    );
  });
});
