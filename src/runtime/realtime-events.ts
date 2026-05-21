import crypto from 'crypto';

export type RealtimeEventType =
  | 'message'
  | 'agent_event'
  | 'turn_event'
  | 'approval_request'
  | 'approval_resolved'
  | 'ask_request'
  | 'ask_resolved'
  | 'interrupted'
  | 'reset'
  | 'typing'
  | 'stream'
  | 'live2d_emotion'
  | 'workflow_event'
  | 'im_event';

export interface RealtimeEventMetadata {
  seq: number;
  state_version: number;
  event_id: string;
  event_type: RealtimeEventType;
  timestamp: string;
  jid: string;
  run_id?: string;
  client_id?: string;
}

export interface RealtimeEnvelope<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> extends RealtimeEventMetadata {
  kind: 'realtime';
  version: 1;
  payload: TPayload;
}

const conversationSeq = new Map<string, number>();
const SEQ_EPOCH = Math.floor(Date.now() / 1000);

export function createRealtimeEventMetadata(input: {
  jid: string;
  eventType: RealtimeEventType;
  timestamp?: string;
  runId?: string;
  clientId?: string;
  seq?: number;
}): RealtimeEventMetadata {
  const prev = conversationSeq.get(input.jid) ?? SEQ_EPOCH;
  const seq =
    typeof input.seq === 'number' && Number.isFinite(input.seq)
      ? input.seq
      : prev + 1;
  conversationSeq.set(input.jid, seq);

  return {
    seq,
    state_version: seq,
    event_id: crypto.randomUUID(),
    event_type: input.eventType,
    timestamp: input.timestamp || new Date().toISOString(),
    jid: input.jid,
    ...(input.runId ? { run_id: input.runId } : {}),
    ...(input.clientId ? { client_id: input.clientId } : {}),
  };
}

export function createRealtimeEnvelope<
  TPayload extends Record<string, unknown>,
>(input: {
  jid: string;
  eventType: RealtimeEventType;
  payload: TPayload;
  timestamp?: string;
  runId?: string;
  clientId?: string;
  seq?: number;
}): RealtimeEnvelope<TPayload> {
  return {
    kind: 'realtime',
    version: 1,
    ...createRealtimeEventMetadata({
      jid: input.jid,
      eventType: input.eventType,
      timestamp: input.timestamp,
      runId: input.runId,
      clientId: input.clientId,
      seq: input.seq,
    }),
    payload: input.payload,
  };
}

export function getConversationLastEventSeq(jid: string): number {
  return conversationSeq.get(jid) ?? 0;
}

export function _resetRealtimeEventState(): void {
  conversationSeq.clear();
}
