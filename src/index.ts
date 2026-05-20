import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { initDatabase, evictStaleUserMemories } from './db.js';
import { writeGroupsSnapshot } from './agent/agent-runner.js';
import { isFeatureEnabled } from './auth/web-security.js';
import { getConfigValue } from './config-store.js';
import { logger } from './logger.js';
import { createWebServer } from './web/web-server.js';
import { startIpcWatcher } from './web/ipc.js';
import { recoverOrphanedSubagentRuntimes } from './subagent/subagent-runtime-registry.js';
import {
  shouldRunFileToDbMigration,
  runFileToDbMigration,
} from './migration/file-to-db-migration.js';
import { hydrateFileSystemFromDb } from './runtime/startup-hydration.js';
import {
  setRepoReviewMessageSender,
  startRepoReviewAutoSyncLoop,
  fixSshKeyPermissions,
  gitEnvForRemote,
} from './repo-review/repo-review-service.js';
import {
  migrateWorktreesFromLegacy,
  cleanupWorktrees,
} from './agent/worktree-manager.js';
import {
  setDigestMessageSender,
  startRepoReviewDigestLoop,
} from './repo-review/repo-review-digest-service.js';
import {
  shouldRunConsolidation,
  runConsolidation,
} from './soul/soul-consolidation.js';
import {
  enqueueTaskRun,
  startSchedulerLoop,
} from './scheduler/task-scheduler.js';
import { startContextCompactionLoop } from './memory/compaction-scheduler.js';
import { startTrashCleanupLoop } from './scheduler/trash-cleanup.js';
import { processQueuedImAiInvocations } from './im/im-ai-service.js';
import type { RegisteredGroup } from './types.js';
import {
  PORT_FILE,
  PID_FILE,
  assignStoredChannelOpts,
  assignRegisteredGroups,
  channels,
  queue,
  registeredGroups,
  sessions,
} from './runtime/runtime-state.js';
import {
  buildChannelOpts,
  connectRegisteredChannels,
  reloadChannels,
  setChannelOptsRegisteredGroupsGetter,
} from './runtime/runtime-channels.js';
import {
  acknowledgePendingAgentOutputViaIpc,
  advanceLastTimestamp,
  createChannelConversation,
  createWebConversation,
  deliverBotReply,
  dispatchPendingMessages,
  getAvailableGroups,
  handleBuiltinInboundMessage,
  handleWebInput,
  interruptConversationReply,
  loadState,
  processGroupMessages,
  queueUploadedFiles,
  regenerateConversationReply,
  recoverPendingMessages,
  refreshTaskSnapshots,
  registerGroup,
  setConversationProviderOverride,
  shouldDispatchRealtimeInboundMessage,
  startMessageLoop,
  updateConversationAccessPolicy,
} from './runtime/runtime-dispatch.js';
import { resetConversationRuntime } from './runtime/runtime-persistence.js';
import { startNonOverlappingBackgroundLoop } from './runtime/background-loop.js';

export { escapeXml, formatMessages } from './router.js';

export { reloadChannels };

export {
  applyTurnEventToPersistenceDrafts,
  finalizePersistedTurnForMessage,
  persistTurnEventSnapshot,
} from './runtime/runtime-persistence.js';

export { buildWebTurnFailureEvents as _buildWebTurnFailureEventsForTest } from './runtime/runtime-persistence.js';

export { getAvailableGroups } from './runtime/runtime-dispatch.js';

export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  assignRegisteredGroups(groups);
}

export {
  _handleBuiltinInboundMessageForTest,
  _shouldDispatchRealtimeInboundMessageForTest,
  _setAgentCursorState,
  _getAgentCursorState,
  _getEffectiveAgentTimestamp,
  _markPendingAgentTimestamp,
  _acknowledgePendingAgentTimestamp,
  _acknowledgePendingAgentOutputViaIpc,
  _queueUploadedFilesForTest,
  _buildAgentPromptInputForTest,
  _selectMessagesFromFirstTriggerForTest,
  _resolveDispatchCandidateMessages,
  _clearPendingUploadedFilesForTest,
  _finalizeSuccessfulAgentRun,
  _finalizeInterruptedAgentRun,
  _hasIpcAcknowledgedOutput,
  _clearPendingAgentTimestamp,
  _clearIpcAcknowledgedOutput,
  _reconcilePersistedPendingAgentTimestamps,
  _runScheduledContextCompactionForTest,
  _clearScheduledContextCompactionsForTest,
  _setLastTimestamp,
  _getLastTimestamp,
  _advanceLastTimestamp,
} from './runtime/runtime-dispatch.js';

function writeRuntimeMarkerFiles(webPort: number): void {
  try {
    fs.writeFileSync(PID_FILE, `${process.pid}\n`, 'utf8');
    fs.writeFileSync(PORT_FILE, `${webPort}\n`, 'utf8');
  } catch (err) {
    logger.warn(
      { err, pidFile: PID_FILE, portFile: PORT_FILE },
      'Failed to write runtime marker files',
    );
  }
}

function removeRuntimeMarkerFiles(): void {
  for (const filePath of [PID_FILE, PORT_FILE]) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      logger.debug({ err, filePath }, 'Failed to remove runtime marker file');
    }
  }
}

async function main(): Promise<void> {
  logger.info({ mode: 'direct' }, 'Starting NanoClaw');
  await initDatabase();

  const allowInsecureTls = isFeatureEnabled(
    await getConfigValue('ALLOW_INSECURE_TLS'),
  );
  if (allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    logger.warn(
      'ALLOW_INSECURE_TLS is enabled; certificate validation is disabled for upstream HTTPS requests',
    );
  } else {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  }

  {
    const { createDbSessionPersistence } =
      await import('./user/user-service.js');
    const { createDatabaseSessionStore } = await import('./auth/web-auth.js');
    const { webAuthRuntime } = await import('./web/web-server.js');
    const dbStore = createDatabaseSessionStore(createDbSessionPersistence());
    await dbStore.loadFromDb();
    webAuthRuntime.replaceSessionStore(dbStore);
  }

  logger.info('Database initialized');
  if (await shouldRunFileToDbMigration()) {
    await runFileToDbMigration();
  }
  await hydrateFileSystemFromDb();
  await loadState();
  const recoveredSubagentRuntimes = recoverOrphanedSubagentRuntimes();
  if (recoveredSubagentRuntimes.recovered > 0) {
    logger.warn(
      recoveredSubagentRuntimes,
      'Recovered stale managed sub-agent runtimes during startup',
    );
  }

  const webPort = parseInt((await getConfigValue('WEB_PORT')) || '3377', 10);
  process.on('exit', removeRuntimeMarkerFiles);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    try {
      await queue.shutdown(10000);
      for (const ch of channels) await ch.disconnect();
    } catch (err) {
      logger.error({ err }, 'Error during graceful shutdown');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(() => process.exit(1));
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch(() => process.exit(1));
  });

  setChannelOptsRegisteredGroupsGetter(() => registeredGroups);
  const channelOpts = buildChannelOpts({
    handleBuiltinInboundMessage,
    advanceLastTimestamp,
    queueUploadedFiles,
    shouldDispatchRealtimeInboundMessage,
    dispatchPendingMessages,
    registerGroup,
  });

  assignStoredChannelOpts(channelOpts);

  await connectRegisteredChannels(channelOpts);

  setRepoReviewMessageSender((jid, message) =>
    deliverBotReply(jid, message.text, message),
  );
  setDigestMessageSender((jid, message) =>
    deliverBotReply(jid, message.text, message),
  );
  startRepoReviewAutoSyncLoop();
  startRepoReviewDigestLoop();

  fixSshKeyPermissions();
  const gitEnv = gitEnvForRemote();
  if (gitEnv.GIT_SSH_COMMAND) {
    process.env.GIT_SSH_COMMAND = gitEnv.GIT_SSH_COMMAND;
  }
  if (gitEnv.GIT_SSL_NO_VERIFY) {
    process.env.GIT_SSL_NO_VERIFY = gitEnv.GIT_SSL_NO_VERIFY;
  }

  void migrateWorktreesFromLegacy().catch((err) =>
    logger.error({ err }, 'Worktree legacy migration failed'),
  );
  setInterval(
    () =>
      void cleanupWorktrees(3).catch((err) =>
        logger.error({ err }, 'Worktree cleanup failed'),
      ),
    24 * 60 * 60_000,
  );
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, agentLabel, groupFolder) =>
      queue.registerProcess(groupJid, proc, agentLabel, groupFolder),
    sendMessage: async (jid, rawText) => {
      try {
        await deliverBotReply(jid, rawText);
      } catch (err) {
        logger.warn({ jid, err }, 'No channel owns JID, cannot send message');
      }
    },
  });
  startContextCompactionLoop();
  startTrashCleanupLoop();
  startNonOverlappingBackgroundLoop({
    name: 'im-ai-invocations',
    intervalMs: 5_000,
    runImmediately: true,
    task: async () => {
      const result = await processQueuedImAiInvocations(3);
      if (result.processed > 0) {
        logger.info(result, 'Processed IM AI invocations');
      }
    },
  });

  const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
  startNonOverlappingBackgroundLoop({
    name: 'memory-maintenance',
    intervalMs: MAINTENANCE_INTERVAL_MS,
    task: async () => {
      try {
        await evictStaleUserMemories();
      } catch (err) {
        logger.warn({ err }, 'Memory eviction pass failed');
      }
      try {
        const { listAllUserIds } = await import('./db.js');
        const { runMemoryMaintenance, shouldRunMaintenance } =
          await import('./memory/memory-maintenance.js');
        const userIds = await listAllUserIds();
        for (const uid of userIds) {
          try {
            if (await shouldRunMaintenance(uid)) {
              await runMemoryMaintenance(uid);
            }
          } catch (err) {
            logger.warn(
              { err, userId: uid },
              'Memory maintenance merge failed for user',
            );
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Memory maintenance pass failed');
      }
    },
  });

  const CONSOLIDATION_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
  startNonOverlappingBackgroundLoop({
    name: 'soul-consolidation',
    intervalMs: CONSOLIDATION_CHECK_INTERVAL_MS,
    task: async () => {
      try {
        const { listAllUserIds } = await import('./db.js');
        const userIds = await listAllUserIds();
        for (const uid of userIds) {
          try {
            if (await shouldRunConsolidation(uid)) {
              await runConsolidation(uid, 'scheduled');
            }
          } catch (err) {
            logger.warn(
              { err, userId: uid },
              'Scheduled consolidation failed for user',
            );
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Consolidation scheduler failed');
      }
    },
  });

  startIpcWatcher({
    sendMessage: (jid, text) => deliverBotReply(jid, text),
    onMessageSent: (jid) => acknowledgePendingAgentOutputViaIpc(jid),
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });

  const webServer = createWebServer({
    port: webPort,
    getChannelStatus: () =>
      channels.flatMap(
        (ch) =>
          ch.getStatusEntries?.() || [
            { name: ch.name, connected: ch.isConnected() },
          ],
      ),
    getAgentStatus: () => ({
      activeAgents: queue.activeCount(),
      queuedTasks: queue.queuedCount(),
    }),
    sendStructuredMessage: (jid, message) =>
      deliverBotReply(jid, message.text, message),
    handleWebInput,
    createWebConversation: (jid, name, options) =>
      createWebConversation(jid, name, {
        assistantId: options?.assistantId,
        tavernPersonaId: options?.tavernPersonaId,
        accessPolicy: options?.accessPolicy,
        mode: options?.mode,
        channel: options?.channel,
        ownerUserId: options?.ownerUserId,
      }),
    createChannelConversation,
    updateConversationAccessPolicy,
    setConversationProviderOverride,
    resetConversationRuntime,
    interruptConversationReply,
    regenerateConversationReply,
    refreshTaskSnapshots,
    getTaskRuntimeState: (taskId) => queue.getTaskRuntimeState(taskId),
    runTaskNow: (taskId) =>
      enqueueTaskRun(taskId, {
        registeredGroups: () => registeredGroups,
        getSessions: () => sessions,
        queue,
        onProcess: (groupJid, proc, agentLabel, groupFolder) =>
          queue.registerProcess(groupJid, proc, agentLabel, groupFolder),
        sendMessage: (jid, rawText) => deliverBotReply(jid, rawText),
      }),
    reloadChannels,
  });
  await webServer.start();
  writeRuntimeMarkerFiles(webPort);

  // KB maintenance sweep: stuck LLM jobs + orphan parents + dirty overview pages + event log prune.
  startNonOverlappingBackgroundLoop({
    name: 'knowledge-maintenance',
    intervalMs: 5 * 60 * 1000,
    task: async () => {
      try {
        const { recoverStuckLlmJobs } =
          await import('./knowledge/llm-recovery.js');
        await recoverStuckLlmJobs();
      } catch (err) {
        logger.warn({ err }, 'LLM recovery sweep error (best-effort)');
      }
      try {
        const { rebuildOrphanParents } =
          await import('./knowledge/metadata-extractor.js');
        await rebuildOrphanParents();
      } catch (err) {
        logger.warn({ err }, 'Orphan parent rebuild error (best-effort)');
      }
      try {
        const { regenerateAllDirtyOverviews } =
          await import('./knowledge/overview-maintainer.js');
        await regenerateAllDirtyOverviews();
      } catch (err) {
        logger.warn({ err }, 'Overview refresh sweep error (best-effort)');
      }
      try {
        const { pruneAllEventLogs } = await import('./knowledge/event-log.js');
        await pruneAllEventLogs();
      } catch (err) {
        logger.warn({ err }, 'Event log prune sweep error (best-effort)');
      }
      try {
        const { autoLintOneOverdueKb } =
          await import('./knowledge/wiki-maintainer.js');
        await autoLintOneOverdueKb();
      } catch (err) {
        logger.warn({ err }, 'Auto-lint sweep error (best-effort)');
      }
    },
  });

  queue.setProcessMessagesFn(processGroupMessages);
  await recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).href === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
