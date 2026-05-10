import { describe, expect, it } from 'vitest';

import {
  createBashApprovalAllowRule,
  normalizeBashApprovalAllowlist,
  parseBashApprovalAllowlistPrefix,
} from './bash-approval-allowlist.js';

describe('bash approval allowlist', () => {
  it('tokenizes simple shell commands into argv prefixes', () => {
    expect(parseBashApprovalAllowlistPrefix('git commit -m "hello world"')).toEqual([
      'git',
      'commit',
      '-m',
      'hello world',
    ]);
  });

  it('rejects complex shell syntax for allowlist entries', () => {
    expect(() => parseBashApprovalAllowlistPrefix('git status | cat')).toThrow(
      /复杂 shell 结构/,
    );
  });

  it('normalizes stored rules and removes duplicates', () => {
    const rules = normalizeBashApprovalAllowlist([
      {
        id: 'a',
        prefix: ['npm', 'run', 'build'],
        label: 'npm run build',
        enabled: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        createdFrom: 'manual',
      },
      {
        id: 'b',
        prefix: ['npm', 'run', 'build'],
        label: 'duplicate',
        enabled: true,
        createdAt: '2026-03-18T00:00:01.000Z',
        createdFrom: 'approval',
      },
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0]?.prefix).toEqual(['npm', 'run', 'build']);
  });

  it('creates approval rules from a command string', () => {
    const rule = createBashApprovalAllowRule('git push origin main', {
      createdFrom: 'approval',
      createdAt: '2026-03-18T00:00:00.000Z',
    });

    expect(rule.prefix).toEqual(['git', 'push', 'origin', 'main']);
    expect(rule.createdFrom).toBe('approval');
    expect(rule.label).toBe('git push origin main');
  });
});
