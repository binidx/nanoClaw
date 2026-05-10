import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  generateMcpServerIdMock,
  listVisibleMcpServersMock,
  listUserMcpServersMock,
  listUserSkillsMock,
  upsertUserMcpServerMock,
  ensureUserHydratedMock,
  generateTextWithDefaultProviderMock,
} = vi.hoisted(() => ({
  generateMcpServerIdMock: vi.fn(() => 'mcp-generated'),
  listVisibleMcpServersMock: vi.fn(),
  listUserMcpServersMock: vi.fn(),
  listUserSkillsMock: vi.fn(),
  upsertUserMcpServerMock: vi.fn(),
  ensureUserHydratedMock: vi.fn(async () => undefined),
  generateTextWithDefaultProviderMock: vi.fn(),
}));

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-user-mcp-'));

vi.mock('../config.js', () => ({
  DATA_DIR: tempDataDir,
}));

vi.mock('../db.js', () => ({
  generateMcpServerId: generateMcpServerIdMock,
  upsertUserMcpServer: upsertUserMcpServerMock,
  getUserMcpServer: vi.fn(),
  listUserMcpServers: listUserMcpServersMock,
  listUserSkills: listUserSkillsMock,
  listVisibleMcpServers: listVisibleMcpServersMock,
  listVisibleSkills: vi.fn(async () => []),
  deleteUserMcpServer: vi.fn(),
  deleteMarketplaceInstallsByTarget: vi.fn(),
  getDefaultProvider: vi.fn(async () => ({ id: 'p1', type: 'openai', name: 'Test', config: '{}' })),
  getDefaultProviderForUser: vi.fn(async () => ({ id: 'p1', type: 'openai', name: 'Test', config: '{}' })),
  getProvider: vi.fn(async () => ({ id: 'p1', type: 'openai', name: 'Test', config: '{}' })),
}));

vi.mock('../startup-hydration.js', () => ({
  ensureUserHydrated: ensureUserHydratedMock,
}));

vi.mock('../logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  createModuleLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../provider/provider-api.js', () => ({
  generateTextWithDefaultProvider: generateTextWithDefaultProviderMock,
}));

vi.mock('../node-executable.js', () => ({
  getNodeExecutable: () => 'node',
}));

vi.mock('../file-store-service.js', () => ({
  saveDirectoryToFileStore: vi.fn(async () => 1),
}));

describe('user MCP service', () => {
  beforeEach(() => {
    fs.rmSync(tempDataDir, { recursive: true, force: true });
    fs.mkdirSync(tempDataDir, { recursive: true });
    vi.clearAllMocks();
    generateMcpServerIdMock.mockReturnValue('mcp-generated');
    listUserMcpServersMock.mockResolvedValue([]);
    listUserSkillsMock.mockResolvedValue([]);
    listVisibleMcpServersMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('redacts env values for shared MCPs owned by another user but keeps metadata', async () => {
    listVisibleMcpServersMock.mockResolvedValue([
      {
        id: 'shared-mcp',
        user_id: 'user-b',
        name: 'Shared MCP',
        description: null,
        command: 'node',
        args_json: '[]',
        env_json: JSON.stringify({ API_KEY: 'secret' }),
        metadata_json: JSON.stringify({
          capabilities: ['image.generate'],
        }),
        enabled: 1,
        visibility: 'shared',
        source_type: 'manual',
        source_ref: null,
        icon_url: null,
        tags_json: '[]',
        created_at: '2026-04-26T00:00:00.000Z',
        updated_at: '2026-04-26T00:00:00.000Z',
      },
    ]);

    const { listAllVisibleMcpServers } = await import('./user-mcp-service.js');
    const result = await listAllVisibleMcpServers('user-a');

    expect(result).toEqual([
      expect.objectContaining({
        id: 'shared-mcp',
        env: {},
        metadata: expect.objectContaining({
          capabilities: ['image.generate'],
        }),
        healthStatus: expect.objectContaining({
          state: 'ready',
        }),
      }),
    ]);
  });

  it('generates a user MCP package with AI and persists metadata plus files', async () => {
    generateTextWithDefaultProviderMock.mockResolvedValue(
      JSON.stringify({
        name: 'SD WebUI',
        description: 'Local Stable Diffusion MCP',
        entryFile: 'index.mjs',
        env: {
          SD_BASE_URL: '',
        },
        metadata: {
          capabilities: ['image.generate'],
          requirements: {
            env: [{ key: 'SD_BASE_URL' }],
          },
        },
        files: [
          {
            path: 'index.mjs',
            content: 'console.log("run")\n',
          },
          {
            path: 'src/index.ts',
            content: 'export const ok = true;\n',
          },
        ],
      }),
    );

    const { createUserMcpServerWithAi } = await import('./user-mcp-service.js');
    const result = await createUserMcpServerWithAi('user-a', {
      request: 'Create a Stable Diffusion MCP',
      docsText: 'POST /sdapi/v1/txt2img',
      visibility: 'private',
    });

    expect(upsertUserMcpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'mcp-generated',
        command: 'node',
        metadata_json: expect.stringContaining('image.generate'),
      }),
    );
    expect(result.server).toEqual(
      expect.objectContaining({
        id: 'mcp-generated',
        metadata: expect.objectContaining({
          capabilities: ['image.generate'],
          generator: expect.objectContaining({
            kind: 'ai-generated',
          }),
        }),
      }),
    );
    expect(fs.existsSync(path.join(result.created.path, 'package', 'index.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(result.created.path, 'package', 'src', 'index.ts'))).toBe(true);
    expect(result.created.path).toBe(
      path.join(tempDataDir, 'users', 'user-a', 'mcp-servers', 'mcp-generated'),
    );
  });

  it('imports a local MCP package with one stable id for disk and db records', async () => {
    generateMcpServerIdMock.mockReturnValueOnce('mcp-imported');
    const sourceDir = path.join(tempDataDir, 'source-mcp');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'index.mjs'),
      'console.log("imported")\n',
      'utf-8',
    );

    const { importUserMcpServerFromPath } = await import('./user-mcp-service.js');
    const result = await importUserMcpServerFromPath('user-a', {
      sourcePath: sourceDir,
      visibility: 'private',
    });

    const expectedRoot = path.join(
      tempDataDir,
      'users',
      'user-a',
      'mcp-servers',
      'mcp-imported',
    );
    expect(generateMcpServerIdMock).toHaveBeenCalledTimes(1);
    expect(upsertUserMcpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'mcp-imported',
        args_json: JSON.stringify([
          path.join(expectedRoot, 'package', 'index.mjs'),
        ]),
        source_type: 'import',
      }),
    );
    expect(result.server.id).toBe('mcp-imported');
    expect(result.imported.path).toBe(expectedRoot);
    expect(fs.existsSync(path.join(expectedRoot, 'package', 'index.mjs'))).toBe(true);
  });

  it('imports HTTP MCP JSON without requiring a command', async () => {
    const { importUserMcpServersFromJson } = await import('./user-mcp-service.js');
    const result = await importUserMcpServersFromJson('user-a', {
      json: JSON.stringify({
        mcpServers: {
          docs: {
            name: 'Docs MCP',
            transport: 'streamable-http',
            url: 'https://example.com/mcp',
          },
        },
      }),
    });

    expect(upsertUserMcpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Docs MCP',
        command: '',
        metadata_json: expect.stringContaining('streamable-http'),
      }),
    );
    expect(result.servers[0]).toEqual(
      expect.objectContaining({
        name: 'Docs MCP',
        transport: 'streamable-http',
        command: '',
        url: 'https://example.com/mcp',
      }),
    );
  });
});
