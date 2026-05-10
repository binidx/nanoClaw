import path from 'path';
import { pathToFileURL } from 'url';

import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadTesting() {
  const moduleUrl = pathToFileURL(
    path.resolve(process.cwd(), 'agent', 'runner', 'src', 'codex-mcp-tools.ts'),
  ).href;
  const module = (await import(moduleUrl)) as {
    __testing: {
      getConfiguredMcpServers: () => Record<
        string,
        {
          command: string;
          args?: string[];
          env?: Record<string, string>;
        }
      >;
      formatMcpCallResult: (value: unknown) => string;
    };
  };
  return module.__testing;
}

describe('codex-mcp-tools', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('always injects the built-in nanoclaw MCP server', () => {
    vi.stubEnv('NANOCLAW_CHAT_JID', 'chat-1');
    vi.stubEnv('NANOCLAW_GROUP_FOLDER', 'group-1');
    vi.stubEnv('NANOCLAW_IS_MAIN', '1');
    vi.stubEnv('NANOCLAW_INTERNAL_API_BASE', 'http://127.0.0.1:3377');
    vi.stubEnv('NANOCLAW_INTERNAL_API_TOKEN', 'browser-token');
    vi.stubEnv('MEMORY_ENABLED', 'false');
    vi.stubEnv('MEMORY_WRITE_MODE', 'disabled');
    vi.stubEnv('NANOCLAW_EXTRA_MCP_SERVERS', '{}');

    return loadTesting().then((testing) => {
      const servers = testing.getConfiguredMcpServers();

      expect(servers.nanoclaw).toEqual({
        command: process.execPath,
        args: [expect.stringContaining('ipc-mcp-stdio.js')],
        env: expect.objectContaining({
          NANOCLAW_CHAT_JID: 'chat-1',
          NANOCLAW_GROUP_FOLDER: 'group-1',
          NANOCLAW_IS_MAIN: '1',
          NANOCLAW_INTERNAL_API_BASE: 'http://127.0.0.1:3377',
          NANOCLAW_INTERNAL_API_TOKEN: 'browser-token',
          MEMORY_ENABLED: 'false',
          MEMORY_WRITE_MODE: 'disabled',
        }),
      });
    });
  });

  it('rejects external overrides of the reserved nanoclaw server id', () => {
    vi.stubEnv(
      'NANOCLAW_EXTRA_MCP_SERVERS',
      JSON.stringify({
        nanoclaw: {
          command: 'bad-node',
          args: ['bad.js'],
          env: { BAD: '1' },
        },
        docs: {
          command: 'node',
          args: ['docs.js'],
        },
      }),
    );

    return loadTesting().then((testing) => {
      const servers = testing.getConfiguredMcpServers();

      expect(servers.nanoclaw.command).toBe(process.execPath);
      expect(servers.nanoclaw.args).toEqual([
        expect.stringContaining('ipc-mcp-stdio.js'),
      ]);
      expect(servers.docs).toEqual({
        command: 'node',
        args: ['docs.js'],
        env: undefined,
      });
    });
  });

  it('formats structured MCP payloads through the model serializer', () => {
    vi.stubEnv('NANOCLAW_MODEL_SERIALIZATION_MODE', 'toon');

    return loadTesting().then((testing) => {
      const text = testing.formatMcpCallResult({
        structuredContent: [
          { name: 'spec', size: 12, status: 'ok' },
          { name: 'plan', size: 8, status: 'warn' },
        ],
      });

      expect(text).toContain('[2]{name,size,status}:');
      expect(text).toContain('spec,12,ok');
    });
  });
});
