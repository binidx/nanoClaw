import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveRuntimeAccessPolicy,
} from './auth/access-policy.js';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const next = fs.mkdtempSync(path.join('/tmp', prefix));
  tempDirs.push(next);
  return fs.realpathSync(next);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const target = tempDirs.pop();
    if (!target) continue;
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('resolveRuntimeAccessPolicy', () => {
  it('treats directory-only overrides as allowlist policy', () => {
    const reviewRoot = createTempDir('nanoclaw-access-policy-review-');

    expect(
      resolveRuntimeAccessPolicy({
        defaultMode: 'allowall',
        defaultDirectories: [],
        override: {
          directories: [reviewRoot],
        },
      }),
    ).toEqual({
      mode: 'allowlist',
      directories: [reviewRoot],
    });
  });

  it('prefers configured accessPolicy over legacy fields', () => {
    const configuredRoot = createTempDir('nanoclaw-access-policy-configured-');
    const legacyRoot = createTempDir('nanoclaw-access-policy-legacy-');

    expect(
      resolveRuntimeAccessPolicy({
        defaultMode: 'allowall',
        configured: {
          accessPolicy: {
            mode: 'readonly',
            directories: [configuredRoot],
          },
          allowedDirectories: [legacyRoot],
          strictAllowedDirectories: true,
        },
      }),
    ).toEqual({
      mode: 'readonly',
      directories: [configuredRoot],
    });
  });

  it('falls back to legacy directories and inherits the default mode', () => {
    const legacyRoot = createTempDir('nanoclaw-access-policy-fallback-');

    expect(
      resolveRuntimeAccessPolicy({
        defaultPolicy: {
          mode: 'readonly',
          directories: ['/srv/default'],
        },
        configured: {
          allowedDirectories: [legacyRoot],
          strictAllowedDirectories: false,
        },
      }),
    ).toEqual({
      mode: 'readonly',
      directories: [legacyRoot],
    });
  });

  it('uses assistant policy as the persistent source for assistant-managed chats', () => {
    const assistantRoot = createTempDir('nanoclaw-access-policy-assistant-');
    const legacyRoot = createTempDir('nanoclaw-access-policy-conversation-');

    expect(
      resolveRuntimeAccessPolicy({
        defaultPolicy: {
          mode: 'allowall',
          directories: ['/srv/default'],
        },
        configured: {
          allowedDirectories: [legacyRoot],
          strictAllowedDirectories: true,
        },
        assistantPolicy: {
          mode: 'readonly',
          directories: [assistantRoot],
        },
        assistantManaged: true,
      }),
    ).toEqual({
      mode: 'readonly',
      directories: [assistantRoot],
    });
  });
});
