import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('memory events persistence', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const db = await import('./db.js');
    db._initTestDatabase();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('supports database-backed pagination and filtered counts', async () => {
    const { countMemoryEvents, listMemoryEvents, recordMemoryEvent } =
      await import('./db.js');

    for (let index = 0; index < 5; index++) {
      vi.setSystemTime(new Date(2026, 4, 3, 10, 0, index));
      await recordMemoryEvent({
        user_id: 'user-a',
        scope: 'global',
        action_type: index % 2 === 0 ? 'create' : 'update',
        target_type: 'user_memory',
        target_id: `memory-${index}`,
        conversation_id: null,
        source_message_id: null,
        before_snapshot: null,
        after_snapshot: null,
        decision_reason: null,
        metadata_json: null,
      });
    }
    await recordMemoryEvent({
      user_id: 'user-b',
      scope: 'global',
      action_type: 'create',
      target_type: 'user_memory',
      target_id: 'memory-other',
      conversation_id: null,
      source_message_id: null,
      before_snapshot: null,
      after_snapshot: null,
      decision_reason: null,
      metadata_json: null,
    });

    const page = await listMemoryEvents({
      userId: 'user-a',
      limit: 2,
      offset: 2,
    });
    expect(page.map((event) => event.target_id)).toEqual([
      'memory-2',
      'memory-1',
    ]);
    expect(await countMemoryEvents({ userId: 'user-a' })).toBe(5);
    expect(
      await countMemoryEvents({ userId: 'user-a', actionType: 'create' }),
    ).toBe(3);
  });
});
