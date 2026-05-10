import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  repairNodePtySpawnHelperPermissions,
  resolveStreamTerminalLaunch,
  resolveTerminalLaunch,
} from './web/terminal-shell.js';

describe('resolveTerminalLaunch', () => {
  it('prefers configured unix shell when available', () => {
    const result = resolveTerminalLaunch('linux', { SHELL: '/bin/bash' });
    expect(result).toEqual({ shell: '/bin/bash', args: [] });
  });

  it('uses pwsh path on windows when provided', () => {
    const result = resolveTerminalLaunch('win32', {
      PWSH_PATH: 'C:/Program Files/PowerShell/7/pwsh.exe',
    });
    expect(result).toEqual({
      shell: 'C:/Program Files/PowerShell/7/pwsh.exe',
      args: ['-NoLogo'],
    });
  });

  it('falls back to COMSPEC on windows cmd environments', () => {
    const result = resolveTerminalLaunch('win32', {
      COMSPEC: 'C:/Windows/System32/cmd.exe',
    });
    expect(result).toEqual({ shell: 'C:/Windows/System32/cmd.exe', args: [] });
  });
});

it('prefers bash fallback when SHELL points to zsh', () => {
  const result = resolveTerminalLaunch('linux', { SHELL: '/bin/zsh' });
  expect(['/bin/zsh', '/bin/bash', '/bin/sh']).toContain(result.shell);
});

it('uses interactive zsh fallback args on macOS stream terminals', () => {
  const result = resolveStreamTerminalLaunch(
    { shell: '/bin/zsh', args: [] },
    'darwin',
  );
  expect(result).toEqual({ shell: '/bin/zsh', args: ['-f', '-i'] });
});

it('uses interactive bash fallback args on unix stream terminals', () => {
  const result = resolveStreamTerminalLaunch(
    { shell: '/bin/bash', args: [] },
    'linux',
  );
  expect(result).toEqual({ shell: '/bin/bash', args: ['-i'] });
});

describe('repairNodePtySpawnHelperPermissions', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds execute bits to unix spawn-helper when missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pty-'));
    tempDirs.push(root);
    const helperPath = path.join(
      root,
      'node_modules',
      'node-pty',
      'prebuilds',
      'darwin-arm64',
      'spawn-helper',
    );
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.writeFileSync(helperPath, 'helper', 'utf8');
    fs.chmodSync(helperPath, 0o644);

    const result = repairNodePtySpawnHelperPermissions({
      projectRoot: root,
      platform: 'darwin',
      arch: 'arm64',
    });

    expect(result).toEqual({ repaired: true, helperPath });
    if (process.platform !== 'win32') {
      expect(fs.statSync(helperPath).mode & 0o111).toBe(0o111);
    }
  });

  it('ignores windows and missing helpers', () => {
    expect(
      repairNodePtySpawnHelperPermissions({
        projectRoot: '/tmp/does-not-matter',
        platform: 'win32',
        arch: 'x64',
      }),
    ).toEqual({ repaired: false, helperPath: null });
  });
});
