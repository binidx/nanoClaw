import { describe, expect, it } from 'vitest';

import { shouldFetchConversationSnapshot } from './im-cache';

describe('IM conversation cache', () => {
  it('fetches when there is no cached snapshot', () => {
    expect(shouldFetchConversationSnapshot(undefined, 10_000, 30_000)).toBe(true);
  });

  it('reuses a fresh cached snapshot', () => {
    expect(
      shouldFetchConversationSnapshot(
        {
          lastLoadedAt: 90_000,
          messages: [],
          members: [],
          detail: null,
          hasMoreOlder: true,
        },
        100_000,
        30_000,
      ),
    ).toBe(false);
  });

  it('refreshes stale cached snapshots', () => {
    expect(
      shouldFetchConversationSnapshot(
        {
          lastLoadedAt: 50_000,
          messages: [],
          members: [],
          detail: null,
          hasMoreOlder: false,
        },
        100_000,
        30_000,
      ),
    ).toBe(true);
  });
});
