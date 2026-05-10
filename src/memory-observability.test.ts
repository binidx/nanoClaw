import express from 'express';
import inject from 'light-my-request';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  compactContextEntries,
  enqueueContextCompactionJob,
  recordMemorySearchEvent,
  setConfig,
  storeChatMetadata,
  storeContextEntries,
  upsertMemoryDocumentSyncStates,
} from './db.js';
import { runScheduledContextCompactionPass } from './memory/compaction-scheduler.js';
import { registerSystemReadRoutes } from './routes/system-read-routes.js';

function createApp(): express.Express {
  const app = express();
  registerSystemReadRoutes(app, {
    getSanitizedWebConfig: () => ({}),
    getChannelStatus: () => [],
    getAgentStatus: () => ({ activeAgents: 1, queuedTasks: 0 }),
    isWebTerminalEnabled: () => false,
  });
  return app;
}

function expectOptionalNonNegativeNumber(
  value: unknown,
  label: string,
): void {
  expect(
    typeof value === 'number' && Number.isFinite(value) && value >= 0,
    `${label} should be a non-negative number`,
  ).toBe(true);
}

function expectOptionalIsoTimestampOrNull(
  value: unknown,
  label: string,
): void {
  expect(
    value === null ||
      (typeof value === 'string' && !Number.isNaN(Date.parse(value))),
    `${label} should be an ISO timestamp or null`,
  ).toBe(true);
}

function expectSearchOptimizationMetrics(search: Record<string, any>): void {
  const numericFields = [
    'indexedHitCount24h',
    'indexedResultCount24h',
    'searchFollowupReadCount24h',
    'fallbackSyncCount24h',
    'freshnessRecheckCount24h',
    'filesSynced24h',
    'filesSkipped24h',
    'filesDeleted24h',
  ] as const;

  for (const field of numericFields) {
    if (field in search) {
      expectOptionalNonNegativeNumber(search[field], `search.${field}`);
    }
  }

  const timestampFields = ['lastSyncPassAt'] as const;
  for (const field of timestampFields) {
    if (field in search) {
      expectOptionalIsoTimestampOrNull(search[field], `search.${field}`);
    }
  }
  if ('followupReadRate24h' in search) {
    expect(
      search.followupReadRate24h === null ||
        (typeof search.followupReadRate24h === 'number' &&
          Number.isFinite(search.followupReadRate24h) &&
          search.followupReadRate24h >= 0),
      'search.followupReadRate24h should be null or a non-negative number',
    ).toBe(true);
  }
  if ('byScope' in search && search.byScope != null) {
    expect(typeof search.byScope).toBe('object');
    for (const scope of ['group', 'global'] as const) {
      const bucket = (search.byScope as Record<string, any>)[scope];
      expect(bucket).toBeTruthy();
      for (const field of [
        'indexedResults24h',
        'followupReads24h',
        'recalls24h',
      ] as const) {
        expectOptionalNonNegativeNumber(
          bucket[field],
          `search.byScope.${scope}.${field}`,
        );
      }
      expect(
        bucket.followupReadRate24h === null ||
          (typeof bucket.followupReadRate24h === 'number' &&
            Number.isFinite(bucket.followupReadRate24h) &&
            bucket.followupReadRate24h >= 0),
        `search.byScope.${scope}.followupReadRate24h should be null or a non-negative number`,
      ).toBe(true);
    }
  }
  if ('bySource' in search && search.bySource != null) {
    expect(typeof search.bySource).toBe('object');
    for (const [source, bucket] of Object.entries(
      search.bySource as Record<string, any>,
    )) {
      for (const field of [
        'indexedResults24h',
        'followupReads24h',
        'recalls24h',
      ] as const) {
        expectOptionalNonNegativeNumber(
          bucket[field],
          `search.bySource.${source}.${field}`,
        );
      }
      expect(
        bucket.followupReadRate24h === null ||
          (typeof bucket.followupReadRate24h === 'number' &&
            Number.isFinite(bucket.followupReadRate24h) &&
            bucket.followupReadRate24h >= 0),
        `search.bySource.${source}.followupReadRate24h should be null or a non-negative number`,
      ).toBe(true);
    }
  }
  if ('topGroups' in search) {
    expect(Array.isArray(search.topGroups), 'search.topGroups should be an array').toBe(
      true,
    );
    for (const [index, bucket] of (search.topGroups as Array<Record<string, any>>).entries()) {
      expect(typeof bucket.groupFolder).toBe('string');
      expectOptionalNonNegativeNumber(
        bucket.indexedResults24h,
        `search.topGroups[${index}].indexedResults24h`,
      );
      expectOptionalNonNegativeNumber(
        bucket.followupReads24h,
        `search.topGroups[${index}].followupReads24h`,
      );
      expectOptionalNonNegativeNumber(
        bucket.recalls24h,
        `search.topGroups[${index}].recalls24h`,
      );
      expect(
        bucket.followupReadRate24h === null ||
          (typeof bucket.followupReadRate24h === 'number' &&
            Number.isFinite(bucket.followupReadRate24h) &&
            bucket.followupReadRate24h >= 0),
        `search.topGroups[${index}].followupReadRate24h should be null or a non-negative number`,
      ).toBe(true);
    }
  }

  if ('sync' in search && search.sync != null) {
    expect(typeof search.sync).toBe('object');
    const sync = search.sync as Record<string, any>;
    const syncNumericFields = [
      'indexedResultCount24h',
      'searchFollowupReadCount24h',
      'filesSynced24h',
      'filesSkipped24h',
      'filesDeleted24h',
      'fallbackSyncCount24h',
      'freshnessRecheckCount24h',
      'indexedHitCount24h',
    ] as const;
    for (const field of syncNumericFields) {
      if (field in sync) {
        expectOptionalNonNegativeNumber(sync[field], `search.sync.${field}`);
      }
    }
    if ('lastSyncPassAt' in sync) {
      expectOptionalIsoTimestampOrNull(
        sync.lastSyncPassAt,
        'search.sync.lastSyncPassAt',
      );
    }
    if ('followupReadRate24h' in sync) {
      expect(
        sync.followupReadRate24h === null ||
          (typeof sync.followupReadRate24h === 'number' &&
            Number.isFinite(sync.followupReadRate24h) &&
            sync.followupReadRate24h >= 0),
        'search.sync.followupReadRate24h should be null or a non-negative number',
      ).toBe(true);
    }
  }
}

describe('memory observability routes', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _initTestDatabase();
  });

  it('returns effective config, ledger stats, and latest compaction details', async () => {
    const chatJid = 'memory-observability@g.us';
    const now = new Date();
    const recent1 = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const recent2 = new Date(now.getTime() - 50 * 60 * 1000).toISOString();
    const recent3 = new Date(now.getTime() - 40 * 60 * 1000).toISOString();
    const recent4 = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

    await setConfig('MEMORY_SEARCH_MAX_RESULTS', '7');
    await setConfig('MEMORY_PROMPT_MAX_SNIPPETS', '4');
    await setConfig('MEMORY_COMPACTION_TRIGGER_ENTRIES', '2');
    await setConfig('MEMORY_COMPACTION_KEEP_RECENT_ENTRIES', '1');
    await storeChatMetadata(chatJid, recent1);
    await storeContextEntries([
      {
        id: 'msg:memory-observability:user-1',
        group_folder: 'obs-group',
        chat_jid: chatJid,
        run_id: 'run-1',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-1',
        content_text: 'first user message',
        content_json: null,
        token_estimate: 4,
        created_at: recent1,
      },
      {
        id: 'msg:memory-observability:assistant-1',
        group_folder: 'obs-group',
        chat_jid: chatJid,
        run_id: 'run-1',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-1',
        content_text: 'first assistant reply',
        content_json: null,
        token_estimate: 4,
        created_at: recent2,
      },
      {
        id: 'msg:memory-observability:user-2',
        group_folder: 'obs-group',
        chat_jid: chatJid,
        run_id: 'run-2',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-2',
        content_text: 'second user message',
        content_json: null,
        token_estimate: 4,
        created_at: recent3,
      },
      {
        id: 'msg:memory-observability:assistant-2',
        group_folder: 'obs-group',
        chat_jid: chatJid,
        run_id: 'run-2',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-2',
        content_text: 'second assistant reply',
        content_json: null,
        token_estimate: 4,
        created_at: recent4,
      },
    ]);
    await compactContextEntries({
      chatJid,
      triggerEntries: 2,
      keepRecentEntries: 1,
    });
    await upsertMemoryDocumentSyncStates([
      {
        path_ref: 'group:memory/2026-03-19.md',
        scope: 'group',
        owner_type: 'group',
        owner_id: 'obs-group',
        source_type: 'memory_file',
        file_mtime_ms: 1,
        file_size: 128,
        content_hash: 'hash-1',
        last_synced_at: recent4,
      },
    ]);
    await recordMemorySearchEvent({
      eventType: 'search_index_hit',
      scope: 'group',
      ownerType: 'group',
      ownerId: 'obs-group',
      metadataJson: JSON.stringify({
        resultCount: 2,
        scopeCounts: {
          group: 2,
          global: 0,
        },
        sourceTypeCounts: {
          memory_file: 2,
        },
        memoryClassCounts: {
          group_durable: 2,
        },
      }),
      createdAt: recent4,
    });
    await recordMemorySearchEvent({
      eventType: 'search_index_hit',
      scope: 'all',
      ownerType: 'group',
      ownerId: 'obs-group',
      metadataJson: JSON.stringify({
        resultCount: 3,
        scopeCounts: {
          group: 1,
          global: 2,
        },
        sourceTypeCounts: {
          identity_memory: 1,
          memory_file: 2,
        },
        memoryClassCounts: {
          identity: 1,
          global_durable: 2,
        },
      }),
      createdAt: recent4,
    });
    await recordMemorySearchEvent({
      eventType: 'search_followup_read',
      pathRef: 'group:memory/2026-03-19.md',
      scope: 'group',
      ownerType: 'group',
      ownerId: 'obs-group',
      metadataJson: JSON.stringify({
        sourceType: 'memory_file',
        memoryClass: 'group_durable',
      }),
      createdAt: recent4,
    });
    await recordMemorySearchEvent({
      eventType: 'search_followup_read',
      pathRef: 'global:memory/2026-03-19.md',
      scope: 'global',
      ownerType: 'global',
      ownerId: 'global',
      metadataJson: JSON.stringify({
        sourceType: 'identity_memory',
        memoryClass: 'identity',
      }),
      createdAt: recent4,
    });
    await recordMemorySearchEvent({
      eventType: 'search_fallback_sync',
      scope: 'group',
      ownerType: 'group',
      ownerId: 'obs-group',
      createdAt: recent4,
    });
    await recordMemorySearchEvent({
      eventType: 'search_freshness_recheck',
      pathRef: 'group:memory/2026-03-19.md',
      scope: 'group',
      ownerType: 'group',
      ownerId: 'obs-group',
      createdAt: recent4,
    });
    await recordMemorySearchEvent({
      eventType: 'search_stale_refresh',
      pathRef: 'group:memory/2026-03-19.md',
      scope: 'group',
      ownerType: 'group',
      ownerId: 'obs-group',
      createdAt: recent4,
    });
    await recordMemorySearchEvent({
      eventType: 'sync_file_updated',
      pathRef: 'group:memory/2026-03-19.md',
      scope: 'group',
      ownerType: 'group',
      ownerId: 'obs-group',
      createdAt: recent4,
    });
    await recordMemorySearchEvent({
      eventType: 'sync_file_skipped',
      pathRef: 'group:memory/2026-03-19.md',
      scope: 'group',
      ownerType: 'group',
      ownerId: 'obs-group',
      createdAt: recent4,
    });
    await recordMemorySearchEvent({
      eventType: 'sync_file_deleted',
      pathRef: 'group:memory/2026-03-19.md',
      scope: 'group',
      ownerType: 'group',
      ownerId: 'obs-group',
      createdAt: recent4,
    });

    const response = await inject(createApp(), {
      method: 'GET',
      url: '/api/memory/status',
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json<Record<string, any>>();

      expect(payload.config).toMatchObject({
        enabled: true,
        readEnabled: true,
        writeEnabled: true,
        writeMode: 'daily-only',
        searchMaxResults: 7,
        promptMaxSnippets: 4,
        promptTokenBudget: 0,
        promptRecentRatio: 35,
        promptSummaryRatio: 25,
        promptRecallRatio: 25,
        compactionTriggerEntries: 40,
        compactionKeepRecentEntries: 1,
      });
      expect(payload.ledger.totalEntries).toBe(4);
      expect(payload.ledger.recentEntries24h).toBe(4);
      expect(payload.ledger.lastEntryAt).toBe(recent4);
      expect(payload.ledger.bySourceType).toMatchObject({
        chat_message: 2,
        assistant_message: 2,
      });
      expect(payload.compaction.totalCompactions).toBe(1);
      expect(payload.compaction.recentCompactions24h).toBe(1);
      expect(payload.compaction.latest).toMatchObject({
        chatJid,
        groupFolder: 'obs-group',
        compactedUntil: recent3,
        sourceEntryCount: 3,
      });
      expect(payload.compaction.latest.summaryPreview).toContain(
        'Earlier conversation summary',
      );
      expect(payload.promotion).toMatchObject({
        candidates24h: 0,
        writes24h: 0,
        deduped24h: 0,
        byAction24h: {
          auto: 0,
          remember: 0,
          session_only: 0,
        },
        byMemoryClass24h: {
          identity: 0,
          global_durable: 0,
          group_durable: 0,
          session: 0,
          unknown: 0,
        },
      });
      expect(payload.identity).toMatchObject({
        totalProfiles: 0,
        boundConversations: 0,
        aliases: 0,
      });
      expect(payload.search).toMatchObject({
        indexedDocuments: 0,
        syncStateDocuments: 1,
        recallCount24h: 0,
        indexedHitCount24h: 2,
        indexedResultCount24h: 5,
        searchFollowupReadCount24h: 2,
        fallbackSyncCount24h: 1,
        freshnessRecheckCount24h: 1,
        staleRefreshCount24h: 1,
        filesSynced24h: 1,
        filesSkipped24h: 1,
        filesDeleted24h: 1,
      });
      expect(payload.search.byScope).toMatchObject({
        group: {
          indexedResults24h: 3,
          followupReads24h: 1,
          recalls24h: 0,
        },
        global: {
          indexedResults24h: 2,
          followupReads24h: 1,
          recalls24h: 0,
        },
      });
      expect(payload.search.bySource).toMatchObject({
        group_durable: {
          indexedResults24h: 2,
          followupReads24h: 1,
          recalls24h: 0,
        },
        global_durable: {
          indexedResults24h: 2,
          followupReads24h: 0,
          recalls24h: 0,
        },
        identity: {
          indexedResults24h: 1,
          followupReads24h: 1,
          recalls24h: 0,
        },
      });
      expect(payload.search.topGroups).toEqual([
        expect.objectContaining({
          groupFolder: 'obs-group',
          indexedResults24h: 5,
          followupReads24h: 1,
          recalls24h: 0,
        }),
      ]);
      expectSearchOptimizationMetrics(payload.search);
      expect(payload.prompt).toMatchObject({
        lastAssembledTokenEstimate: null,
        lastRecentTokens: null,
        lastSummaryTokens: null,
        lastRecallTokens: null,
      });
  });

  it('embeds memory observability inside /api/status', async () => {
    const response = await inject(createApp(), {
      method: 'GET',
      url: '/api/status',
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json<Record<string, any>>();

      expect(payload.memory).toBeTruthy();
      expect(payload.memory.config.enabled).toBe(true);
      expect(payload.memory.ledger.totalEntries).toBe(0);
      expect(payload.memory.compaction.totalCompactions).toBe(0);
      expect(payload.memory.promotion.candidates24h).toBe(0);
      expect(payload.memory.promotion.byAction24h).toMatchObject({
        auto: 0,
        remember: 0,
        session_only: 0,
      });
      expect(payload.memory.identity.totalProfiles).toBe(0);
      expect(payload.memory.search.indexedDocuments).toBe(0);
      expectSearchOptimizationMetrics(payload.memory.search);
      expect(payload.memory.prompt.lastAssembledTokenEstimate).toBeNull();
  });

  it('tracks explicit remember and session-only actions inside promotion observability', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    await storeChatMetadata('memory-obs-explicit', recent, 'Web User', 'web', false);
    await storeContextEntries([
      {
        id: 'memory_promotion:explicit:remember',
        group_folder: 'obs-group',
        chat_jid: 'memory-obs-explicit',
        run_id: null,
        provider: 'system',
        role: 'memory',
        source_type: 'memory_promotion',
        source_ref: 'msg-remember',
        content_text: '我叫 ady',
        content_json: JSON.stringify({
          status: 'written',
          kind: 'identity',
          confidence: 'high',
          origin: 'explicit_action',
          action: 'remember',
          memoryClass: 'identity',
          path: 'global:memory/identity/ady.md',
          sourceEntryIds: ['msg-remember'],
        }),
        token_estimate: 2,
        created_at: recent,
      },
      {
        id: 'memory_promotion:explicit:session',
        group_folder: 'obs-group',
        chat_jid: 'memory-obs-explicit',
        run_id: null,
        provider: 'system',
        role: 'memory',
        source_type: 'memory_promotion',
        source_ref: 'msg-session',
        content_text: '这次先别用表格',
        content_json: JSON.stringify({
          status: 'written',
          kind: 'commitment',
          confidence: 'high',
          origin: 'explicit_action',
          action: 'session_only',
          memoryClass: 'session',
          sourceEntryIds: ['msg-session'],
        }),
        token_estimate: 4,
        created_at: recent,
      },
    ]);

    const response = await inject(createApp(), {
      method: 'GET',
      url: '/api/memory/status',
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json<Record<string, any>>();

      expect(payload.promotion.byAction24h).toMatchObject({
        auto: 0,
        remember: 1,
        session_only: 1,
      });
      expect(payload.promotion.byOrigin24h).toMatchObject({
        explicit_action: 2,
      });
      expect(payload.promotion.byMemoryClass24h).toMatchObject({
        identity: 1,
        session: 1,
      });
  });

  it('reports background compaction worker activity in memory status', async () => {
    const chatJid = 'memory-observability-worker@g.us';
    await storeChatMetadata(chatJid, '2026-03-18T12:00:00.000Z');
    await setConfig('MEMORY_COMPACTION_ENABLED', 'true');
    await setConfig('MEMORY_COMPACTION_TRIGGER_ENTRIES', '4');
    await setConfig('MEMORY_COMPACTION_KEEP_RECENT_ENTRIES', '2');
    await storeContextEntries([
      {
        id: 'msg:memory-observability-worker:user-1',
        group_folder: 'obs-group',
        chat_jid: chatJid,
        run_id: 'run-1',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-1',
        content_text: 'first user message',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T12:00:01.000Z',
      },
      {
        id: 'msg:memory-observability-worker:assistant-1',
        group_folder: 'obs-group',
        chat_jid: chatJid,
        run_id: 'run-1',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-1',
        content_text: 'first assistant reply',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T12:00:02.000Z',
      },
      {
        id: 'msg:memory-observability-worker:user-2',
        group_folder: 'obs-group',
        chat_jid: chatJid,
        run_id: 'run-2',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-2',
        content_text: 'second user message',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T12:00:03.000Z',
      },
      {
        id: 'msg:memory-observability-worker:assistant-2',
        group_folder: 'obs-group',
        chat_jid: chatJid,
        run_id: 'run-2',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-2',
        content_text: 'second assistant reply',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T12:00:04.000Z',
      },
      {
        id: 'msg:memory-observability-worker:user-3',
        group_folder: 'obs-group',
        chat_jid: chatJid,
        run_id: 'run-3',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-3',
        content_text: 'third user message',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T12:00:05.000Z',
      },
    ]);
    await enqueueContextCompactionJob({
      chatJid,
      groupFolder: 'obs-group',
      now: '2026-03-18T12:00:06.000Z',
    });
    await runScheduledContextCompactionPass({
      now: new Date('2026-03-18T12:00:10.000Z'),
      onlyChatJid: chatJid,
    });

    const response = await inject(createApp(), {
      method: 'GET',
      url: '/api/memory/status',
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json<Record<string, any>>();

      expect(payload.compaction.worker).toMatchObject({
        pendingJobs: 0,
        runningJobs: 0,
        recentRuns24h: 1,
        recentFailures24h: 0,
      });
      expect(payload.compaction.worker.lastSuccessAt).toBeTruthy();
      expect(payload.compaction.worker.lastDurationMs).not.toBeNull();
  });

  it('reports normalized effective config instead of raw invalid toggles', async () => {
    await setConfig('MEMORY_ENABLED', 'false');
    await setConfig('MEMORY_READ_ENABLED', 'true');
    await setConfig('MEMORY_GLOBAL_WRITE_ENABLED', 'true');
    await setConfig('MEMORY_AUTO_SAVE_ENABLED', 'true');
    await setConfig('MEMORY_SEARCH_MAX_RESULTS', '0');
    await setConfig('MEMORY_PROMPT_INJECTION_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_MAX_SNIPPETS', '99');
    await setConfig('MEMORY_PROMPT_TOKEN_BUDGET', '99999');
    await setConfig('MEMORY_PROMPT_RECENT_RATIO', '-1');
    await setConfig('MEMORY_PROMPT_SUMMARY_RATIO', '300');
    await setConfig('MEMORY_PROMPT_RECALL_RATIO', 'abc');
    await setConfig('MEMORY_COMPACTION_ENABLED', 'true');
    await setConfig('MEMORY_COMPACTION_TRIGGER_ENTRIES', '2');
    await setConfig('MEMORY_COMPACTION_KEEP_RECENT_ENTRIES', '-1');

    const response = await inject(createApp(), {
      method: 'GET',
      url: '/api/memory/status',
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json<Record<string, any>>();

      expect(payload.config).toMatchObject({
        enabled: false,
        readEnabled: false,
        writeEnabled: false,
        globalWriteEnabled: false,
        autoSaveEnabled: false,
        searchMaxResults: 5,
        promptInjectionEnabled: false,
        promptMaxSnippets: 3,
        promptTokenBudget: 0,
        promptRecentRatio: 35,
        promptSummaryRatio: 25,
        promptRecallRatio: 25,
        compactionEnabled: false,
        compactionTriggerEntries: 40,
        compactionKeepRecentEntries: 12,
      });
  });
});
