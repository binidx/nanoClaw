import { defineConfig } from 'vitest/config';
import { cleanRunnerSourceArtifacts } from './agent/runner/scripts/clean-source-artifacts.mjs';

cleanRunnerSourceArtifacts({ rootDir: process.cwd() });

export default defineConfig({
  test: {
    include: [
      'agent/runner/src/**/*.test.ts',
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'skills-engine/**/*.test.ts',
      'web/src/**/*.test.ts',
    ],
  },
});
