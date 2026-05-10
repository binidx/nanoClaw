import { describe, expect, it } from 'vitest';

import { createBashApprovalCache } from './bash-approval-cache';

describe('bash approval cache', () => {
  it('reuses an active patch for the same command', () => {
    const cache = createBashApprovalCache();
    const now = Date.parse('2026-03-18T14:00:00.000Z');

    cache.apply(
      {
        command: 'git   status',
        cwd: '/workspace/project',
        expiresAt: '2026-03-18T14:02:00.000Z',
      },
      now,
    );

    expect(
      cache.has(
        {
          command: 'git status',
          cwd: '/workspace/project',
        },
        now + 10_000,
      ),
    ).toBe(true);
  });

  it('does not reuse expired patches', () => {
    const cache = createBashApprovalCache();
    const now = Date.parse('2026-03-18T14:00:00.000Z');

    cache.apply(
      {
        command: 'git status',
        cwd: '/workspace/project',
        expiresAt: '2026-03-18T14:00:20.000Z',
      },
      now,
    );

    expect(
      cache.has(
        {
          command: 'git status',
          cwd: '/workspace/project',
        },
        now + 25_000,
      ),
    ).toBe(false);
  });

  it('does not reuse an active patch across different cwd values', () => {
    const cache = createBashApprovalCache();
    const now = Date.parse('2026-03-18T14:00:00.000Z');

    cache.apply(
      {
        command: 'npm run build',
        cwd: '/workspace/project-a',
        expiresAt: '2026-03-18T14:02:00.000Z',
      },
      now,
    );

    expect(
      cache.has(
        {
          command: 'npm run build',
          cwd: '/workspace/project-b',
        },
        now + 10_000,
      ),
    ).toBe(false);
  });
});
