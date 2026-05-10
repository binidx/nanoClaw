import fs from 'fs';
import os from 'os';
import path from 'path';

import { getConfiguredChannelInstances } from '../config-store.js';
import {
  DATA_DIR,
  GROUPS_DIR,
  MOUNT_ALLOWLIST_PATH,
  SENDER_ALLOWLIST_PATH,
  STORE_DIR,
} from '../config.js';
import { getDefaultProvider, initDatabase } from '../db.js';
import { t } from '../i18n/index.js';

export type OnboardingStepStatus = 'ready' | 'needs_action' | 'recommended';

export interface OnboardingStep {
  id: string;
  title: string;
  status: OnboardingStepStatus;
  summary: string;
  detail?: string;
  action?: string;
}

export interface OnboardingReport {
  generatedAt: string;
  ready: boolean;
  progress: Record<OnboardingStepStatus, number> & { total: number };
  steps: OnboardingStep[];
  suggestedCommands: string[];
}

export interface OnboardResult {
  report: OnboardingReport;
  applied: string[];
}

export interface OnboardOptions {
  apply?: boolean;
}

function hasDirectoryEntries(dirPath: string): boolean {
  try {
    return fs.readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

function buildMountAllowlistTemplate(projectRoot: string): string {
  return `${JSON.stringify(
    {
      allowedRoots: [projectRoot],
      blockedPatterns: ['**/.git/**', '**/node_modules/**', '**/.env*'],
      nonMainReadOnly: true,
    },
    null,
    2,
  )}\n`;
}

function buildSenderAllowlistTemplate(): string {
  return `${JSON.stringify(
    {
      default: {
        allow: '*',
        mode: 'trigger',
      },
      chats: {},
      logDenied: true,
    },
    null,
    2,
  )}\n`;
}

function ensureFileIfMissing(
  filePath: string,
  content: string,
  applied: string[],
): void {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  applied.push(`created:${path.relative(process.cwd(), filePath) || filePath}`);
}

function ensureDirectory(dirPath: string, applied: string[]): void {
  if (fs.existsSync(dirPath)) return;
  fs.mkdirSync(dirPath, { recursive: true });
  applied.push(`mkdir:${path.relative(process.cwd(), dirPath) || dirPath}`);
}

function buildSuggestedCommands(steps: OnboardingStep[]): string[] {
  const commands = new Set<string>();
  if (steps.some((step) => step.id === 'provider' && step.status !== 'ready')) {
    commands.add('npm run doctor -- --probe-providers');
  }
  if (
    steps.some((step) =>
      ['web-deps', 'runner-deps', 'frontend-build', 'backend-build'].includes(
        step.id,
      ),
    )
  ) {
    commands.add('npm run build:all');
  }
  if (steps.some((step) => step.id === 'channels' && step.status !== 'ready')) {
    commands.add('npm run start');
  }
  commands.add('npm run doctor');
  return Array.from(commands);
}

async function safeGetConfiguredChannelInstances() {
  try {
    return await getConfiguredChannelInstances();
  } catch {
    return [];
  }
}

async function safeGetDefaultProvider() {
  try {
    return await getDefaultProvider();
  } catch {
    return undefined;
  }
}

export async function generateOnboardingReport(): Promise<OnboardingReport> {
  const projectRoot = process.cwd();
  const backendNodeModules = path.join(projectRoot, 'node_modules');
  const webNodeModules = path.join(projectRoot, 'web', 'node_modules');
  const runnerNodeModules = path.join(
    projectRoot,
    'agent',
    'runner',
    'node_modules',
  );
  const backendDistEntry = path.join(projectRoot, 'dist', 'index.js');
  const frontendDistEntry = path.join(projectRoot, 'web', 'dist', 'index.html');
  const runnerDistDir = path.join(projectRoot, 'agent', 'runner', 'dist');
  const dbEngine = process.env.DB_ENGINE || 'sqlite';
  const dbPath = path.join(STORE_DIR, 'messages.db');

  const defaultProvider = await safeGetDefaultProvider();
  const channels = (await safeGetConfiguredChannelInstances()).filter(
    (instance) => instance.enabled,
  );

  const steps: OnboardingStep[] = [];

  steps.push(
    fs.existsSync(backendNodeModules)
      ? {
          id: 'backend-deps',
          title: t('onboard.auto_158612', {}, undefined),
          status: 'ready',
          summary: t('onboard.auto_500938', {}, undefined),
        }
      : {
          id: 'backend-deps',
          title: t('onboard.auto_158612', {}, undefined),
          status: 'needs_action',
          summary: t('onboard.auto_f08fb0', {}, undefined),
          action: t('onboard.auto_510cb7', {}, undefined),
        },
  );

  steps.push(
    fs.existsSync(webNodeModules)
      ? {
          id: 'web-deps',
          title: t('onboard.auto_2a4d38', {}, undefined),
          status: 'ready',
          summary: t('onboard.auto_111c45', {}, undefined),
        }
      : {
          id: 'web-deps',
          title: t('onboard.auto_2a4d38', {}, undefined),
          status: 'needs_action',
          summary: t('onboard.auto_3fbb82', {}, undefined),
          action: t('onboard.auto_5b352c', {}, undefined),
        },
  );

  steps.push(
    fs.existsSync(runnerNodeModules)
      ? {
          id: 'runner-deps',
          title: t('onboard.auto_63d99d', {}, undefined),
          status: 'ready',
          summary: t('onboard.auto_82edd7', {}, undefined),
        }
      : {
          id: 'runner-deps',
          title: t('onboard.auto_63d99d', {}, undefined),
          status: 'needs_action',
          summary: t('onboard.auto_0caed9', {}, undefined),
          action: t('onboard.auto_8d34a6', {}, undefined),
        },
  );

  steps.push(
    fs.existsSync(backendDistEntry)
      ? {
          id: 'backend-build',
          title: t('onboard.auto_3960d9', {}, undefined),
          status: 'ready',
          summary: t('onboard.auto_25d33c', {}, undefined),
        }
      : {
          id: 'backend-build',
          title: t('onboard.auto_3960d9', {}, undefined),
          status: 'recommended',
          summary: t('onboard.auto_b5adbd', {}, undefined),
          action: t('onboard.auto_b31784', {}, undefined),
        },
  );

  steps.push(
    fs.existsSync(frontendDistEntry)
      ? {
          id: 'frontend-build',
          title: t('onboard.auto_971147', {}, undefined),
          status: 'ready',
          summary: t('onboard.auto_1ae8e9', {}, undefined),
        }
      : {
          id: 'frontend-build',
          title: t('onboard.auto_971147', {}, undefined),
          status: 'recommended',
          summary: t('onboard.auto_fd3498', {}, undefined),
          action: t('onboard.auto_71df3a', {}, undefined),
        },
  );

  steps.push(
    hasDirectoryEntries(runnerDistDir)
      ? {
          id: 'runner-build',
          title: t('onboard.auto_f31883', {}, undefined),
          status: 'ready',
          summary: t('onboard.auto_a7c23e', {}, undefined),
        }
      : {
          id: 'runner-build',
          title: t('onboard.auto_f31883', {}, undefined),
          status: 'recommended',
          summary: t('onboard.auto_f5d7d6', {}, undefined),
          action: t('onboard.auto_98244a', {}, undefined),
        },
  );

  if (dbEngine === 'sqlite') {
    steps.push(
      fs.existsSync(dbPath)
        ? {
            id: 'database',
            title: t('onboard.auto_a081c5', {}, undefined),
            status: 'ready',
            summary: t('onboard.auto_39792c', {}, undefined),
          }
        : {
            id: 'database',
            title: t('onboard.auto_a081c5', {}, undefined),
            status: 'recommended',
            summary: t('onboard.auto_29401d', {}, undefined),
            action: t('onboard.auto_1aded8', {}, undefined),
          },
    );
  } else {
    steps.push({
      id: 'database',
      title: t('onboard.auto_306511', {}, undefined),
      status: 'ready',
      summary: t('onboard.dbEngineSummary', { engine: dbEngine }, undefined),
    });
  }

  steps.push(
    defaultProvider
      ? {
          id: 'provider',
          title: t('onboard.auto_4f3c25', {}, undefined),
          status: 'ready',
          summary: t('onboard.defaultProviderSummary', { alias: defaultProvider.alias }, undefined),
        }
      : {
          id: 'provider',
          title: t('onboard.auto_4f3c25', {}, undefined),
          status: 'needs_action',
          summary: t('onboard.auto_23bd51', {}, undefined),
          action: t('onboard.auto_2a14c4', {}, undefined),
        },
  );

  steps.push(
    channels.length > 0
      ? {
          id: 'channels',
          title: t('onboard.auto_07bd3b', {}, undefined),
          status: 'ready',
          summary: t('onboard.channelsEnabledSummary', { count: channels.length }, undefined),
        }
      : {
          id: 'channels',
          title: t('onboard.auto_07bd3b', {}, undefined),
          status: 'recommended',
          summary: t('onboard.auto_111b91', {}, undefined),
          action:
            t('onboard.auto_05d8e7', {}, undefined),
        },
  );

  steps.push(
    fs.existsSync(MOUNT_ALLOWLIST_PATH)
      ? {
          id: 'mount-allowlist',
          title: t('onboard.auto_d969a3', {}, undefined),
          status: 'ready',
          summary: t('onboard.mountAllowlistDetected', { path: MOUNT_ALLOWLIST_PATH }, undefined),
        }
      : {
          id: 'mount-allowlist',
          title: t('onboard.auto_d969a3', {}, undefined),
          status: 'recommended',
          summary: t('onboard.auto_1cdadf', {}, undefined),
          action: t('onboard.auto_f0ea84', {}, undefined),
        },
  );

  steps.push(
    fs.existsSync(SENDER_ALLOWLIST_PATH)
      ? {
          id: 'sender-allowlist',
          title: t('onboard.auto_354969', {}, undefined),
          status: 'ready',
          summary: t('onboard.senderAllowlistDetected', { path: SENDER_ALLOWLIST_PATH }, undefined),
        }
      : {
          id: 'sender-allowlist',
          title: t('onboard.auto_354969', {}, undefined),
          status: 'recommended',
          summary: t('onboard.auto_c9b851', {}, undefined),
          action: t('onboard.auto_0f3004', {}, undefined),
        },
  );

  const progress = {
    ready: steps.filter((step) => step.status === 'ready').length,
    needs_action: steps.filter((step) => step.status === 'needs_action').length,
    recommended: steps.filter((step) => step.status === 'recommended').length,
    total: steps.length,
  };

  return {
    generatedAt: new Date().toISOString(),
    ready: progress.needs_action === 0,
    progress,
    steps,
    suggestedCommands: buildSuggestedCommands(steps),
  };
}

export async function runOnboarding(options: OnboardOptions = {}): Promise<OnboardResult> {
  const apply = options.apply !== false;
  const applied: string[] = [];
  const projectRoot = process.cwd();

  if (apply) {
    for (const dirPath of [
      DATA_DIR,
      GROUPS_DIR,
      STORE_DIR,
      path.join(projectRoot, 'logs'),
      path.join(projectRoot, 'tmp'),
    ]) {
      ensureDirectory(dirPath, applied);
    }

    ensureFileIfMissing(
      MOUNT_ALLOWLIST_PATH,
      buildMountAllowlistTemplate(projectRoot),
      applied,
    );
    ensureFileIfMissing(
      SENDER_ALLOWLIST_PATH,
      buildSenderAllowlistTemplate(),
      applied,
    );

    const onboardDbEngine = process.env.DB_ENGINE || 'sqlite';
    await initDatabase();
    applied.push(
      onboardDbEngine === 'sqlite'
        ? 'initialized:store/messages.db'
        : `initialized:${onboardDbEngine}`,
    );
  }

  return {
    report: await generateOnboardingReport(),
    applied,
  };
}

export function formatOnboardingReport(report: OnboardingReport): string {
  const lines = [
    `NanoClaw onboarding status (${report.ready ? 'ready' : 'needs action'})`,
    `Ready ${report.progress.ready}/${report.progress.total} | Needs action ${report.progress.needs_action} | Recommended ${report.progress.recommended}`,
    '',
  ];

  for (const step of report.steps) {
    const marker =
      step.status === 'ready'
        ? 'OK'
        : step.status === 'needs_action'
          ? 'FIX'
          : 'TIP';
    lines.push(`[${marker}] ${step.title}: ${step.summary}`);
    if (step.detail) lines.push(`  ${step.detail}`);
    if (step.action) lines.push(`  Next: ${step.action}`);
  }

  if (report.suggestedCommands.length > 0) {
    lines.push('');
    lines.push('Suggested commands:');
    for (const command of report.suggestedCommands) {
      lines.push(`  - ${command}`);
    }
  }

  lines.push('');
  lines.push(
    `Config templates live under ${path.join(os.homedir(), '.config', 'nanoclaw')}`,
  );
  return lines.join('\n');
}
