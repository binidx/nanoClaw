import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectProfilesForWorktree } from './project-detector.js';
import { BUILTIN_PROFILES, findProfileById } from './runner-profiles.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-detector-'));
}

function touch(dir: string, rel: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '');
}

describe('detectProfilesForWorktree', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty array for an empty directory', () => {
    expect(detectProfilesForWorktree(dir)).toEqual([]);
  });

  it('detects nodejs from package.json', () => {
    touch(dir, 'package.json');
    const result = detectProfilesForWorktree(dir);
    expect(result.map((p) => p.id)).toEqual(['nodejs']);
  });

  it('detects go from go.mod', () => {
    touch(dir, 'go.mod');
    const result = detectProfilesForWorktree(dir);
    expect(result.map((p) => p.id)).toEqual(['go']);
  });

  it('detects java8 from pom.xml', () => {
    touch(dir, 'pom.xml');
    const result = detectProfilesForWorktree(dir);
    expect(result.map((p) => p.id)).toContain('java8');
  });

  it('detects java8 from build.gradle', () => {
    touch(dir, 'build.gradle');
    const result = detectProfilesForWorktree(dir);
    expect(result.map((p) => p.id)).toContain('java8');
  });

  it('detects python from pyproject.toml', () => {
    touch(dir, 'pyproject.toml');
    const result = detectProfilesForWorktree(dir);
    expect(result.map((p) => p.id)).toContain('python');
  });

  it('detects python from requirements.txt', () => {
    touch(dir, 'requirements.txt');
    const result = detectProfilesForWorktree(dir);
    expect(result.map((p) => p.id)).toContain('python');
  });

  it('returns all matching profiles sorted by priority (highest first)', () => {
    touch(dir, 'package.json');
    touch(dir, 'go.mod');
    touch(dir, 'pom.xml');
    const result = detectProfilesForWorktree(dir);
    const ids = result.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['nodejs', 'go', 'java8']));
    // Check ordering: priorities should be monotonically non-increasing
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i - 1].detect.priority).toBeGreaterThanOrEqual(
        result[i].detect.priority,
      );
    }
  });

  it('deduplicates when multiple marker files of the same profile exist', () => {
    touch(dir, 'pom.xml');
    touch(dir, 'build.gradle');
    const result = detectProfilesForWorktree(dir);
    const java8Count = result.filter((p) => p.id === 'java8').length;
    expect(java8Count).toBe(1);
  });

  it('ignores missing directory gracefully', () => {
    const nonexistent = path.join(dir, 'does-not-exist');
    expect(detectProfilesForWorktree(nonexistent)).toEqual([]);
  });

  it('accepts a custom profile list override', () => {
    touch(dir, 'package.json');
    const nodejsOnly = [findProfileById('nodejs')!];
    expect(detectProfilesForWorktree(dir, nodejsOnly).length).toBe(1);
  });

  it('does not descend into subdirectories (only worktree root)', () => {
    touch(dir, 'subdir/go.mod');
    expect(detectProfilesForWorktree(dir)).toEqual([]);
  });

  it('first result is the highest-priority profile when multiple match', () => {
    touch(dir, 'package.json'); // nodejs
    touch(dir, 'pyproject.toml'); // python
    const result = detectProfilesForWorktree(dir);
    expect(result.length).toBeGreaterThan(0);
    const nodeP = BUILTIN_PROFILES.find((p) => p.id === 'nodejs')!.detect
      .priority;
    const pyP = BUILTIN_PROFILES.find((p) => p.id === 'python')!.detect
      .priority;
    const expectedTop = nodeP >= pyP ? 'nodejs' : 'python';
    expect(result[0].id).toBe(expectedTop);
  });
});
