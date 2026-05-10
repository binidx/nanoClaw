import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  generateSkillIdMock,
  upsertUserSkillMock,
  listVisibleSkillsMock,
  listUserSkillsMock,
  ensureUserHydratedMock,
} = vi.hoisted(() => ({
  generateSkillIdMock: vi.fn(() => 'skill-generated'),
  upsertUserSkillMock: vi.fn(),
  listVisibleSkillsMock: vi.fn(),
  listUserSkillsMock: vi.fn(),
  ensureUserHydratedMock: vi.fn(async () => undefined),
}));

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-user-skill-'));

vi.mock('../config.js', () => ({
  DATA_DIR: tempDataDir,
}));

vi.mock('../db.js', () => ({
  generateSkillId: generateSkillIdMock,
  upsertUserSkill: upsertUserSkillMock,
  getUserSkill: vi.fn(),
  listUserSkills: listUserSkillsMock,
  listVisibleSkills: listVisibleSkillsMock,
  deleteUserSkill: vi.fn(),
  deleteMarketplaceInstallsByTarget: vi.fn(),
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

describe('user skill service', () => {
  beforeEach(() => {
    fs.rmSync(tempDataDir, { recursive: true, force: true });
    fs.mkdirSync(tempDataDir, { recursive: true });
    vi.clearAllMocks();
    generateSkillIdMock.mockReturnValue('skill-generated');
  });

  it('imports a local skill directory and preserves additional files', async () => {
    const sourceDir = path.join(tempDataDir, 'source-skill');
    fs.mkdirSync(path.join(sourceDir, 'references'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'SKILL.md'),
      '# Imported Skill\n\nUse the local endpoint.',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(sourceDir, 'references', 'api.md'),
      'POST /txt2img',
      'utf-8',
    );

    const { importUserSkillFromPath } = await import('./user-skill-service.js');
    const result = await importUserSkillFromPath('user-a', {
      sourcePath: sourceDir,
      visibility: 'private',
    });

    const expectedRoot = path.join(
      tempDataDir,
      'users',
      'user-a',
      'skills',
      'skill-generated',
    );
    expect(upsertUserSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'skill-generated',
        name: 'Imported Skill',
        source_type: 'import',
        source_ref: path.resolve(sourceDir),
      }),
    );
    expect(result.skill.id).toBe('skill-generated');
    expect(result.imported.path).toBe(expectedRoot);
    expect(fs.existsSync(path.join(expectedRoot, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(expectedRoot, 'references', 'api.md'))).toBe(true);
    expect(fs.existsSync(path.join(expectedRoot, 'meta.json'))).toBe(true);
  });
});
