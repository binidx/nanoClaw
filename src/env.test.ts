import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetEnvFileCacheForTests,
  hydrateProcessEnvFromEnvFile,
  readEnvFile,
} from './env.js';

describe('env file cache', () => {
  const originalCwd = process.cwd();
  let tempDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
    process.chdir(tempDir);
    _resetEnvFileCacheForTests();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    _resetEnvFileCacheForTests();
    delete process.env.DB_ENGINE;
    delete process.env.DB_PG_HOST;
    delete process.env.DB_PG_PORT;
  });

  it('reloads values when the .env file changes', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'FOO=one\n', 'utf8');
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'one' });

    fs.writeFileSync(path.join(tempDir, '.env'), 'FOO=two-updated\n', 'utf8');
    expect(readEnvFile(['FOO'])).toEqual({ FOO: 'two-updated' });
  });

  it('recovers after an initially missing .env file appears later', () => {
    expect(readEnvFile(['BAR'])).toEqual({});

    fs.writeFileSync(path.join(tempDir, '.env'), 'BAR=available\n', 'utf8');
    expect(readEnvFile(['BAR'])).toEqual({ BAR: 'available' });
  });

  it('hydrates missing database keys from .env into process.env', () => {
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'DB_ENGINE=postgres\nDB_PG_HOST=db.example\nDB_PG_PORT=55432\n',
      'utf8',
    );

    hydrateProcessEnvFromEnvFile(['DB_ENGINE', 'DB_PG_HOST', 'DB_PG_PORT']);

    expect(process.env.DB_ENGINE).toBe('postgres');
    expect(process.env.DB_PG_HOST).toBe('db.example');
    expect(process.env.DB_PG_PORT).toBe('55432');
  });

  it('does not override existing process.env values when hydrating from .env', () => {
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'DB_ENGINE=postgres\nDB_PG_HOST=db.example\n',
      'utf8',
    );
    process.env.DB_ENGINE = 'sqlite';

    hydrateProcessEnvFromEnvFile(['DB_ENGINE', 'DB_PG_HOST']);

    expect(process.env.DB_ENGINE).toBe('sqlite');
    expect(process.env.DB_PG_HOST).toBe('db.example');
  });
});
