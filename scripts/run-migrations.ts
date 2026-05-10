#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { compareSemver } from '../skills-engine/state.js';

export interface MigrationResult {
  version: string;
  success: boolean;
  error?: string;
}

export interface RunMigrationsResult {
  migrationsRun: number;
  results: MigrationResult[];
}

export async function runMigrations(
  fromVersion: string,
  toVersion: string,
  newCorePath: string,
): Promise<RunMigrationsResult> {
  const results: MigrationResult[] = [];
  const migrationsDir = path.join(newCorePath, 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    return { migrationsRun: 0, results: [] };
  }

  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  const migrationVersions = entries
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .filter(
      (version) =>
        compareSemver(version, fromVersion) > 0 &&
        compareSemver(version, toVersion) <= 0,
    )
    .sort(compareSemver);

  const projectRoot = process.cwd();

  for (const version of migrationVersions) {
    const migrationIndex = path.join(migrationsDir, version, 'index.ts');
    if (!fs.existsSync(migrationIndex)) {
      results.push({
        version,
        success: false,
        error: `Migration ${version}/index.ts not found`,
      });
      continue;
    }

    const originalArgv = process.argv.slice();
    try {
      process.argv = [originalArgv[0] || 'node', migrationIndex, projectRoot];
      const migrationUrl = pathToFileURL(migrationIndex).href;
      await import(`${migrationUrl}?nanoclaw_migration=${encodeURIComponent(version)}_${Date.now()}`);
      results.push({ version, success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ version, success: false, error: message });
    } finally {
      process.argv = originalArgv;
    }
  }

  return {
    migrationsRun: results.length,
    results,
  };
}

async function main(): Promise<void> {
  const fromVersion = process.argv[2];
  const toVersion = process.argv[3];
  const newCorePath = process.argv[4];

  if (!fromVersion || !toVersion || !newCorePath) {
    console.error(
      'Usage: tsx scripts/run-migrations.ts <from-version> <to-version> <new-core-path>',
    );
    process.exit(1);
  }

  const result = await runMigrations(fromVersion, toVersion, newCorePath);
  console.log(JSON.stringify(result, null, 2));
  if (result.results.some((entry) => !entry.success)) {
    process.exit(1);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';

if (import.meta.url === invokedPath) {
  await main();
}
