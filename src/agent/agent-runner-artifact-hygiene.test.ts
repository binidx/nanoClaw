import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

const createdRoots: string[] = [];
const cleanRunnerSourceArtifactsModulePath =
  '../../agent/runner/scripts/clean-source-artifacts.mjs';

async function importArtifactCleaner(): Promise<{
  cleanRunnerSourceArtifacts: (options: { rootDir: string }) => string[];
}> {
  return import(cleanRunnerSourceArtifactsModulePath);
}

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('agent runner source artifact hygiene', () => {
  it('removes generated runner source artifacts that have matching TypeScript sources', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-runner-artifacts-'),
    );
    createdRoots.push(root);

    const runnerSrc = path.join(root, 'agent', 'runner', 'src', 'web-tools');
    fs.mkdirSync(runnerSrc, { recursive: true });

    const tsSource = path.join(runnerSrc, 'shared.ts');
    const generatedJs = path.join(runnerSrc, 'shared.js');
    const generatedDts = path.join(runnerSrc, 'shared.d.ts');
    const manualJs = path.join(runnerSrc, 'manual.js');

    fs.writeFileSync(tsSource, 'export const shared = true;\n', 'utf8');
    fs.writeFileSync(generatedJs, 'export const shared = true;\n', 'utf8');
    fs.writeFileSync(generatedDts, 'export declare const shared: true;\n', 'utf8');
    fs.writeFileSync(manualJs, 'export const manual = true;\n', 'utf8');

    const { cleanRunnerSourceArtifacts } = await importArtifactCleaner();
    const removed = cleanRunnerSourceArtifacts({ rootDir: root });

    expect(removed).toEqual(
      expect.arrayContaining([generatedJs, generatedDts]),
    );
    expect(fs.existsSync(generatedJs)).toBe(false);
    expect(fs.existsSync(generatedDts)).toBe(false);
    expect(fs.existsSync(tsSource)).toBe(true);
    expect(fs.existsSync(manualJs)).toBe(true);
  });
});
