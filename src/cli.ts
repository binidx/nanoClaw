#!/usr/bin/env node

import path from 'path';
import { t } from './i18n/index.js';

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getFlagValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index === -1) return '';
  return String(args[index + 1] || '').trim();
}

function stripFlagWithValue(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  if (index === -1) return args;
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

function printHelp(): void {
  console.log(`NanoClaw CLI

Usage:
  nanoclaw review install-hooks --repository-id <id>
  nanoclaw review uninstall-hooks --repository-id <id>
  nanoclaw review-trigger --repository-id <id> --stage <commit|push> [--json]
  nanoclaw onboard [--check] [--json]
  nanoclaw doctor [--probe-providers] [--json]

Notes:
  - review-trigger exits non-zero when a blocking review fails
  - onboard will initialize safe local state: data dirs, SQLite DB, .env template, trust templates
  - doctor can optionally probe provider connectivity with --probe-providers`);
}

async function handleReviewCommand(
  command: string,
  args: string[],
): Promise<void> {
  const repositoryId = getFlagValue(args, '--repository-id');
  if (!repositoryId) {
    console.error('--repository-id is required');
    process.exitCode = 1;
    return;
  }
  const { initDatabase } = await import('./db.js');
  initDatabase();

  if (command === 'install-hooks') {
    const { installRepoReviewHooks } = await import('./repo-review/repo-review-service.js');
    const result = await installRepoReviewHooks({
      repositoryId,
      nanoclawRoot: process.cwd(),
    });
    console.log(
      `Installed review hooks for ${result.repository.name} at ${result.hooksPath}`,
    );
    return;
  }

  if (command === 'uninstall-hooks') {
    const { uninstallRepoReviewHooks } =
      await import('./repo-review/repo-review-service.js');
    const result = await uninstallRepoReviewHooks({ repositoryId });
    console.log(
      `Removed review hooks for ${result.repository.name} from ${result.hooksPath}`,
    );
    return;
  }

  console.error(`Unknown review command: ${command}`);
  process.exitCode = 1;
}

async function handleReviewTrigger(args: string[]): Promise<void> {
  const repositoryId = getFlagValue(args, '--repository-id');
  const stage = getFlagValue(args, '--stage') === 'commit' ? 'commit' : 'push';
  const json = hasFlag(args, '--json');
  if (!repositoryId) {
    console.error('--repository-id is required');
    process.exitCode = 1;
    return;
  }
  const { initDatabase } = await import('./db.js');
  initDatabase();

  const { triggerLocalRepoReview } = await import('./repo-review/repo-review-service.js');
  if (!json) {
    console.log(
      t('errors.cliReviewStart', { stage: stage === 'commit' ? t('errors.cliStagePreCommit', {}, undefined) : t('errors.cliStagePrePush', {}, undefined), repositoryId }, undefined),
    );
  }
  const result = await triggerLocalRepoReview({
    repositoryId,
    stage,
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(result.message);
    for (const entry of result.runs) {
      console.log(
        `- ${entry.profile?.name || 'Unmatched profile'}: ${entry.run.overall || entry.run.status}${entry.blocked ? ' (blocked)' : ''}`,
      );
    }
  }

  if (result.blocked) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const nanoclawRoot = getFlagValue(rawArgs, '--nanoclaw-root');
  const args = stripFlagWithValue(rawArgs, '--nanoclaw-root');
  if (nanoclawRoot) {
    process.chdir(path.resolve(nanoclawRoot));
  }

  const [command, ...restArgs] = args;
  const json = hasFlag(restArgs, '--json');

  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    printHelp();
    return;
  }

  process.env.NANOCLAW_LOG_STDOUT = 'false';

  if (command === 'onboard') {
    const { formatOnboardingReport, runOnboarding } =
      await import('./web/onboard.js');
    const result = await runOnboarding({ apply: !hasFlag(restArgs, '--check') });
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ applied: result.applied, report: result.report }, null, 2)}\n`,
      );
    } else {
      if (result.applied.length > 0) {
        console.log('Applied:');
        for (const item of result.applied) {
          console.log(`  - ${item}`);
        }
        console.log('');
      }
      console.log(formatOnboardingReport(result.report));
    }
    if (!result.report.ready) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'doctor') {
    const { formatDoctorReport, generateDoctorReport } =
      await import('./web/doctor.js');
    const report = await generateDoctorReport({
      probeProviders: hasFlag(restArgs, '--probe-providers'),
      checkPortAvailability: true,
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      console.log(formatDoctorReport(report));
    }
    if (!report.healthy) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'review') {
    const [subcommand, ...reviewArgs] = restArgs;
    await handleReviewCommand(subcommand || '', reviewArgs);
    return;
  }

  if (command === 'review-trigger') {
    await handleReviewTrigger(restArgs);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

void main();
