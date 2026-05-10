import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  expandUserPath,
  normalizeAllowedDirectories,
  parseAllowedDirectoriesValue,
} from './allowed-directories.js';

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-allowed-dirs-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('allowed directories helpers', () => {
  it('expands home-relative paths', () => {
    const homeDir = process.env.HOME || os.homedir();
    expect(expandUserPath('~/demo')).toBe(path.join(homeDir, 'demo'));
  });

  it('normalizes, resolves and deduplicates directories', () => {
    const root = makeTempDir();
    const alpha = path.join(root, 'alpha');
    const beta = path.join(root, 'beta');
    fs.mkdirSync(alpha, { recursive: true });
    fs.mkdirSync(beta, { recursive: true });

    const normalized = normalizeAllowedDirectories([
      alpha,
      path.join(root, '.', 'alpha'),
      beta,
      '   ',
    ]);

    expect(normalized).toEqual(
      [fs.realpathSync(alpha), fs.realpathSync(beta)].sort(),
    );
  });

  it('rejects missing directories', () => {
    expect(() =>
      normalizeAllowedDirectories(['/definitely/missing/path']),
    ).toThrow(/Directory does not exist/);
  });

  it('parses config JSON values', () => {
    const root = makeTempDir();
    const alpha = path.join(root, 'alpha');
    fs.mkdirSync(alpha, { recursive: true });

    expect(parseAllowedDirectoriesValue(JSON.stringify([alpha]))).toEqual([
      fs.realpathSync(alpha),
    ]);
    expect(parseAllowedDirectoriesValue('')).toEqual([]);
  });
});
