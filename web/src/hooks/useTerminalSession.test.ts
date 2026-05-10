import { describe, expect, it } from 'vitest';

import {
  buildTerminalWebSocketUrl,
  isRenderableTerminalHost,
  shouldRetryTerminalMount,
  TERMINAL_MOUNT_RETRY_LIMIT,
} from './useTerminalSession';

describe('useTerminalSession terminal host readiness', () => {
  it('treats a missing host as not renderable', () => {
    expect(isRenderableTerminalHost(null)).toBe(false);
  });

  it('requires both width and height before mounting the terminal', () => {
    expect(
      isRenderableTerminalHost({
        clientWidth: 0,
        clientHeight: 480,
      }),
    ).toBe(false);
    expect(
      isRenderableTerminalHost({
        clientWidth: 640,
        clientHeight: 0,
      }),
    ).toBe(false);
    expect(
      isRenderableTerminalHost({
        clientWidth: 640,
        clientHeight: 480,
      }),
    ).toBe(true);
  });

  it('retries only while the host is still not renderable and below the limit', () => {
    expect(
      shouldRetryTerminalMount(
        {
          clientWidth: 0,
          clientHeight: 0,
        },
        0,
      ),
    ).toBe(true);
    expect(
      shouldRetryTerminalMount(
        {
          clientWidth: 0,
          clientHeight: 0,
        },
        TERMINAL_MOUNT_RETRY_LIMIT,
      ),
    ).toBe(false);
    expect(
      shouldRetryTerminalMount(
        {
          clientWidth: 640,
          clientHeight: 480,
        },
        0,
      ),
    ).toBe(false);
  });

  it('builds a jid-bound websocket url for the terminal session', () => {
    expect(
      buildTerminalWebSocketUrl('jid:demo/session', {
        protocol: 'https:',
        host: 'nanoclaw.test',
      }),
    ).toBe('wss://nanoclaw.test/ws/terminal?jid=jid%3Ademo%2Fsession');
  });
});
