import {
  claimContextCompactionJob,
  compactContextEntries,
  completeContextCompactionJobFailure,
  completeContextCompactionJobSuccess,
  enqueueContextCompactionJob,
  getCompactionEligibleContextEntriesPublic,
  getContextEntriesByIds,
  getDueContextCompactionJobs,
  storeMemoryPromotionEntry,
} from '../db.js';
import { MEMORY_COMPACTION_POLL_INTERVAL } from '../config.js';
import { logger } from '../logger.js';

import { getChatContextConfig } from './chat-context-config.js';
import { getMemoryContextConfig } from './context-config.js';
import { runPreCompactionFlush } from './pre-compaction-flush.js';
import {
  classifyMemoryDecision,
  extractDurableMemoryCandidates,
  promoteCandidatesToGroupMemory,
} from './promotion.js';

const MEMORY_COMPACTION_RETRY_DELAY_MS = 30_000;
const MEMORY_COMPACTION_MAX_JOBS_PER_PASS = 20;

let memoryCompactionLoopRunning = false;
let memoryCompactionLoopTimer: ReturnType<typeof setTimeout> | null = null;

async function runClaimedContextCompaction(job: {
  chat_jid: string;
  group_folder: string;
}): Promise<void> {
  const [memoryConfig, chatContextConfig] = await Promise.all([
    getMemoryContextConfig(),
    getChatContextConfig(),
  ]);
  if (
    !memoryConfig.memoryEnabled ||
    !memoryConfig.memoryReadEnabled ||
    !chatContextConfig.compactionEnabled
  ) {
    return;
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  try {
    // Pre-compaction flush: extract durable memories before compression
    try {
      const eligible = await getCompactionEligibleContextEntriesPublic(job.chat_jid);
      const keepRecent = chatContextConfig.chatCompactionKeepRecentEntries;
      const entriesToCompress = eligible.length > keepRecent
        ? eligible.slice(0, -keepRecent)
        : [];
      if (entriesToCompress.length > 0) {
        await runPreCompactionFlush(job.chat_jid, entriesToCompress);
      }
    } catch (flushErr) {
      logger.warn({ err: flushErr, chatJid: job.chat_jid }, 'Pre-compaction flush failed, continuing with compaction');
    }

    const summary = await compactContextEntries({
      chatJid: job.chat_jid,
      triggerEntries: chatContextConfig.chatCompactionTriggerEntries,
      keepRecentEntries: chatContextConfig.chatCompactionKeepRecentEntries,
    });
    if (summary) {
      const sourceEntryIds = (() => {
        try {
          const parsed = JSON.parse(summary.source_entry_ids_json) as unknown;
          return Array.isArray(parsed)
            ? parsed.filter((value): value is string => typeof value === 'string')
            : [];
        } catch {
          return [];
        }
      })();
      const sourceEntries = [...(await getContextEntriesByIds(sourceEntryIds))].sort((a, b) =>
        a.created_at.localeCompare(b.created_at),
      );
      const candidates = await extractDurableMemoryCandidates(sourceEntries);
      for (const candidate of candidates) {
        await storeMemoryPromotionEntry({
          groupFolder: job.group_folder,
          chatJid: job.chat_jid,
          compactionId: summary.id,
          candidate,
          status: 'candidate',
          action: 'auto',
          memoryClass:
            classifyMemoryDecision(candidate.text) === 'identity'
              ? 'identity'
              : classifyMemoryDecision(candidate.text) === 'global_durable'
                ? 'global_durable'
                : 'group_durable',
          origin: 'compaction_candidate',
        });
      }
      if (memoryConfig.autoSaveEnabled && candidates.length > 0) {
        const results = promoteCandidatesToGroupMemory(job.group_folder, candidates);
        for (const result of results) {
          await storeMemoryPromotionEntry({
            groupFolder: job.group_folder,
            chatJid: job.chat_jid,
            compactionId: summary.id,
            candidate: result.candidate,
            status: result.status,
            pathRef: result.pathRef,
            action: 'auto',
            memoryClass: result.memoryClass,
            origin: 'compaction_candidate',
          });
        }
      }
    }
    const finishedAt = new Date().toISOString();
    await completeContextCompactionJobSuccess({
      chatJid: job.chat_jid,
      groupFolder: job.group_folder,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.now() - startedMs),
      resultSummaryId: summary?.id || null,
    });
  } catch (err) {
    const finishedAt = new Date().toISOString();
    await completeContextCompactionJobFailure({
      chatJid: job.chat_jid,
      groupFolder: job.group_folder,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.now() - startedMs),
      error: err instanceof Error ? err.message : String(err || 'Unknown error'),
      retryAt: new Date(
        Date.now() + MEMORY_COMPACTION_RETRY_DELAY_MS,
      ).toISOString(),
    });
    logger.warn(
      { chatJid: job.chat_jid, err },
      'Failed to compact context entries from scheduled background pass',
    );
  }
}

export async function runScheduledContextCompactionPass(options?: {
  now?: Date;
  onlyChatJid?: string;
}): Promise<number> {
  const now = options?.now || new Date();
  const dueJobs = await getDueContextCompactionJobs({
    limit: MEMORY_COMPACTION_MAX_JOBS_PER_PASS,
    now: now.toISOString(),
  });
  let processedJobs = 0;

  for (const job of dueJobs) {
    if (options?.onlyChatJid && job.chat_jid !== options.onlyChatJid) {
      continue;
    }
    if (!await claimContextCompactionJob(job.chat_jid, { now: now.toISOString() })) {
      continue;
    }
    await runClaimedContextCompaction(job);
    processedJobs += 1;
  }

  return processedJobs;
}

export function startContextCompactionLoop(): void {
  if (memoryCompactionLoopRunning) {
    logger.debug(
      'Memory compaction loop already running, skipping duplicate start',
    );
    return;
  }
  memoryCompactionLoopRunning = true;
  logger.debug('Memory compaction loop started');

  const loop = () => {
    void runScheduledContextCompactionPass().catch((err) => {
      logger.error({ err }, 'Error in memory compaction loop');
    });
    memoryCompactionLoopTimer = setTimeout(
      loop,
      MEMORY_COMPACTION_POLL_INTERVAL,
    );
  };

  loop();
}

export async function scheduleContextCompaction(input: {
  chatJid: string;
  groupFolder: string;
}): Promise<void> {
  if (!input.chatJid || !input.groupFolder) {
    return;
  }
  await enqueueContextCompactionJob({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
  });
}

export function runScheduledContextCompactionForTest(chatJid: string): void {
  void runScheduledContextCompactionPass({ onlyChatJid: chatJid });
}

export function clearScheduledContextCompactionsForTest(): void {
  if (memoryCompactionLoopTimer) {
    clearTimeout(memoryCompactionLoopTimer);
    memoryCompactionLoopTimer = null;
  }
  memoryCompactionLoopRunning = false;
}
