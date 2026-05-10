import express from 'express';
import { describe, expect, it, vi } from 'vitest';

const { getAllSystemProvidersMock } = vi.hoisted(() => ({
  getAllSystemProvidersMock: vi.fn(async () => []),
}));

vi.mock('./db.js', async () => {
  return {
    createProvider: vi.fn(),
    deleteConfig: vi.fn(),
    deleteProvider: vi.fn(),
    getAllSystemProviders: getAllSystemProvidersMock,
    getProvider: vi.fn(),
    setConfig: vi.fn(),
    updateProvider: vi.fn(),
  };
});

import {
  normalizeBashApprovalAllowlistConfigEntry,
  registerAdminSettingsRoutes,
} from './routes/admin-settings-routes.js';

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind test server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

describe('admin settings bash approval allowlist config', () => {
  it('normalizes valid allowlist entries into stored JSON', () => {
    const normalized = normalizeBashApprovalAllowlistConfigEntry([
      {
        id: 'rule-1',
        prefix: ['npm', 'run', 'build'],
        label: 'npm run build',
        enabled: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        createdFrom: 'manual',
      },
    ]);

    expect(JSON.parse(normalized)).toEqual([
      expect.objectContaining({
        prefix: ['npm', 'run', 'build'],
        label: 'npm run build',
        enabled: true,
        createdFrom: 'manual',
      }),
    ]);
  });

  it('rejects invalid allowlist config payloads', () => {
    expect(() =>
      normalizeBashApprovalAllowlistConfigEntry('{"prefix":["git","status"]}'),
    ).toThrow(/JSON 数组/);
  });

  it('awaits async provider loading before serializing /api/ai-providers', async () => {
    getAllSystemProvidersMock.mockResolvedValueOnce([
      {
        id: 'provider-1',
        alias: 'Primary Codex',
        type: 'codex',
        api_key: 'secret-key-1234',
        base_url: 'https://example.com',
        model: 'gpt-5.4',
        extra_config: null,
        is_default: 1,
      },
    ]);

    const app = express();
    registerAdminSettingsRoutes(app, {
      auditMutation: vi.fn(),
      allowedConfigKeys: new Set(),
      sensitiveConfigKeys: new Set(),
      applyProcessConfigSideEffects: vi.fn(),
      summarizeConfigEffects: vi.fn(() => ({})),
      isAuthenticatedRequest: vi.fn(() => true),
      clearBootstrapCredentials: vi.fn(),
      authSessions: {
        revokeAll: vi.fn(),
        create: vi.fn(() => ({ token: 'token' })),
      },
      getLoginCredentials: vi.fn(() => ({ username: 'admin' })),
      serializeAuthCookie: vi.fn(() => 'auth=token'),
      normalizeCodexApiBase: vi.fn((value: string) => value),
      readFirstCodexChatCompletionText: vi.fn(async () => ({ text: '' })),
      requirePermission: vi.fn(() => (_req: any, _res: any, next: any) => next()),
      reloadChannels: vi.fn(async () => ({ disconnected: [], connected: [], errors: [] })),
    } as any);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/ai-providers`);
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual([
        expect.objectContaining({
          id: 'provider-1',
          alias: 'Primary Codex',
          type: 'codex',
          api_key: '****1234',
        }),
      ]);
    });
  });
});
