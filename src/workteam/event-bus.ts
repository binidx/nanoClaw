import { EventEmitter } from 'events';
import type { WorkteamEventType, WorkteamRealtimeEnvelope } from './types.js';
import { insertWorkteamEvent } from '../db/workteam.js';
import { createModuleLogger } from '../logger.js';

const logger = createModuleLogger('workteam');

function channelForRun(runId: string): string {
  return `workteam:run:${runId}`;
}

export class WorkteamEventBus {
  private static instance: WorkteamEventBus | undefined;

  private readonly emitter = new EventEmitter();
  private readonly anyHandlers = new Set<(envelope: WorkteamRealtimeEnvelope) => void>();
  private broadcastFn: ((jid: string, data: Record<string, unknown>) => void) | null = null;

  private constructor() {
    this.emitter.setMaxListeners(0);
  }

  static getInstance(): WorkteamEventBus {
    if (!WorkteamEventBus.instance) {
      WorkteamEventBus.instance = new WorkteamEventBus();
    }
    return WorkteamEventBus.instance;
  }

  setBroadcastFn(fn: (jid: string, data: Record<string, unknown>) => void): void {
    this.broadcastFn = fn;
  }

  emit(runId: string, event: WorkteamEventType, payload: Record<string, unknown>): void {
    const envelope: WorkteamRealtimeEnvelope = {
      type: 'workteam_event',
      runId,
      event,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.emitter.emit(channelForRun(runId), envelope);
    for (const handler of this.anyHandlers) {
      handler(envelope);
    }

    const sourceAgentId = typeof payload.agentId === 'string' ? payload.agentId : '';
    const targetAgentId = typeof payload.targetAgentId === 'string' ? payload.targetAgentId : '';
    insertWorkteamEvent(runId, event, payload, sourceAgentId, targetAgentId).catch((err) => {
      logger.warn({ err, runId, event }, 'workteam event persistence failed');
    });

    if (this.broadcastFn) {
      try {
        this.broadcastFn(`workteam:${runId}`, {
          kind: 'workteam_event',
          ...envelope,
        });
      } catch {
        // ignore broadcast failures
      }
    }
  }

  on(runId: string, handler: (envelope: WorkteamRealtimeEnvelope) => void): void {
    this.emitter.on(channelForRun(runId), handler);
  }

  off(runId: string, handler: (envelope: WorkteamRealtimeEnvelope) => void): void {
    this.emitter.off(channelForRun(runId), handler);
  }

  onAny(handler: (envelope: WorkteamRealtimeEnvelope) => void): void {
    this.anyHandlers.add(handler);
  }

  removeAllForRun(runId: string): void {
    this.emitter.removeAllListeners(channelForRun(runId));
  }
}

export function getInstance(): WorkteamEventBus {
  return WorkteamEventBus.getInstance();
}
