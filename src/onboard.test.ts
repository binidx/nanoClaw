import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetConfiguredChannelInstances = vi.fn(() => []);
const mockGetDefaultProvider = vi.fn(() => undefined);
const mockInitDatabase = vi.fn();

vi.mock('./config-store.js', () => ({
  getConfiguredChannelInstances: () => mockGetConfiguredChannelInstances(),
}));

vi.mock('./db.js', () => ({
  getDefaultProvider: () => mockGetDefaultProvider(),
  initDatabase: () => mockInitDatabase(),
}));

describe('onboard', () => {
  const originalCwd = process.cwd();
  let tempDir = '';
  let tempHome = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-onboard-'));
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-home-'));
    process.chdir(tempDir);
    vi.resetModules();
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);
    fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'tmp'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
    mockInitDatabase.mockReset();
    mockGetConfiguredChannelInstances.mockReset();
    mockGetConfiguredChannelInstances.mockReturnValue([]);
    mockGetDefaultProvider.mockReset();
    mockGetDefaultProvider.mockReturnValue(undefined);
  });

  it('creates safe local templates and returns an onboarding report', async () => {
    const { runOnboarding } = await import('./web/onboard.js');
    const result = await runOnboarding();

    expect(result.applied).toContain('initialized:store/messages.db');
    expect(
      result.applied.some((entry) => entry.includes('mount-allowlist')),
    ).toBe(true);
    expect(result.report.steps.some((step) => step.id === 'database')).toBe(
      true,
    );
    expect(mockInitDatabase).toHaveBeenCalled();
  });
});
