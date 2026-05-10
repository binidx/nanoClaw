import { describe, expect, it, vi } from 'vitest';

const { getConfigMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
}));

vi.mock('../db.js', () => ({
  getConfig: getConfigMock,
  setConfig: vi.fn(),
  deleteConfig: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../file-store-service.js', () => ({
  saveDirectoryToFileStore: vi.fn(),
}));

vi.mock('../provider/provider-api.js', () => ({
  generateTextWithDefaultProvider: vi.fn(),
}));

describe('runtime customization service managed MCP servers', () => {
  it('returns an empty list when stored managed MCP config is invalid', async () => {
    getConfigMock.mockResolvedValueOnce('{bad json');

    const { getManagedMcpServersForResponse } = await import(
      './runtime-customization-service.js'
    );

    const servers = await getManagedMcpServersForResponse();

    expect(servers).toEqual([]);
  });
});
