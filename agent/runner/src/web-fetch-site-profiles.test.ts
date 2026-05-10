import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveProfilesFilePath } from './web-fetch-site-profiles.js';

describe('resolveProfilesFilePath', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds shared profiles from a session agent-runner-dist directory', () => {
    const currentDir = path.join(
      '/repo',
      'data',
      'sessions',
      'group-1',
      'agent-runner-dist',
    );
    const expected = path.join('/repo', 'shared', 'web-fetch-site-profiles.json');
    const existsSpy = vi
      .spyOn(fs, 'existsSync')
      .mockImplementation((target: fs.PathLike) => String(target) === expected);

    const filePath = resolveProfilesFilePath(currentDir, '/repo/groups/group-1');

    expect(filePath).toBe(expected);
    expect(existsSpy).toHaveBeenCalledWith(expected);
  });
});
