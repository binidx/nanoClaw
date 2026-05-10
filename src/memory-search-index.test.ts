import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearMemorySearchIndex,
  initializeMemorySearchIndex,
  searchMemorySearchIndex,
  upsertMemorySearchIndexDocuments,
} from './memory/search-index.js';

describe('memory search index', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeMemorySearchIndex(db);
  });

  afterEach(() => {
    db.close();
  });

  it('indexes normalized documents and returns the most relevant result first', () => {
    upsertMemorySearchIndexDocuments(db, [
      {
        docId: 'memory-1',
        scope: 'group',
        ownerType: 'group',
        ownerId: 'alpha-room',
        pathRef: 'group:memory/2026-03-19.md',
        sourceType: 'memory_file',
        title: 'Deployment preferences',
        body: 'The user prefers Friday night deployments and concise release notes.',
        updatedAt: '2026-03-19T10:00:00.000Z',
      },
      {
        docId: 'summary-1',
        scope: 'group',
        ownerType: 'chat',
        ownerId: 'alpha@g.us',
        pathRef: null,
        sourceType: 'compaction_summary',
        title: 'Earlier conversation summary',
        body: 'We discussed deployment sequencing and release review ownership.',
        updatedAt: '2026-03-18T10:00:00.000Z',
      },
    ]);

    const results = searchMemorySearchIndex(db, 'Friday deployment', {
      limit: 5,
      now: new Date('2026-03-20T00:00:00.000Z'),
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.docId).toBe('memory-1');
    expect(results[0]?.pathRef).toBe('group:memory/2026-03-19.md');
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score || 0);
  });

  it('applies source boosting so identity memory outranks similar group memory', () => {
    upsertMemorySearchIndexDocuments(db, [
      {
        docId: 'group-memory',
        scope: 'group',
        ownerType: 'group',
        ownerId: 'alpha-room',
        pathRef: 'group:memory/2026-03-19.md',
        sourceType: 'memory_file',
        title: 'Reply preferences',
        body: 'The user likes concise replies.',
        updatedAt: '2026-03-19T08:00:00.000Z',
      },
      {
        docId: 'identity-memory',
        scope: 'identity',
        ownerType: 'person',
        ownerId: 'person-alice',
        pathRef: 'identity:memory/profile.md',
        sourceType: 'identity_memory',
        title: 'Alice profile',
        body: 'Alice likes concise replies.',
        updatedAt: '2026-03-19T08:00:00.000Z',
      },
    ]);

    const results = searchMemorySearchIndex(db, 'concise replies', {
      limit: 5,
      now: new Date('2026-03-20T00:00:00.000Z'),
    });

    expect(results.map((entry) => entry.docId)).toEqual([
      'identity-memory',
      'group-memory',
    ]);
    expect(results[0]?.sourceBoost).toBeGreaterThan(results[1]?.sourceBoost || 0);
  });

  it('supports scope and source-type filtering', () => {
    upsertMemorySearchIndexDocuments(db, [
      {
        docId: 'identity-memory',
        scope: 'identity',
        ownerType: 'person',
        ownerId: 'person-alice',
        sourceType: 'identity_memory',
        title: 'Alice profile',
        body: 'Alice prefers concise replies.',
        updatedAt: '2026-03-19T10:00:00.000Z',
      },
      {
        docId: 'global-memory',
        scope: 'global',
        ownerType: 'global',
        ownerId: 'global',
        sourceType: 'memory_file',
        title: 'Global defaults',
        body: 'The default reply style is detailed.',
        updatedAt: '2026-03-19T10:00:00.000Z',
      },
    ]);

    const filtered = searchMemorySearchIndex(db, 'reply style', {
      scopes: ['global'],
      sourceTypeFilter: ['memory_file'],
      limit: 5,
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.docId).toBe('global-memory');
  });

  it('lets newer documents edge out older ties through recency boosting', () => {
    upsertMemorySearchIndexDocuments(db, [
      {
        docId: 'older-memory',
        scope: 'group',
        ownerType: 'group',
        ownerId: 'alpha-room',
        sourceType: 'memory_file',
        title: 'Release policy',
        body: 'Release checklist requires concise release notes.',
        updatedAt: '2026-02-01T10:00:00.000Z',
      },
      {
        docId: 'newer-memory',
        scope: 'group',
        ownerType: 'group',
        ownerId: 'alpha-room',
        sourceType: 'memory_file',
        title: 'Release policy',
        body: 'Release checklist requires concise release notes.',
        updatedAt: '2026-03-19T10:00:00.000Z',
      },
    ]);

    const results = searchMemorySearchIndex(db, 'concise release notes', {
      limit: 5,
      now: new Date('2026-03-20T10:00:00.000Z'),
      recencyHalfLifeDays: 14,
    });

    expect(results.map((entry) => entry.docId)).toEqual([
      'newer-memory',
      'older-memory',
    ]);
    expect(results[0]?.recencyBoost).toBeGreaterThan(
      results[1]?.recencyBoost || 0,
    );
  });

  it('replaces prior indexed content when the same document id is upserted again', () => {
    upsertMemorySearchIndexDocuments(db, [
      {
        docId: 'memory-1',
        scope: 'group',
        ownerType: 'group',
        ownerId: 'alpha-room',
        sourceType: 'memory_file',
        title: 'Reply preferences',
        body: 'The user likes concise replies.',
        updatedAt: '2026-03-18T10:00:00.000Z',
      },
    ]);
    upsertMemorySearchIndexDocuments(db, [
      {
        docId: 'memory-1',
        scope: 'group',
        ownerType: 'group',
        ownerId: 'alpha-room',
        sourceType: 'memory_file',
        title: 'Reply preferences',
        body: 'The user prefers detailed replies.',
        updatedAt: '2026-03-19T10:00:00.000Z',
      },
    ]);

    const replacedResults = searchMemorySearchIndex(db, 'likes concise', {
      limit: 5,
    });
    const detailedResults = searchMemorySearchIndex(db, 'prefers detailed', {
      limit: 5,
    });

    expect(replacedResults).toHaveLength(0);
    expect(detailedResults).toHaveLength(1);
    expect(detailedResults[0]?.docId).toBe('memory-1');
  });

  it('clears indexed documents when requested', () => {
    upsertMemorySearchIndexDocuments(db, [
      {
        docId: 'memory-1',
        scope: 'group',
        ownerType: 'group',
        ownerId: 'alpha-room',
        sourceType: 'memory_file',
        title: 'Reply preferences',
        body: 'The user likes concise replies.',
        updatedAt: '2026-03-18T10:00:00.000Z',
      },
    ]);

    clearMemorySearchIndex(db);

    expect(searchMemorySearchIndex(db, 'concise replies', { limit: 5 })).toEqual(
      [],
    );
  });

  it('falls back to substring matching for short CJK queries', () => {
    upsertMemorySearchIndexDocuments(db, [
      {
        docId: 'global-preference',
        scope: 'global',
        ownerType: 'global',
        ownerId: 'global',
        pathRef: 'global:memory/2026-03-20.md',
        sourceType: 'memory_file',
        title: '全局偏好',
        body: '以后默认用中文回复。',
        updatedAt: '2026-03-20T08:00:00.000Z',
      },
      {
        docId: 'group-rule',
        scope: 'group',
        ownerType: 'group',
        ownerId: 'alpha-room',
        pathRef: 'group:memory/2026-03-20.md',
        sourceType: 'memory_file',
        title: '项目规则',
        body: '这个项目里默认不要用表格，优先给命令行步骤。',
        updatedAt: '2026-03-20T09:00:00.000Z',
      },
    ]);

    const preferenceResults = searchMemorySearchIndex(db, '中文回复', {
      scopes: ['global'],
      ownerType: 'global',
      ownerId: 'global',
      sourceTypeFilter: ['memory_file'],
      limit: 5,
    });
    const projectRuleResults = searchMemorySearchIndex(db, '命令行步骤', {
      scopes: ['group'],
      ownerType: 'group',
      ownerId: 'alpha-room',
      sourceTypeFilter: ['memory_file'],
      limit: 5,
    });

    expect(preferenceResults[0]?.docId).toBe('global-preference');
    expect(preferenceResults[0]?.body).toContain('以后默认用中文回复');
    expect(projectRuleResults[0]?.docId).toBe('group-rule');
    expect(projectRuleResults[0]?.body).toContain('优先给命令行步骤');
  });
});
