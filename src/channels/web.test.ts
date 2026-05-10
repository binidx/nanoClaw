import { EventEmitter } from 'events';

import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('../config-store.js', () => ({
  getAssistantName: vi.fn(async () => 'AssistantX'),
}));

import { WebChannel } from './web.js';

class FakeWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  send = vi.fn();
}

describe('WebChannel', () => {
  it('attaches only one close listener per websocket across repeated subscriptions', () => {
    const channel = new WebChannel({
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });
    const ws = new FakeWebSocket() as unknown as WebSocket;

    for (let index = 0; index < 12; index += 1) {
      channel.addClient(`web:test-${index}`, ws);
    }
    channel.addClient('web:test-3', ws);

    expect((ws as unknown as FakeWebSocket).listenerCount('close')).toBe(1);

    const clients = (
      channel as unknown as { clients: Map<string, Set<WebSocket>> }
    ).clients;
    expect(clients.size).toBe(12);

    (ws as unknown as FakeWebSocket).emit('close');
    expect(clients.size).toBe(0);
  });

  it('awaits assistant name before composing inbound web messages', async () => {
    const onMessage = vi.fn();
    const registerGroup = vi.fn();
    const groups: Record<string, { folder: string }> = {};
    registerGroup.mockImplementation(
      (jid: string, group: { folder: string }) => {
        groups[jid] = group;
      },
    );
    const channel = new WebChannel({
      onMessage,
      onChatMetadata: () => undefined,
      registeredGroups: () => groups,
      registerGroup,
    });

    await channel.handleInboundMessage('web:test', 'hi');

    expect(registerGroup).toHaveBeenCalledWith(
      'web:test',
      expect.objectContaining({
        trigger: '@AssistantX',
      }),
    );
    expect(onMessage).toHaveBeenCalledWith(
      'web:test',
      expect.objectContaining({
        content: '@AssistantX hi',
      }),
    );
  });

  it('preserves uploaded files on inbound web messages', async () => {
    const onMessage = vi.fn();
    const groups: Record<string, { folder: string }> = {
      'web:test': { folder: 'web_test' },
    };
    const channel = new WebChannel({
      onMessage,
      onChatMetadata: () => undefined,
      registeredGroups: () => groups,
    });

    await channel.handleInboundMessage('web:test', 'read this', 'Web User', {
      uploadedFiles: [
        {
          name: 'spec.txt',
          mimeType: 'text/plain',
          size: 12,
          relativePath: 'chat_abc/spec.txt',
        },
      ],
    });

    expect(onMessage).toHaveBeenCalledWith(
      'web:test',
      expect.objectContaining({
        uploaded_files: [
          expect.objectContaining({
            name: 'spec.txt',
            relativePath: 'chat_abc/spec.txt',
          }),
        ],
      }),
    );
  });
});
