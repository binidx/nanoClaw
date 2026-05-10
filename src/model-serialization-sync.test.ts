import path from 'path';
import { pathToFileURL } from 'url';

import { describe, expect, it, vi } from 'vitest';

import { serializeForModel as serializeBackend } from './provider/model-serialization.js';

async function loadRunnerSerializer() {
  const moduleUrl = pathToFileURL(
    path.resolve(
      process.cwd(),
      'agent',
      'runner',
      'src',
      'model-serialization.ts',
    ),
  ).href;
  const module = (await import(moduleUrl)) as {
    serializeForModel: typeof serializeBackend;
  };
  return module.serializeForModel;
}

describe('model serialization behavior sync', () => {
  it('keeps backend and runner serializer behavior aligned', async () => {
    vi.stubEnv('NANOCLAW_MODEL_SERIALIZATION_MODE', 'toon');

    const serializeRunner = await loadRunnerSerializer();
    const fixtures: unknown[] = [
      [
        { title: 'Spec', score: 95 },
        { title: 'Plan', status: 'warn' },
      ],
      { market: 'us', confidence: 'medium', notes: ['a', 'b'] },
      [
        { title: 'Spec', meta: { owner: 'A' } },
        { title: 'Plan', meta: { owner: 'B' } },
      ],
    ];

    for (const fixture of fixtures) {
      expect(serializeRunner(fixture, { surface: 'mcp_result' })).toEqual(
        serializeBackend(fixture, { surface: 'mcp_result' }),
      );
    }

    vi.unstubAllEnvs();
  });
});
