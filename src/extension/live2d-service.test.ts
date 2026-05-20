import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { DATA_DIR } from '../config.js';
import { decodeZipEntryName, getModelFilePath } from './live2d-service.js';

const live2dCacheRoot = path.join(DATA_DIR, 'live2d', 'cache');

afterEach(() => {
  fs.rmSync(path.join(live2dCacheRoot, 'model-a'), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(live2dCacheRoot, 'model-ab'), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(live2dCacheRoot, 'outside-secret.model3.json'), {
    force: true,
  });
});

describe('decodeZipEntryName', () => {
  it('decodes UTF-8 zip entry names unchanged', () => {
    const raw = Buffer.from(
      'naxida_live2d/sounds/没去过的地方还有很多呢.mp3',
      'utf8',
    );

    expect(decodeZipEntryName(raw)).toBe(
      'naxida_live2d/sounds/没去过的地方还有很多呢.mp3',
    );
  });

  it('falls back to GBK for non-UTF8 zip entry names', () => {
    const raw = Buffer.from([
      0x73, 0x6f, 0x75, 0x6e, 0x64, 0x73, 0x2f, 0xc4, 0xe3, 0xba, 0xc3, 0x2e,
      0x6d, 0x70, 0x33,
    ]);

    expect(decodeZipEntryName(raw)).toBe('sounds/你好.mp3');
  });

  it('rejects paths that escape into sibling model cache directories', () => {
    const modelDir = path.join(live2dCacheRoot, 'model-a');
    const siblingDir = path.join(live2dCacheRoot, 'model-ab');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, 'secret.model3.json'), '{}');

    expect(
      getModelFilePath('model-a', '../model-ab/secret.model3.json'),
    ).toBeNull();
  });

  it('rejects absolute paths to existing files outside the model cache', () => {
    const modelDir = path.join(live2dCacheRoot, 'model-a');
    const outsideFile = path.join(
      live2dCacheRoot,
      'outside-secret.model3.json',
    );
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(outsideFile, '{}');

    expect(getModelFilePath('model-a', outsideFile)).toBeNull();
  });

  it('rejects traversal after a nested safe-looking segment', () => {
    const modelDir = path.join(live2dCacheRoot, 'model-a');
    const siblingDir = path.join(live2dCacheRoot, 'model-ab');
    fs.mkdirSync(path.join(modelDir, 'assets'), { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, 'secret.model3.json'), '{}');

    expect(
      getModelFilePath('model-a', 'assets/../../model-ab/secret.model3.json'),
    ).toBeNull();
  });
});
