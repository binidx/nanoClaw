import { describe, expect, it } from 'vitest';

import {
  _resetRealtimeEventState,
  createRealtimeEnvelope,
  createRealtimeEventMetadata,
  getConversationLastEventSeq,
} from './runtime/realtime-events.js';

describe('realtime event metadata', () => {
  it('increments sequence numbers per conversation and preserves metadata', () => {
    _resetRealtimeEventState();

    const first = createRealtimeEventMetadata({
      jid: 'web:test',
      eventType: 'message',
      timestamp: '2026-03-12T00:00:00.000Z',
      runId: 'run-1',
      clientId: 'client-1',
    });
    const second = createRealtimeEventMetadata({
      jid: 'web:test',
      eventType: 'turn_event',
      timestamp: '2026-03-12T00:00:01.000Z',
      runId: 'run-1',
    });
    const otherConversation = createRealtimeEventMetadata({
      jid: 'web:other',
      eventType: 'message',
    });

    expect(first.seq).toBeGreaterThan(0);
    expect(first.state_version).toBe(first.seq);
    expect(first.run_id).toBe('run-1');
    expect(first.client_id).toBe('client-1');
    expect(second.seq).toBe(first.seq + 1);
    expect(second.state_version).toBe(second.seq);
    expect(second.event_type).toBe('turn_event');
    expect(getConversationLastEventSeq('web:test')).toBe(second.seq);
    expect(otherConversation.seq).toBe(first.seq);
    expect(getConversationLastEventSeq('web:other')).toBe(otherConversation.seq);
  });

  it('builds a versioned envelope for websocket consumers', () => {
    _resetRealtimeEventState();

    const envelope = createRealtimeEnvelope({
      jid: 'web:test',
      eventType: 'message',
      payload: {
        type: 'message',
        jid: 'web:test',
        content: 'hello',
      },
      timestamp: '2026-03-12T00:00:00.000Z',
    });

    expect(envelope.kind).toBe('realtime');
    expect(envelope.version).toBe(1);
    expect(envelope.seq).toBeGreaterThan(0);
    expect(envelope.state_version).toBe(envelope.seq);
    expect(envelope.payload.content).toBe('hello');
  });
});
