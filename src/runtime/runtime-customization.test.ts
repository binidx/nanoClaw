import fs from 'fs';
import os from 'os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetManagedSkillDefinitionCacheForTests,
  getManagedSkillDetail,
  listManagedSkills,
} from './runtime-customization.js';

describe('managed skill definition cache', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-'));
    _resetManagedSkillDefinitionCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    _resetManagedSkillDefinitionCacheForTests();
  });

  it('reloads a skill definition after SKILL.md changes', () => {
    const skillDir = path.join(tempDir, 'agent', 'skills', 'demo-skill');
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      skillPath,
      '# Demo Skill\n\nfirst description\n\nInitial body\n',
      'utf8',
    );

    const first = listManagedSkills(tempDir).find(
      (skill) => skill.id === 'demo-skill',
    );
    expect(first?.name).toBe('Demo Skill');
    expect(first?.description).toBe('first description');

    fs.writeFileSync(
      skillPath,
      '# Demo Skill Updated\n\nsecond description expanded\n\nUpdated body\n',
      'utf8',
    );

    const second = listManagedSkills(tempDir).find(
      (skill) => skill.id === 'demo-skill',
    );
    expect(second?.name).toBe('Demo Skill Updated');
    expect(second?.description).toBe('second description expanded');
  });

  it('returns detail summary without frontmatter noise', () => {
    const skillDir = path.join(tempDir, 'agent', 'skills', 'frontmatter-skill');
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      skillPath,
      [
        '---',
        'name: frontmatter-skill',
        'description: hidden frontmatter',
        '---',
        '',
        '# Frontmatter Skill',
        '',
        'First visible paragraph.',
        '',
        '- bullet one',
        '- bullet two',
        '',
        'Second visible paragraph.',
        '',
      ].join('\n'),
      'utf8',
    );

    const detail = getManagedSkillDetail('frontmatter-skill', tempDir);
    expect(detail?.name).toBe('Frontmatter Skill');
    expect(detail?.description).toBe('First visible paragraph.');
    expect(detail?.summary).toContain('First visible paragraph.');
    expect(detail?.summary).toContain('bullet one');
    expect(detail?.summary).not.toContain('name: frontmatter-skill');
  });
});
