import path from 'path';

import { describe, expect, it } from 'vitest';

import { resolveProfilesFilePath } from '../agent/runner/src/web-fetch-site-profiles.js';

describe('agent-runner web-fetch-site-profiles', () => {
  it('prefers the project shared profiles file for per-session dist directories', () => {
    const simulatedDistDir = path.join(
      process.cwd(),
      'data',
      'sessions',
      'feishu_test',
      'agent-runner-dist',
    );

    const resolved = resolveProfilesFilePath(simulatedDistDir, process.cwd());

    expect(resolved).toBe(
      path.join(process.cwd(), 'shared', 'web-fetch-site-profiles.json'),
    );
  });

  it('falls back to the local relative shared path when no project root is provided', () => {
    const resolved = resolveProfilesFilePath(undefined, undefined);

    expect(resolved).toBe(
      path.join(process.cwd(), 'shared', 'web-fetch-site-profiles.json'),
    );
  });
});
