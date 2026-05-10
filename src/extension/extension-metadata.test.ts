import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  evaluateExtensionHealth,
  normalizeExtensionMetadata,
} from './extension-metadata.js';

describe('extension metadata', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ext-meta-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('normalizes metadata into a stable shape', () => {
    expect(
      normalizeExtensionMetadata({
        capabilities: [' image.generate ', ''],
        requirements: {
          env: [{ key: 'API_KEY', secret: true }],
        },
      }),
    ).toEqual({
      capabilities: ['image.generate'],
      requirements: {
        commands: [],
        env: [{ key: 'API_KEY', secret: true }],
        files: [],
        network: [],
      },
    });
  });

  it('evaluates missing env and file requirements as blocked issues', () => {
    const health = evaluateExtensionHealth({
      metadata: {
        capabilities: ['image.generate'],
        requirements: {
          env: [{ key: 'API_KEY' }],
          files: [{ path: 'index.mjs' }],
        },
      },
      env: {},
      baseDir: tempDir,
      command: 'node',
    });

    expect(health.state).toBe('blocked');
    expect(health.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing_env' }),
        expect.objectContaining({ code: 'missing_file' }),
      ]),
    );
  });
});
