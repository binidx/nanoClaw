import { describe, expect, it } from 'vitest';

import { isReadOnlyShellCommand } from './workspace-permissions.js';

describe('workspace permission shell command classification', () => {
  it('treats transparent shell wrappers around read-only review commands as read-only', () => {
    expect(
      isReadOnlyShellCommand(
        'bash -lc "git -C /workspace/extra diff HEAD~1..HEAD -- src/app.ts"',
      ),
    ).toBe(true);
    expect(
      isReadOnlyShellCommand("sh -c 'cd /workspace/extra && rg authenticate src'"),
    ).toBe(true);
  });

  it('keeps mutating commands non-read-only after unwrapping shell wrappers', () => {
    expect(isReadOnlyShellCommand('bash -lc "rm -rf /workspace/extra"')).toBe(
      false,
    );
    expect(
      isReadOnlyShellCommand("sh -c 'cd /workspace/extra && touch changed.ts'"),
    ).toBe(false);
  });
});
