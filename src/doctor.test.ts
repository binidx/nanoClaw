import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateDoctorReport } from './web/doctor.js';

const { getEffectiveWebConfig } = vi.hoisted(() => ({
  getEffectiveWebConfig: vi.fn(),
}));

vi.mock('./config-store.js', () => ({
  getChannelTypeDefinitions: () => [
    {
      type: 'telegram',
      label: 'Telegram',
      fields: [
        {
          key: 'botToken',
          label: 'Bot Token',
          type: 'password',
          required: true,
          effect: 'restart',
          summary: 'required',
          risk: 'sensitive',
        },
      ],
    },
  ],
  getConfiguredChannelInstances: () => [
    {
      id: 'tg-1',
      type: 'telegram',
      name: 'Telegram 1',
      enabled: true,
      config: {
        botToken: '',
      },
    },
  ],
  getEffectiveWebConfig,
  getDefaultProvider: () => undefined,
}));

vi.mock('./db.js', () => ({
  getAllProviders: () => [],
}));

describe('doctor', () => {
  beforeEach(() => {
    getEffectiveWebConfig.mockReturnValue({
      WEB_LOGIN_ENABLED: 'false',
      WEB_TERMINAL_ENABLED: 'true',
      ALLOW_INSECURE_TLS: 'true',
      allowed_directories: '[]',
    });
  });

  it('reports baseline risks from config, provider, and channel state', async () => {
    const report = await generateDoctorReport();

    expect(report.healthy).toBe(false);
    expect(report.counts.error).toBeGreaterThan(0);
    expect(
      report.checks.some((check) => check.id === 'web-login-disabled'),
    ).toBe(true);
    expect(
      report.checks.some((check) => check.id === 'web-terminal-enabled'),
    ).toBe(true);
    expect(
      report.checks.some((check) => check.id === 'providers-missing'),
    ).toBe(true);
    expect(
      report.checks.some(
        (check) =>
          check.id === 'channel-required:tg-1:botToken' &&
          check.severity === 'error',
      ),
    ).toBe(true);
  });

  it('flags admin123 as a weak default password', async () => {
    getEffectiveWebConfig.mockReturnValue({
      WEB_LOGIN_ENABLED: 'true',
      WEB_LOGIN_USERNAME: 'admin',
      WEB_LOGIN_PASSWORD: 'admin123',
      WEB_TERMINAL_ENABLED: 'false',
      ALLOW_INSECURE_TLS: 'false',
      allowed_directories: '[]',
    });

    const report = await generateDoctorReport();

    expect(
      report.checks.some((check) => check.id === 'web-login-weak-credentials'),
    ).toBe(true);
  });
});
