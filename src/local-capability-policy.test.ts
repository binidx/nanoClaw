import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configValues: new Map<string, string>(),
  multiUserMode: false,
  user: null as null | { id: string; status: string },
  permissionAllowed: false,
}));

vi.mock('./config-store.js', () => ({
  getConfigValue: vi.fn(async (key: string) => mocks.configValues.get(key) || ''),
}));

vi.mock('./user/user-service.js', () => ({
  isMultiUserMode: vi.fn(async () => mocks.multiUserMode),
  getUserByUsername: vi.fn(async () => mocks.user),
}));

vi.mock('./auth/permission-engine.js', () => ({
  evaluate: vi.fn(async () => ({
    allowed: mocks.permissionAllowed,
    reason: mocks.permissionAllowed ? 'permission_granted' : 'no_permission',
  })),
}));

import { resolveLocalCapability } from './auth/local-capability-policy.js';

describe('local capability policy', () => {
  beforeEach(() => {
    mocks.configValues.clear();
    mocks.multiUserMode = false;
    mocks.user = null;
    mocks.permissionAllowed = false;
  });

  it('allows enabled capabilities in single-user mode without RBAC', async () => {
    mocks.configValues.set('WEB_TERMINAL_ENABLED', 'true');

    await expect(resolveLocalCapability('terminal')).resolves.toMatchObject({
      id: 'terminal',
      enabled: true,
      available: true,
      multiUserMode: false,
      reason: 'single_user',
    });
  });

  it('blocks disabled capabilities before checking user permissions', async () => {
    mocks.multiUserMode = true;
    mocks.configValues.set('WEB_BROWSER_ENABLED', 'false');
    mocks.user = { id: 'u-admin', status: 'active' };
    mocks.permissionAllowed = true;

    await expect(
      resolveLocalCapability('browserControl', { username: 'admin' }),
    ).resolves.toMatchObject({
      id: 'browserControl',
      enabled: false,
      available: false,
      multiUserMode: true,
      reason: 'disabled',
    });
  });

  it('requires an active multi-user account with the capability permission', async () => {
    mocks.multiUserMode = true;
    mocks.configValues.set('WEB_BROWSER_ENABLED', 'true');
    mocks.user = { id: 'u-dev', status: 'active' };
    mocks.permissionAllowed = false;

    await expect(
      resolveLocalCapability('browserControl', { username: 'dev' }),
    ).resolves.toMatchObject({
      enabled: true,
      available: false,
      reason: 'permission_denied',
      permission: 'browser.control',
    });

    mocks.permissionAllowed = true;

    await expect(
      resolveLocalCapability('browserControl', { username: 'admin' }),
    ).resolves.toMatchObject({
      enabled: true,
      available: true,
      reason: 'permission_granted',
      permission: 'browser.control',
    });
  });

  it('treats permission-only local install capability as enabled and RBAC-gated in multi-user mode', async () => {
    mocks.multiUserMode = true;
    mocks.user = { id: 'u-dev', status: 'active' };
    mocks.permissionAllowed = false;

    await expect(
      resolveLocalCapability('localInstall', { username: 'dev' }),
    ).resolves.toMatchObject({
      id: 'localInstall',
      enabled: true,
      available: false,
      reason: 'permission_denied',
      permission: 'local.install',
    });
  });
});
