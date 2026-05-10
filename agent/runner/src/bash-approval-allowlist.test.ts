import { describe, expect, it } from 'vitest';

import {
  canWhitelistBashCommand,
  commandMatchesBashApprovalAllowlist,
  normalizeBashApprovalAllowlist,
} from './bash-approval-allowlist.js';

describe('agent runner bash approval allowlist', () => {
  it('matches commands by argv prefix', () => {
    const rules = normalizeBashApprovalAllowlist([
      {
        id: 'a',
        prefix: ['git', 'push', 'origin', 'main'],
        label: 'git push origin main',
        enabled: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        createdFrom: 'manual',
      },
    ]);

    expect(commandMatchesBashApprovalAllowlist('git push origin main', rules)).toBe(
      true,
    );
    expect(commandMatchesBashApprovalAllowlist('git push origin dev', rules)).toBe(
      false,
    );
  });

  it('ignores disabled rules', () => {
    const rules = normalizeBashApprovalAllowlist([
      {
        id: 'a',
        prefix: ['npm', 'run', 'build'],
        label: 'npm run build',
        enabled: false,
        createdAt: '2026-03-18T00:00:00.000Z',
        createdFrom: 'manual',
      },
    ]);

    expect(commandMatchesBashApprovalAllowlist('npm run build', rules)).toBe(
      false,
    );
  });

  it('marks only simple commands as whitelistable', () => {
    expect(canWhitelistBashCommand('git status')).toBe(true);
    expect(canWhitelistBashCommand('git status | cat')).toBe(false);
  });
});
