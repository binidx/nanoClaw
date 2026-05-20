import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nanoclaw-registry-test-'),
);
const createdSkills: Array<Record<string, unknown>> = [];
const createdMcps: Array<Record<string, unknown>> = [];
const installRecords: Array<Record<string, unknown>> = [];

vi.mock('../logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../user/user-skill-service.js', () => ({
  createUserSkill: vi.fn(
    async (_userId: string, input: Record<string, unknown>) => {
      createdSkills.push(input);
      return {
        id: `skill-${createdSkills.length}`,
        userId: 'user-a',
        name: input.name,
        description: input.description ?? null,
        summary: null,
        skillContent: input.skillContent ?? null,
        enabled: true,
        visibility: 'private',
        sourceType: input.sourceType ?? 'registry',
        sourceRef: input.sourceRef ?? null,
        iconUrl: null,
        tags: Array.isArray(input.tags) ? input.tags : [],
        metadata: input.metadata ?? { capabilities: [] },
        healthStatus: {
          state: 'ready',
          summary: 'ready',
          checkedAt: new Date().toISOString(),
          issues: [],
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isOwner: true,
      };
    },
  ),
}));

vi.mock('../user/user-mcp-service.js', () => ({
  createUserMcpServer: vi.fn(
    async (_userId: string, input: Record<string, unknown>) => {
      createdMcps.push(input);
      return {
        id: `mcp-${createdMcps.length}`,
        userId: 'user-a',
        name: input.name,
        description: input.description ?? null,
        command: input.command ?? '',
        args: Array.isArray(input.args) ? input.args : [],
        env: typeof input.env === 'object' && input.env ? input.env : {},
        transport: 'stdio',
        url: null,
        cwd: null,
        enabled: true,
        visibility: 'private',
        sourceType: input.sourceType ?? 'registry',
        sourceRef: input.sourceRef ?? null,
        iconUrl: null,
        tags: Array.isArray(input.tags) ? input.tags : [],
        metadata: input.metadata ?? { capabilities: [] },
        healthStatus: {
          state: 'ready',
          summary: 'ready',
          checkedAt: new Date().toISOString(),
          issues: [],
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isOwner: true,
      };
    },
  ),
}));

vi.mock('../db.js', () => ({
  generateInstallId: () => `inst-${installRecords.length + 1}`,
  upsertMarketplaceInstall: vi.fn(async (record: Record<string, unknown>) => {
    installRecords.push(record);
  }),
}));

describe('registry service', () => {
  beforeEach(() => {
    vi.resetModules();
    createdSkills.length = 0;
    createdMcps.length = 0;
    installRecords.length = 0;
    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.mkdirSync(testDataDir, { recursive: true });
  });

  it('lists local OpenClaw-style skill directories as registry items', async () => {
    const skillsRoot = path.join(testDataDir, 'skills');
    const skillDir = path.join(skillsRoot, 'github');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '# GitHub\n\nUse GitHub tools safely.',
      'utf-8',
    );

    process.env.NANOCLAW_REGISTRY_CATALOG_URLS = skillsRoot;
    const { fetchRegistryCatalog } = await import('./registry-service.js');
    const result = await fetchRegistryCatalog({ forceRefresh: true });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'GitHub',
          type: 'skill',
          source: expect.objectContaining({
            kind: 'local',
            path: skillDir,
          }),
          sourceLabel: 'OpenClaw Skills',
        }),
      ]),
    );
  });

  it('installs a local registry skill as a private user copy', async () => {
    const skillsRoot = path.join(testDataDir, 'skills');
    const skillDir = path.join(skillsRoot, 'mcporter');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '# Mcporter\n\nRoute external web tools.',
      'utf-8',
    );

    process.env.NANOCLAW_REGISTRY_CATALOG_URLS = skillsRoot;
    const { fetchRegistryCatalog, installFromRegistry } =
      await import('./registry-service.js');
    const catalog = await fetchRegistryCatalog({ forceRefresh: true });
    const target = catalog.items.find((item) => item.name === 'Mcporter');
    expect(target).toBeTruthy();
    const installed = await installFromRegistry('user-a', target!.slug);

    expect(installed).toHaveLength(1);
    expect(createdSkills[0]).toMatchObject({
      name: 'Mcporter',
      visibility: 'private',
      sourceType: 'registry',
      sourceRef: `${target!.slug}@latest`,
    });
    expect(installRecords[0]).toMatchObject({
      id: 'inst-1',
      user_id: 'user-a',
      source_id: null,
      entry_name: target!.slug,
      entry_type: 'skill',
      target_id: 'skill-1',
      status: 'installed',
    });
  });
});
