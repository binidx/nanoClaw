import { EventEmitter } from 'events';
import { createModuleLogger } from '../logger.js';
import { recordWorkflowRuntimeFrame } from '../db/workflows.js';
import type { WorkflowRealtimeEnvelope, WorkflowEventType } from './types.js';

const logger = createModuleLogger('workflow');

function channelForRun(runId: string): string {
  return `workflow:run:${runId}`;
}

export class WorkflowEventBus {
  private static instance: WorkflowEventBus | undefined;
  private readonly emitter = new EventEmitter();
  private broadcastFn: ((jid: string, data: Record<string, unknown>) => void) | null =
    null;

  private constructor() {
    this.emitter.setMaxListeners(0);
  }

  static getInstance(): WorkflowEventBus {
    if (!WorkflowEventBus.instance) {
      WorkflowEventBus.instance = new WorkflowEventBus();
    }
    return WorkflowEventBus.instance;
  }

  setBroadcastFn(fn: (jid: string, data: Record<string, unknown>) => void): void {
    this.broadcastFn = fn;
  }

  emit(runId: string, event: WorkflowEventType, payload: Record<string, unknown>): void {
    const envelope: WorkflowRealtimeEnvelope = {
      type: 'workflow_event',
      runId,
      event,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.emitter.emit(channelForRun(runId), envelope);
    if (event === 'message_sent' && payload.persisted !== true) {
      const edgeId = typeof payload.edgeId === 'string' ? payload.edgeId : '';
      const sourceNodeId =
        typeof payload.sourceNodeId === 'string' ? payload.sourceNodeId : '';
      const targetNodeId =
        typeof payload.targetNodeId === 'string' ? payload.targetNodeId : '';
      const direction =
        payload.direction === 'two_way' ? 'two_way' : 'one_way';
      void recordWorkflowRuntimeFrame({
        run_id: runId,
        edge_id: edgeId,
        source_node_id: sourceNodeId,
        target_node_id: targetNodeId,
        direction,
        frame_type:
          typeof payload.messageType === 'string'
            ? payload.messageType
            : 'node_output',
        content_text:
          typeof payload.content === 'string' ? payload.content : '',
        message_type:
          typeof payload.messageType === 'string'
            ? payload.messageType
            : 'node_output',
        payload_json: JSON.stringify(payload),
      }).catch((err) => {
        logger.warn({ err, runId }, 'workflow message persistence failed');
      });
    }
    if (this.broadcastFn) {
      try {
        this.broadcastFn(`workflow:${runId}`, {
          kind: 'workflow_event',
          ...envelope,
        });
      } catch {
        // ignore broadcast failures
      }
    }
  }

  on(runId: string, handler: (envelope: WorkflowRealtimeEnvelope) => void): void {
    this.emitter.on(channelForRun(runId), handler);
  }

  off(runId: string, handler: (envelope: WorkflowRealtimeEnvelope) => void): void {
    this.emitter.off(channelForRun(runId), handler);
  }

  removeAllForRun(runId: string): void {
    this.emitter.removeAllListeners(channelForRun(runId));
  }
}
