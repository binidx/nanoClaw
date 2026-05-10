import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  addUserMemory,
  getUserMemories,
  listMemoryDocuments,
  listMemoryEvents,
  searchMemoryDocuments,
} from './db.js';
import { projectUserMemoryToDocument } from './memory/user-memory-documents.js';
import { runConsolidation } from './soul/soul-consolidation.js';
import type { UserMemoryRecord } from './types.js';

describe('soul memory consolidation', () => {
  const userId = 'user-consolidation';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T10:00:00.000Z'));
    _initTestDatabase();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes superseded duplicate memories instead of deleting their history', async () => {
    const baseMemory: UserMemoryRecord = {
      id: 'memory-high-confidence',
      user_id: userId,
      scope: 'global',
      conversation_id: null,
      category: 'preference',
      content: 'User prefers concise answers',
      importance: 7,
      confidence: 0.9,
      source: 'manual',
      tier: 'durable',
      promoted_from: null,
      last_verified_at: null,
      source_event_id: null,
      valid_from: '2026-05-01T00:00:00.000Z',
      valid_to: null,
      access_count: 0,
      last_accessed_at: null,
      expires_at: null,
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    };
    const weakerMemory: UserMemoryRecord = {
      ...baseMemory,
      id: 'memory-low-confidence',
      content: 'User prefers concise replies',
      importance: 6,
      confidence: 0.55,
      created_at: '2026-05-02T00:00:00.000Z',
      updated_at: '2026-05-02T00:00:00.000Z',
    };

    await addUserMemory(baseMemory);
    await addUserMemory(weakerMemory);
    await projectUserMemoryToDocument(baseMemory.id);
    await projectUserMemoryToDocument(weakerMemory.id);

    const log = await runConsolidation(userId, 'manual');
    expect(log.merged).toBe(1);

    const allMemories = await getUserMemories(userId, {
      limit: 10,
      timeScope: 'all',
    });
    expect(allMemories).toHaveLength(2);
    expect(allMemories.find((memory) => memory.id === baseMemory.id)?.valid_to).toBeNull();
    expect(allMemories.find((memory) => memory.id === weakerMemory.id)?.valid_to).toBe(
      '2026-05-03T10:00:00.000Z',
    );

    const currentMemories = await getUserMemories(userId, { limit: 10 });
    expect(currentMemories.map((memory) => memory.id)).toEqual([baseMemory.id]);

    expect(
      (await listMemoryDocuments({
        ownerType: 'global',
        ownerId: userId,
        sourceType: 'user_memory',
        limit: 10,
      })).map((doc) => doc.path_ref),
    ).not.toContain(`user_memory:${weakerMemory.id}`);
    expect(
      await searchMemoryDocuments('concise answers', {
        ownerType: 'global',
        ownerId: userId,
        sourceTypes: ['user_memory'],
      }),
    ).toEqual([
      expect.objectContaining({
        pathRef: `user_memory:${baseMemory.id}`,
      }),
    ]);
    expect(await listMemoryEvents({ actionType: 'MERGE', targetId: baseMemory.id })).toEqual([
      expect.objectContaining({
        metadata_json: JSON.stringify({
          closed_id: weakerMemory.id,
          closed_at: '2026-05-03T10:00:00.000Z',
        }),
      }),
    ]);
  });
});
