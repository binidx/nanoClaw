import { describe, expect, it } from 'vitest';

import { normalizeArrayPayload, normalizeStatusInfo } from './useAppBootstrap';

describe('useAppBootstrap normalizers', () => {
  it('keeps valid arrays unchanged', () => {
    expect(normalizeArrayPayload(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('falls back to an empty array when the payload is an object', () => {
    expect(normalizeArrayPayload({})).toEqual([]);
    expect(normalizeArrayPayload({ instances: [] })).toEqual([]);
  });

  it('falls back to an empty array for nullish payloads', () => {
    expect(normalizeArrayPayload(null)).toEqual([]);
    expect(normalizeArrayPayload(undefined)).toEqual([]);
  });

  it('normalizes malformed status payloads into safe frontend values', () => {
    expect(
      normalizeStatusInfo({
        assistant: {},
        provider: ['codex'],
        providerAlias: { model: 'gpt-5.4' },
        channels: {},
        agents: { activeAgents: '2', queuedTasks: null },
        uptime: '12',
        webTerminalEnabled: 'yes',
        memory: {},
      }),
    ).toEqual({
      assistant: '',
      provider: '',
      providerAlias: '',
      channels: [],
      agents: {
        activeAgents: 0,
        queuedTasks: 0,
      },
      uptime: 0,
      stockAnalysisEnabled: undefined,
      webTerminalEnabled: undefined,
      capabilities: undefined,
      allowInsecureTls: undefined,
      subagentsEnabled: undefined,
      subagents: undefined,
      memory: {},
    });
  });

  it('normalizes local capability status payloads', () => {
    expect(
      normalizeStatusInfo({
        capabilities: {
          terminal: {
            id: 'terminal',
            configKey: 'WEB_TERMINAL_ENABLED',
            permission: 'terminal.access',
            enabled: true,
            available: false,
            multiUserMode: true,
            reason: 'permission_denied',
          },
          browserControl: {
            id: 'browserControl',
            configKey: 'WEB_BROWSER_ENABLED',
            permission: 'browser.control',
            enabled: true,
            available: true,
            multiUserMode: true,
            reason: 'permission_granted',
          },
          localInstall: {
            id: 'localInstall',
            configKey: '',
            permission: 'local.install',
            enabled: true,
            available: false,
            multiUserMode: true,
            reason: 'permission_denied',
          },
        },
      }).capabilities,
    ).toEqual({
      terminal: {
        id: 'terminal',
        configKey: 'WEB_TERMINAL_ENABLED',
        permission: 'terminal.access',
        enabled: true,
        available: false,
        multiUserMode: true,
        reason: 'permission_denied',
      },
      browserControl: {
        id: 'browserControl',
        configKey: 'WEB_BROWSER_ENABLED',
        permission: 'browser.control',
        enabled: true,
        available: true,
        multiUserMode: true,
        reason: 'permission_granted',
      },
      localInstall: {
        id: 'localInstall',
        configKey: '',
        permission: 'local.install',
        enabled: true,
        available: false,
        multiUserMode: true,
        reason: 'permission_denied',
      },
    });
  });

  it('keeps valid status payload fields intact', () => {
    expect(
      normalizeStatusInfo({
        assistant: 'NanoClaw',
        provider: 'codex',
        providerAlias: 'gpt-5.4',
        channels: [{ name: 'slack', connected: true }, { name: 1, connected: true }],
        agents: { activeAgents: 2, queuedTasks: 3 },
        uptime: 42,
        subagentsEnabled: true,
        subagents: {
          enabled: true,
          maxDepth: 4,
          maxActive: 2,
          activeCount: 1,
          providers: {
            codex: {
              canSpawn: true,
              canPersistentSession: true,
              canListRuntime: true,
              canStopRuntime: true,
              canResumeAfterRestart: true,
            },
          },
        },
      }),
    ).toMatchObject({
      assistant: 'NanoClaw',
      provider: 'codex',
      providerAlias: 'gpt-5.4',
      channels: [{ name: 'slack', connected: true }],
      agents: {
        activeAgents: 2,
        queuedTasks: 3,
      },
      uptime: 42,
      subagentsEnabled: true,
      subagents: {
        enabled: true,
        maxDepth: 4,
        maxActive: 2,
        activeCount: 1,
      },
    });
  });
});
