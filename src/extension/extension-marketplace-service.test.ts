import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

const testDataDir = path.join(
  os.tmpdir(),
  'nanoclaw-extension-marketplace-test',
);
const configStore = new Map<string, string>();
const marketplaceStore = new Map<string, Record<string, unknown>>();
const setConfigFailureKeys = new Set<string>();
const MAX_REMOTE_FETCH_BYTES = 64 * 1024 * 1024;

vi.mock('../config.js', () => ({
  DATA_DIR: testDataDir,
}));

vi.mock('../db.js', () => ({
  getConfig: (key: string) => configStore.get(key),
  setConfig: (key: string, value: string) => {
    if (setConfigFailureKeys.has(key)) {
      throw new Error(`setConfig failed for ${key}`);
    }
    configStore.set(key, value);
  },
  deleteConfig: (key: string) => {
    configStore.delete(key);
  },
  generateMarketplaceSourceId: () => `mkt_${marketplaceStore.size + 1}`,
  upsertMarketplaceSource: (record: Record<string, unknown>) => {
    marketplaceStore.set(String(record.id), { ...record });
  },
  getMarketplaceSource: (id: string) => {
    const record = marketplaceStore.get(id);
    return record && !record.deleted_at ? record : null;
  },
  listMarketplaceSources: (enabledOnly = false) =>
    Array.from(marketplaceStore.values())
      .filter((record) => !record.deleted_at)
      .filter((record) => !enabledOnly || record.enabled === 1)
      .sort((a, b) => {
        const sortDelta = Number(a.sort_order || 0) - Number(b.sort_order || 0);
        if (sortDelta !== 0) return sortDelta;
        return String(b.updated_at || '').localeCompare(
          String(a.updated_at || ''),
        );
      }),
  deleteMarketplaceSource: (id: string) => {
    const record = marketplaceStore.get(id);
    if (record) {
      marketplaceStore.set(id, {
        ...record,
        deleted_at: new Date().toISOString(),
      });
    }
  },
}));

function createHeaders(values?: Record<string, string>) {
  const normalized = Object.fromEntries(
    Object.entries(values || {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  return {
    get(name: string) {
      return normalized[name.toLowerCase()] ?? null;
    },
  };
}

describe('extension marketplace service', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    configStore.clear();
    marketplaceStore.clear();
    setConfigFailureKeys.clear();
    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.mkdirSync(testDataDir, { recursive: true });
  });

  it('returns v2 admin sources with legacy config sources marked read-only', async () => {
    configStore.set(
      'WEB_EXTENSION_MARKETPLACES',
      JSON.stringify([
        {
          id: 'legacy',
          name: 'Legacy',
          source: '/legacy/marketplace',
          enabled: true,
        },
      ]),
    );
    marketplaceStore.set('admin', {
      id: 'admin',
      name: 'Admin',
      source: '/admin/marketplace',
      enabled: 1,
      description: null,
      icon_url: null,
      sort_order: 0,
      created_by: 'admin-user',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    const { getExtensionMarketplaceSourcesForResponse } =
      await import('./extension-marketplace-service.js');

    const sources = await getExtensionMarketplaceSourcesForResponse();

    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'admin',
          origin: 'admin_registry',
          readOnly: false,
        }),
        expect.objectContaining({
          id: 'legacy',
          origin: 'legacy_config',
          readOnly: true,
        }),
      ]),
    );
  });

  it('persists marketplace sources to v2 admin storage without rewriting legacy config', async () => {
    configStore.set(
      'WEB_EXTENSION_MARKETPLACES',
      JSON.stringify([
        {
          id: 'legacy',
          name: 'Legacy',
          source: '/legacy/marketplace',
          enabled: true,
        },
      ]),
    );
    const originalLegacyConfig = configStore.get('WEB_EXTENSION_MARKETPLACES');

    const { persistExtensionMarketplaceSources } =
      await import('./extension-marketplace-service.js');

    const sources = await persistExtensionMarketplaceSources([
      {
        id: 'legacy',
        name: 'Legacy',
        source: '/legacy/marketplace',
        enabled: true,
      },
      {
        id: 'admin-next',
        name: 'Admin Next',
        source: '/admin/next',
        enabled: true,
      },
    ]);

    expect(configStore.get('WEB_EXTENSION_MARKETPLACES')).toBe(
      originalLegacyConfig,
    );
    expect(marketplaceStore.get('admin-next')).toMatchObject({
      id: 'admin-next',
      name: 'Admin Next',
      source: '/admin/next',
      enabled: 1,
    });
    expect(marketplaceStore.has('legacy')).toBe(false);
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'legacy', readOnly: true }),
        expect.objectContaining({ id: 'admin-next', readOnly: false }),
      ]),
    );
  });

  it('rejects attempts to mutate read-only legacy marketplace sources through legacy save', async () => {
    configStore.set(
      'WEB_EXTENSION_MARKETPLACES',
      JSON.stringify([
        {
          id: 'legacy',
          name: 'Legacy',
          source: '/legacy/marketplace',
          enabled: true,
        },
      ]),
    );

    const { persistExtensionMarketplaceSources } =
      await import('./extension-marketplace-service.js');

    await expect(
      persistExtensionMarketplaceSources([
        {
          id: 'legacy',
          name: 'Legacy',
          source: '/changed',
          enabled: true,
        },
      ]),
    ).rejects.toThrow(/read-only legacy config/i);
  });

  it('lists catalog entries from a local marketplace source', async () => {
    const marketplaceRoot = path.join(testDataDir, 'marketplace');
    const bundleRoot = path.join(
      marketplaceRoot,
      'bundles',
      'repo-review-bundle',
    );
    fs.mkdirSync(path.join(marketplaceRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(bundleRoot, 'skills', 'repo-review'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(bundleRoot, 'commands'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(bundleRoot, 'agents', 'reviewer'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(bundleRoot, 'skills', 'repo-review', 'SKILL.md'),
      '# Repo Review\n\nReview repo changes.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(bundleRoot, 'commands', 'triage.md'),
      '# Triage\n\nTriage changes.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(bundleRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          docs: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', './docs'],
            enabled: true,
          },
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'Example Marketplace',
        version: '1.0.0',
        plugins: [
          {
            name: 'repo-review-bundle',
            version: '0.2.0',
            description: 'Repo review helpers',
            source: './bundles/repo-review-bundle',
          },
        ],
      }),
      'utf-8',
    );

    const { getExtensionMarketplaceCatalog } =
      await import('./extension-marketplace-service.js');
    const result = await getExtensionMarketplaceCatalog({
      source: marketplaceRoot,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      entryName: 'repo-review-bundle',
      title: 'repo-review-bundle',
      version: '0.2.0',
      marketplaceName: 'Example Marketplace',
      skillCount: 2,
      mcpCount: 1,
      agentCount: 1,
      installable: true,
    });
  });

  it('marks remote marketplace path entries as non-installable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: createHeaders(),
        body: null,
        arrayBuffer: async () =>
          Buffer.from(
            JSON.stringify({
              name: 'Remote Marketplace',
              plugins: [
                {
                  name: 'repo-review-bundle',
                  source: './bundles/repo-review-bundle',
                },
              ],
            }),
            'utf-8',
          ),
      })),
    );

    const { getExtensionMarketplaceCatalog } =
      await import('./extension-marketplace-service.js');
    const result = await getExtensionMarketplaceCatalog({
      source: 'https://example.com/.claude-plugin/marketplace.json',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      entryName: 'repo-review-bundle',
      installable: false,
      skillCount: 0,
      mcpCount: 0,
      agentCount: 0,
    });
    expect(result.entries[0]?.description).toMatch(
      /remote marketplace path sources are not supported/i,
    );
  });

  it('installs skills and MCP servers from a marketplace bundle', async () => {
    const marketplaceRoot = path.join(testDataDir, 'marketplace');
    const bundleRoot = path.join(
      marketplaceRoot,
      'bundles',
      'repo-review-bundle',
    );
    fs.mkdirSync(path.join(marketplaceRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(bundleRoot, 'skills', 'repo-review'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(bundleRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(bundleRoot, 'skills', 'repo-review', 'SKILL.md'),
      '# Repo Review\n\nReview repo changes.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(bundleRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          docs: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', './docs'],
            enabled: true,
          },
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'Example Marketplace',
        plugins: [
          {
            name: 'repo-review-bundle',
            source: './bundles/repo-review-bundle',
          },
        ],
      }),
      'utf-8',
    );
    configStore.set(
      'WEB_EXTENSION_MARKETPLACES',
      JSON.stringify([
        {
          id: 'example',
          name: 'Example',
          source: marketplaceRoot,
          enabled: true,
        },
      ]),
    );

    const {
      getExtensionInstallsForResponse,
      installMarketplaceExtensionFromInput,
    } = await import('./extension-marketplace-service.js');

    const result = await installMarketplaceExtensionFromInput({
      sourceId: 'example',
      entryName: 'repo-review-bundle',
    });

    expect(result.installed.installedSkillIds).toHaveLength(1);
    expect(result.installed.installedMcpServerIds).toHaveLength(1);
    expect(
      fs.existsSync(
        path.join(
          testDataDir,
          'custom-skills',
          result.installed.installedSkillIds[0]!,
          'SKILL.md',
        ),
      ),
    ).toBe(true);

    const installs = await getExtensionInstallsForResponse();
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({
      canonicalId: 'repo-review-bundle',
      name: 'repo-review-bundle',
      sourceType: 'marketplace',
      sourceKind: 'local_path',
      trustState: 'trusted',
      marketplaceEntry: 'repo-review-bundle',
      resolvedSource: bundleRoot,
    });
    expect(installs[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const storedMcp = JSON.parse(
      configStore.get('WEB_MCP_SERVERS') || '{}',
    ) as {
      [key: string]: { command?: string; args?: string[] };
    };
    expect(Object.keys(storedMcp)).toHaveLength(1);
    expect(storedMcp[Object.keys(storedMcp)[0]!]!.args?.[2]).toContain('docs');
  });

  it('rejects installing from a disabled marketplace source', async () => {
    const marketplaceRoot = path.join(testDataDir, 'marketplace-disabled');
    const bundleRoot = path.join(
      marketplaceRoot,
      'bundles',
      'repo-review-bundle',
    );
    fs.mkdirSync(path.join(marketplaceRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(bundleRoot, 'skills', 'repo-review'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(bundleRoot, 'skills', 'repo-review', 'SKILL.md'),
      '# Repo Review\n\nReview repo changes.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'Example Marketplace',
        plugins: [
          {
            name: 'repo-review-bundle',
            source: './bundles/repo-review-bundle',
          },
        ],
      }),
      'utf-8',
    );
    configStore.set(
      'WEB_EXTENSION_MARKETPLACES',
      JSON.stringify([
        {
          id: 'example',
          name: 'Example',
          source: marketplaceRoot,
          enabled: false,
        },
      ]),
    );

    const { installMarketplaceExtensionFromInput } =
      await import('./extension-marketplace-service.js');

    await expect(
      installMarketplaceExtensionFromInput({
        sourceId: 'example',
        entryName: 'repo-review-bundle',
      }),
    ).rejects.toThrow(/marketplace source is disabled/i);
  });

  it('uninstalls an installed extension and removes artifacts', async () => {
    const marketplaceRoot = path.join(testDataDir, 'marketplace-uninstall');
    const bundleRoot = path.join(
      marketplaceRoot,
      'bundles',
      'repo-review-bundle',
    );
    fs.mkdirSync(path.join(marketplaceRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(bundleRoot, 'skills', 'repo-review'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(bundleRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(bundleRoot, 'skills', 'repo-review', 'SKILL.md'),
      '# Repo Review\n\nReview repo changes.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(bundleRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          docs: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', './docs'],
            enabled: true,
          },
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'Example Marketplace',
        plugins: [
          {
            name: 'repo-review-bundle',
            source: './bundles/repo-review-bundle',
          },
        ],
      }),
      'utf-8',
    );
    configStore.set(
      'WEB_EXTENSION_MARKETPLACES',
      JSON.stringify([
        {
          id: 'example',
          name: 'Example',
          source: marketplaceRoot,
          enabled: true,
        },
      ]),
    );

    const {
      getExtensionInstallsForResponse,
      installMarketplaceExtensionFromInput,
      uninstallExtensionFromInput,
    } = await import('./extension-marketplace-service.js');

    const installResult = await installMarketplaceExtensionFromInput({
      sourceId: 'example',
      entryName: 'repo-review-bundle',
    });

    const removedSkillId = installResult.installed.installedSkillIds[0]!;
    const removedMcpId = installResult.installed.installedMcpServerIds[0]!;
    const extensionDir = path.join(
      testDataDir,
      'extensions',
      installResult.installed.id,
    );

    expect(
      fs.existsSync(path.join(testDataDir, 'custom-skills', removedSkillId)),
    ).toBe(true);
    expect(fs.existsSync(extensionDir)).toBe(true);

    const uninstallResult = await uninstallExtensionFromInput({
      installId: installResult.installed.id,
    });

    expect(uninstallResult.removed.id).toBe(installResult.installed.id);
    expect(uninstallResult.installs).toHaveLength(0);
    expect(await getExtensionInstallsForResponse()).toHaveLength(0);
    expect(
      fs.existsSync(path.join(testDataDir, 'custom-skills', removedSkillId)),
    ).toBe(false);
    expect(fs.existsSync(extensionDir)).toBe(false);

    const storedMcp = JSON.parse(
      configStore.get('WEB_MCP_SERVERS') || '{}',
    ) as {
      [key: string]: { command?: string; args?: string[] };
    };
    expect(storedMcp[removedMcpId]).toBeUndefined();
  });

  it('restores the previous install when overwrite fails', async () => {
    const marketplaceRoot = path.join(testDataDir, 'marketplace-overwrite');
    const bundleRoot = path.join(
      marketplaceRoot,
      'bundles',
      'repo-review-bundle',
    );
    fs.mkdirSync(path.join(marketplaceRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(bundleRoot, 'skills', 'repo-review'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(bundleRoot, 'skills', 'repo-review', 'SKILL.md'),
      '# Repo Review\n\nReview repo changes.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(bundleRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          docs: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', './docs'],
            enabled: true,
          },
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'Example Marketplace',
        plugins: [
          {
            name: 'repo-review-bundle',
            source: './bundles/repo-review-bundle',
          },
        ],
      }),
      'utf-8',
    );
    configStore.set(
      'WEB_EXTENSION_MARKETPLACES',
      JSON.stringify([
        {
          id: 'example',
          name: 'Example',
          source: marketplaceRoot,
          enabled: true,
        },
      ]),
    );

    const {
      getExtensionInstallsForResponse,
      importExtensionFromInput,
      installMarketplaceExtensionFromInput,
    } = await import('./extension-marketplace-service.js');

    const installed = await installMarketplaceExtensionFromInput({
      sourceId: 'example',
      entryName: 'repo-review-bundle',
    });
    const installedRecord = installed.installed;
    const installedSkillPath = path.join(
      testDataDir,
      'custom-skills',
      installedRecord.installedSkillIds[0]!,
      'SKILL.md',
    );
    const installedExtensionDir = path.join(
      testDataDir,
      'extensions',
      installedRecord.id,
    );
    const previousMcpConfig = configStore.get('WEB_MCP_SERVERS');

    const invalidBundleRoot = path.join(
      testDataDir,
      'invalid-overwrite-bundle',
    );
    fs.mkdirSync(invalidBundleRoot, { recursive: true });

    await expect(
      importExtensionFromInput({
        source: invalidBundleRoot,
        installId: installedRecord.id,
        overwrite: true,
      }),
    ).rejects.toThrow(/没有可安装内容|未识别到可安装内容/);

    const installs = await getExtensionInstallsForResponse();
    expect(installs).toHaveLength(1);
    expect(installs[0]?.id).toBe(installedRecord.id);
    expect(fs.existsSync(installedSkillPath)).toBe(true);
    expect(fs.existsSync(installedExtensionDir)).toBe(true);
    expect(configStore.get('WEB_MCP_SERVERS')).toBe(previousMcpConfig);
  });

  it('rolls back new install artifacts and MCP config when install persistence fails', async () => {
    const marketplaceRoot = path.join(testDataDir, 'marketplace-persist-fail');
    const bundleRoot = path.join(
      marketplaceRoot,
      'bundles',
      'repo-review-bundle',
    );
    fs.mkdirSync(path.join(marketplaceRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(bundleRoot, 'skills', 'repo-review'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(bundleRoot, 'skills', 'repo-review', 'SKILL.md'),
      '# Repo Review\n\nReview repo changes.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(bundleRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          docs: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', './docs'],
            enabled: true,
          },
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'Example Marketplace',
        plugins: [
          {
            name: 'repo-review-bundle',
            source: './bundles/repo-review-bundle',
          },
        ],
      }),
      'utf-8',
    );
    configStore.set(
      'WEB_EXTENSION_MARKETPLACES',
      JSON.stringify([
        {
          id: 'example',
          name: 'Example',
          source: marketplaceRoot,
          enabled: true,
        },
      ]),
    );
    configStore.set(
      'WEB_MCP_SERVERS',
      JSON.stringify({
        existing: {
          id: 'existing',
          name: 'existing',
          command: 'node',
          args: ['existing.js'],
          env: {},
          enabled: true,
        },
      }),
    );
    setConfigFailureKeys.add('WEB_EXTENSION_INSTALLS');

    const {
      getExtensionInstallsForResponse,
      installMarketplaceExtensionFromInput,
    } = await import('./extension-marketplace-service.js');

    await expect(
      installMarketplaceExtensionFromInput({
        sourceId: 'example',
        entryName: 'repo-review-bundle',
      }),
    ).rejects.toThrow(/setConfig failed for WEB_EXTENSION_INSTALLS/);

    expect(await getExtensionInstallsForResponse()).toHaveLength(0);
    expect(
      fs.existsSync(path.join(testDataDir, 'custom-skills', 'repo-review')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(testDataDir, 'extensions', 'repo-review-bundle')),
    ).toBe(false);
    expect(configStore.get('WEB_MCP_SERVERS')).toBe(
      JSON.stringify({
        existing: {
          id: 'existing',
          name: 'existing',
          command: 'node',
          args: ['existing.js'],
          env: {},
          enabled: true,
        },
      }),
    );
  });

  it('reconciles extension install status and warnings', async () => {
    const marketplaceRoot = path.join(testDataDir, 'marketplace-reconcile');
    const bundleRoot = path.join(
      marketplaceRoot,
      'bundles',
      'repo-review-bundle',
    );
    fs.mkdirSync(path.join(marketplaceRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(bundleRoot, 'skills', 'repo-review'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(bundleRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(bundleRoot, 'skills', 'repo-review', 'SKILL.md'),
      '# Repo Review\n\nReview repo changes.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(bundleRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          docs: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', './docs'],
            enabled: true,
          },
        },
      }),
      'utf-8',
    );
    fs.mkdirSync(path.join(bundleRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(bundleRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ id: 'repo-review-bundle' }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'Example Marketplace',
        plugins: [
          {
            name: 'repo-review-bundle',
            source: './bundles/repo-review-bundle',
          },
        ],
      }),
      'utf-8',
    );
    configStore.set(
      'WEB_EXTENSION_MARKETPLACES',
      JSON.stringify([
        {
          id: 'example',
          name: 'Example',
          source: marketplaceRoot,
          enabled: true,
        },
      ]),
    );

    const { installMarketplaceExtensionFromInput, reconcileExtensionInstalls } =
      await import('./extension-marketplace-service.js');

    const installed = await installMarketplaceExtensionFromInput({
      sourceId: 'example',
      entryName: 'repo-review-bundle',
    });
    const installRecord = installed.installed;
    const skillPath = path.join(
      testDataDir,
      'custom-skills',
      installRecord.installedSkillIds[0]!,
      'SKILL.md',
    );
    const extensionSkillPath = path.join(
      testDataDir,
      'extensions',
      installRecord.id,
      'skills',
      'repo-review',
      'SKILL.md',
    );

    fs.rmSync(skillPath, { force: true });
    fs.writeFileSync(
      extensionSkillPath,
      '# Repo Review\n\nChanged content.\n',
      'utf-8',
    );
    configStore.set('WEB_MCP_SERVERS', JSON.stringify({}));

    const reconciled = await reconcileExtensionInstalls();

    expect(reconciled.installs).toHaveLength(1);
    expect(reconciled.installs[0]?.id).toBe(installRecord.id);
    expect(reconciled.installs[0]?.status).toBe('needs_attention');
    expect(reconciled.installs[0]?.warnings.join(' | ')).toMatch(/Skill 缺失/);
    expect(reconciled.installs[0]?.warnings.join(' | ')).toMatch(/MCP 缺失/);
    expect(reconciled.installs[0]?.warnings.join(' | ')).toMatch(
      /扩展内容(?:哈希)?已变化/,
    );
  });

  it('imports a standalone SKILL.md file as a skill bundle', async () => {
    const skillDir = path.join(testDataDir, 'single-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(
      skillFile,
      '# Standalone Skill\n\nUse this standalone skill.\n',
      'utf-8',
    );

    const { getExtensionInstallsForResponse, importExtensionFromInput } =
      await import('./extension-marketplace-service.js');

    const result = await importExtensionFromInput({
      source: skillFile,
    });

    expect(result.installed.name).toBe('single-skill');
    expect(result.installed.canonicalId).toBe('single-skill');
    expect(result.installed.trustState).toBe('local');
    expect(result.installed.installedSkillIds).toHaveLength(1);
    expect(result.installed.resolvedSource).toBe(skillFile);
    expect(result.installed.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      fs.existsSync(
        path.join(
          testDataDir,
          'custom-skills',
          result.installed.installedSkillIds[0]!,
          'SKILL.md',
        ),
      ),
    ).toBe(true);
    expect((await getExtensionInstallsForResponse())[0]?.sourceType).toBe(
      'import',
    );
  });

  it('imports a remote raw SKILL.md link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => ({
        ok: true,
        status: 200,
        headers: createHeaders(),
        body: null,
        arrayBuffer: async () =>
          Buffer.from(
            input.toString().includes('SKILL.md')
              ? '# Remote Skill\n\nRemote bundle skill.\n'
              : '',
            'utf-8',
          ),
      })),
    );

    const { importExtensionFromInput } =
      await import('./extension-marketplace-service.js');

    const result = await importExtensionFromInput({
      source: 'https://example.com/repo-review/SKILL.md',
    });

    expect(result.installed.name).toBe('repo-review');
    expect(result.installed.canonicalId).toBe('repo-review');
    expect(result.installed.sourceRef).toBe(
      'https://example.com/repo-review/SKILL.md',
    );
    expect(result.installed.sourceKind).toBe('remote_file');
    expect(result.installed.trustState).toBe('needs_review');
    expect(result.installed.resolvedSource).toBe(
      'https://example.com/repo-review/SKILL.md',
    );
    expect(result.installed.installedSkillIds).toHaveLength(1);
    expect(result.installed.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      fs.existsSync(
        path.join(
          testDataDir,
          'custom-skills',
          result.installed.installedSkillIds[0]!,
          'SKILL.md',
        ),
      ),
    ).toBe(true);
  });

  it('imports a local zip bundle', async () => {
    const bundleRoot = path.join(testDataDir, 'zip-bundle');
    fs.mkdirSync(path.join(bundleRoot, 'skills', 'zip-skill'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(bundleRoot, 'skills', 'zip-skill', 'SKILL.md'),
      '# Zip Skill\n\nFrom zip archive.\n',
      'utf-8',
    );

    const zip = new JSZip();
    zip.file(
      'zip-bundle/skills/zip-skill/SKILL.md',
      '# Zip Skill\n\nFrom zip archive.\n',
    );
    const archivePath = path.join(testDataDir, 'zip-bundle.zip');
    fs.writeFileSync(
      archivePath,
      await zip.generateAsync({ type: 'nodebuffer' }),
    );

    const { importExtensionFromInput } =
      await import('./extension-marketplace-service.js');

    const result = await importExtensionFromInput({
      source: archivePath,
    });

    expect(result.installed.name).toBe('zip-bundle');
    expect(result.installed.sourceKind).toBe('local_path');
    expect(result.installed.trustState).toBe('local');
    expect(result.installed.resolvedSource).toBe(archivePath);
    expect(result.installed.installedSkillIds).toHaveLength(1);
  });

  it('imports a remote zip bundle link', async () => {
    const zip = new JSZip();
    zip.file(
      'repo-review-bundle/skills/repo-review/SKILL.md',
      '# Repo Review\n\nFrom remote zip.\n',
    );
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: createHeaders(),
        body: null,
        arrayBuffer: async () => zipBuffer,
      })),
    );

    const { importExtensionFromInput } =
      await import('./extension-marketplace-service.js');

    const result = await importExtensionFromInput({
      source: 'https://example.com/repo-review-bundle.zip',
    });

    expect(result.installed.name).toBe('repo-review-bundle');
    expect(result.installed.sourceKind).toBe('remote_file');
    expect(result.installed.trustState).toBe('needs_review');
    expect(result.installed.resolvedSource).toBe(
      'https://example.com/repo-review-bundle.zip',
    );
    expect(result.installed.installedSkillIds).toHaveLength(1);
  });

  it('rejects zip archives that exceed entry count limits', async () => {
    const zip = new JSZip();
    for (let index = 0; index < 5001; index += 1) {
      zip.file(`bundle/skills/skill-${index}/SKILL.md`, `# Skill ${index}\n`);
    }
    const archivePath = path.join(testDataDir, 'too-many-entries.zip');
    fs.writeFileSync(
      archivePath,
      await zip.generateAsync({ type: 'nodebuffer' }),
    );

    const { importExtensionFromInput } =
      await import('./extension-marketplace-service.js');

    await expect(
      importExtensionFromInput({
        source: archivePath,
      }),
    ).rejects.toThrow(/archive entry count exceeds limit/i);
  });

  it('rejects remote raw files that exceed the fetch size limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: createHeaders({
          'content-length': String(MAX_REMOTE_FETCH_BYTES + 1),
        }),
        body: null,
        arrayBuffer: async () => {
          throw new Error('should not read body');
        },
      })),
    );

    const { importExtensionFromInput } =
      await import('./extension-marketplace-service.js');

    await expect(
      importExtensionFromInput({
        source: 'https://example.com/repo-review/SKILL.md',
      }),
    ).rejects.toThrow(/remote response exceeds size limit/i);
  });

  it('rejects remote archives that exceed the fetch size limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: createHeaders({
          'content-length': String(MAX_REMOTE_FETCH_BYTES + 1),
        }),
        body: null,
        arrayBuffer: async () => {
          throw new Error('should not read body');
        },
      })),
    );

    const { importExtensionFromInput } =
      await import('./extension-marketplace-service.js');

    await expect(
      importExtensionFromInput({
        source: 'https://example.com/repo-review-bundle.zip',
      }),
    ).rejects.toThrow(/remote response exceeds size limit/i);
  });
});
