import { describe, expect, it } from 'vitest';

import {
  isReadOnlyShellCommand,
  mapWorkspacePathsInShellCommand,
} from './workspace-permissions.js';

describe('workspace permission shell command classification', () => {
  it('treats transparent shell wrappers around read-only review commands as read-only', () => {
    expect(
      isReadOnlyShellCommand(
        'bash -lc "git -C /workspace/extra diff HEAD~1..HEAD -- src/app.ts"',
      ),
    ).toBe(true);
    expect(
      isReadOnlyShellCommand(
        "sh -c 'cd /workspace/extra && rg authenticate src'",
      ),
    ).toBe(true);
    expect(
      isReadOnlyShellCommand(
        "git ls-tree -r HEAD --name-only | grep -i 'repo-review-agent-system-prompt'",
      ),
    ).toBe(true);
    expect(
      isReadOnlyShellCommand('git ls-tree HEAD -- src/repo-review/'),
    ).toBe(true);
    expect(
      isReadOnlyShellCommand(
        "find /workspace/extra -name '*repo-review-agent-system-prompt*' -o -name '*agent-system-prompt*' 2>/dev/null",
      ),
    ).toBe(true);
    expect(
      isReadOnlyShellCommand(
        "git show HEAD:src/repo-review/repo-review-agent-system-prompt.ts 2>/dev/null || git show HEAD:src/repo-review/repo-review-agent-system-prompt.js 2>/dev/null || echo 'NOT FOUND'",
      ),
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

  it('maps virtual /workspace paths inside shell commands before execution', () => {
    const previous = process.env.NANOCLAW_EXTRA_DIR;
    process.env.NANOCLAW_EXTRA_DIR = '/tmp/nanoclaw-review-worktree';
    try {
      expect(
        mapWorkspacePathsInShellCommand(
          'git -C /workspace/extra diff -- src/app.ts && cd /workspace/extra',
        ),
      ).toBe(
        'git -C /tmp/nanoclaw-review-worktree diff -- src/app.ts && cd /tmp/nanoclaw-review-worktree',
      );
    } finally {
      if (previous === undefined) {
        delete process.env.NANOCLAW_EXTRA_DIR;
      } else {
        process.env.NANOCLAW_EXTRA_DIR = previous;
      }
    }
  });
});
