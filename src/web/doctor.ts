import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import {
  getChannelTypeDefinitions,
  getConfiguredChannelInstances,
  getEffectiveWebConfig,
} from '../config-store.js';
import { parseAllowedDirectoriesValue } from '../security/allowed-directories.js';
import {
  MOUNT_ALLOWLIST_PATH,
  SENDER_ALLOWLIST_PATH,
  STORE_DIR,
} from '../config.js';
import { getAllProviders, getDefaultProvider } from '../db.js';
import type { ConfigRisk } from '../config-channel-definitions.js';
import { testAiProviderConnection } from '../provider/provider-api.js';
import {
  getProviderTypeDef,
  isValidProviderType,
} from '../provider/provider-registry.js';
import { loadSenderAllowlist } from '../security/sender-allowlist.js';
import { t } from '../i18n/index.js';

export type DoctorSeverity = 'info' | 'warn' | 'error';
export type DoctorArea =
  | 'auth'
  | 'terminal'
  | 'network'
  | 'providers'
  | 'channels'
  | 'workspace';

export interface DoctorCheck {
  id: string;
  area: DoctorArea;
  severity: DoctorSeverity;
  summary: string;
  detail?: string;
  suggestedFix?: string;
}

export interface DoctorReport {
  generatedAt: string;
  healthy: boolean;
  counts: Record<DoctorSeverity, number>;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  probeProviders?: boolean;
  checkPortAvailability?: boolean;
}

function buildCheck(input: DoctorCheck): DoctorCheck {
  return input;
}

function isRootLikeDirectory(dir: string): boolean {
  if (dir === path.parse(dir).root) {
    return true;
  }
  return dir === os.homedir();
}

function summarizeMissingRisk(risk?: ConfigRisk): string {
  if (risk === 'sensitive') return t('doctor.auto_f315b5', {}, undefined);
  if (risk === 'dangerous') return t('doctor.auto_ffef97', {}, undefined);
  return t('doctor.auto_ba1ad8', {}, undefined);
}

async function canBindPort(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function safeGetChannelTypeDefinitions() {
  try {
    return getChannelTypeDefinitions();
  } catch {
    return [];
  }
}

async function safeGetConfiguredChannelInstances() {
  try {
    return await getConfiguredChannelInstances();
  } catch {
    return [];
  }
}

async function safeGetAllProviders() {
  try {
    return await getAllProviders();
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

async function safeGetEffectiveWebConfig(): Promise<Record<string, string>> {
  try {
    return await getEffectiveWebConfig();
  } catch {
    return {};
  }
}

export async function generateDoctorReport(
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const config = await safeGetEffectiveWebConfig();
  const channelDefinitions = new Map(
    safeGetChannelTypeDefinitions().map((definition) => [
      definition.type,
      definition,
    ]),
  );
  const providers = await safeGetAllProviders();
  const channelInstances = await safeGetConfiguredChannelInstances();
  const checks: DoctorCheck[] = [];

  if (config.WEB_LOGIN_ENABLED !== 'true') {
    checks.push(
      buildCheck({
        id: 'web-login-disabled',
        area: 'auth',
        severity: 'warn',
        summary: t('doctor.auto_d24b1b', {}, undefined),
        detail: t('doctor.auto_10a7ca', {}, undefined),
        suggestedFix:
          t('doctor.auto_e5ce9c', {}, undefined),
      }),
    );
  }

  const loginUsername = String(config.WEB_LOGIN_USERNAME || '').trim();
  const loginPassword = String(config.WEB_LOGIN_PASSWORD || '').trim();
  if (
    config.WEB_LOGIN_ENABLED === 'true' &&
    (!loginPassword ||
      (loginUsername === 'admin' &&
        ['admin', 'admin123', 'changeme', 'password'].includes(
          loginPassword.toLowerCase(),
        )))
  ) {
    checks.push(
      buildCheck({
        id: 'web-login-weak-credentials',
        area: 'auth',
        severity: 'error',
        summary: t('doctor.auto_2718ec', {}, undefined),
        detail: t('doctor.auto_8b41c3', {}, undefined),
        suggestedFix:
          t('doctor.auto_1e1e0f', {}, undefined),
      }),
    );
  }

  if (config.WEB_TERMINAL_ENABLED === 'true') {
    checks.push(
      buildCheck({
        id: 'web-terminal-enabled',
        area: 'terminal',
        severity: 'warn',
        summary: t('doctor.auto_d7524a', {}, undefined),
        detail: t('doctor.auto_8d5d83', {}, undefined),
        suggestedFix:
          t('doctor.auto_e3f849', {}, undefined),
      }),
    );
  }

  if (
    config.WEB_TERMINAL_ENABLED === 'true' &&
    config.WEB_LOGIN_ENABLED !== 'true'
  ) {
    checks.push(
      buildCheck({
        id: 'web-terminal-without-login',
        area: 'terminal',
        severity: 'error',
        summary: t('doctor.auto_e5f83f', {}, undefined),
        detail: t('doctor.auto_b6a2c0', {}, undefined),
        suggestedFix:
          t('doctor.auto_1caf6e', {}, undefined),
      }),
    );
  }

  if (config.ALLOW_INSECURE_TLS === 'true') {
    checks.push(
      buildCheck({
        id: 'insecure-tls-enabled',
        area: 'network',
        severity: 'warn',
        summary: t('doctor.auto_246760', {}, undefined),
        detail: t('doctor.auto_3da49b', {}, undefined),
        suggestedFix: t('doctor.auto_7f5835', {}, undefined),
      }),
    );
  }

  const dbEngine = process.env.DB_ENGINE || 'sqlite';
  if (dbEngine === 'sqlite') {
    const dbPath = path.join(STORE_DIR, 'messages.db');
    if (!fs.existsSync(dbPath)) {
      checks.push(
        buildCheck({
          id: 'sqlite-db-missing',
          area: 'workspace',
          severity: 'warn',
          summary: t('doctor.auto_f15949', {}, undefined),
          detail: t('doctor.dbNotDetected', { path: dbPath }, undefined),
          suggestedFix: t('doctor.auto_6a8c30', {}, undefined),
        }),
      );
    }
  } else {
    checks.push(
      buildCheck({
        id: 'external-db-engine',
        area: 'workspace',
        severity: 'info',
        summary: t('doctor.externalDbEngine', { engine: dbEngine }, undefined),
        detail: t('doctor.externalDbDetail', { engine: dbEngine }, undefined),
      }),
    );
  }

  if (!fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
    checks.push(
      buildCheck({
        id: 'mount-allowlist-missing',
        area: 'workspace',
        severity: 'warn',
        summary: t('doctor.auto_fbe945', {}, undefined),
        detail: t('doctor.dbNotDetected', { path: MOUNT_ALLOWLIST_PATH }, undefined),
        suggestedFix: t('doctor.auto_2139c0', {}, undefined),
      }),
    );
  }

  if (!fs.existsSync(SENDER_ALLOWLIST_PATH)) {
    checks.push(
      buildCheck({
        id: 'sender-allowlist-missing',
        area: 'channels',
        severity: 'warn',
        summary: t('doctor.auto_c28e33', {}, undefined),
        detail: t('doctor.dbNotDetected', { path: SENDER_ALLOWLIST_PATH }, undefined),
        suggestedFix:
          t('doctor.auto_a4b91d', {}, undefined),
      }),
    );
  } else {
    const senderAllowlist = loadSenderAllowlist();
    if (senderAllowlist.default.allow === '*') {
      checks.push(
        buildCheck({
          id: 'sender-allowlist-open-default',
          area: 'channels',
          severity: 'warn',
          summary: t('doctor.auto_52d0de', {}, undefined),
          detail:
            t('doctor.auto_157781', {}, undefined),
          suggestedFix:
            t('doctor.auto_28b0e9', {}, undefined),
        }),
      );
    }
  }

  const allowedDirectoriesRaw = config.allowed_directories;
  if (allowedDirectoriesRaw) {
    try {
      const allowedDirectories = parseAllowedDirectoriesValue(
        allowedDirectoriesRaw,
      );
      const riskyRoots = allowedDirectories.filter((entry) =>
        isRootLikeDirectory(entry),
      );
      if (riskyRoots.length > 0) {
        checks.push(
          buildCheck({
            id: 'allowed-directories-too-broad',
            area: 'workspace',
            severity: 'warn',
            summary: t('doctor.auto_1a913f', {}, undefined),
            detail: t('doctor.riskyRoots', { roots: riskyRoots.join('、') }, undefined),
            suggestedFix:
              t('doctor.auto_442d62', {}, undefined),
          }),
        );
      }
    } catch (err) {
      checks.push(
        buildCheck({
          id: 'allowed-directories-invalid',
          area: 'workspace',
          severity: 'error',
          summary: t('doctor.auto_faed9e', {}, undefined),
          detail: err instanceof Error ? err.message : t('doctor.auto_5fea4a', {}, undefined),
          suggestedFix: t('doctor.auto_fafac5', {}, undefined),
        }),
      );
    }
  }

  if (providers.length === 0) {
    checks.push(
      buildCheck({
        id: 'providers-missing',
        area: 'providers',
        severity: 'error',
        summary: t('doctor.auto_c19bdc', {}, undefined),
        suggestedFix: t('doctor.auto_fdc0e7', {}, undefined),
      }),
    );
  } else if (!(await safeGetDefaultProvider())) {
    checks.push(
      buildCheck({
        id: 'default-provider-missing',
        area: 'providers',
        severity: 'warn',
        summary: t('doctor.auto_db4547', {}, undefined),
        detail:
          t('doctor.auto_cc8b5a', {}, undefined),
        suggestedFix: t('doctor.auto_09412c', {}, undefined),
      }),
    );
  }

  for (const provider of providers) {
    if (!provider.api_key) {
      checks.push(
        buildCheck({
          id: `provider-api-key-missing:${provider.id}`,
          area: 'providers',
          severity: 'error',
          summary: t('doctor.providerMissingApiKey', { alias: provider.alias }, undefined),
          suggestedFix: t('doctor.providerMissingApiKeyFix', { alias: provider.alias }, undefined),
        }),
      );
    }
    if (!isValidProviderType(provider.type)) {
      checks.push(
        buildCheck({
          id: `provider-type-unknown:${provider.id}`,
          area: 'providers',
          severity: 'error',
          summary: t('doctor.providerUnsupportedType', { alias: provider.alias, type: provider.type }, undefined),
          suggestedFix: t('doctor.providerUnsupportedTypeFix', { alias: provider.alias }, undefined),
        }),
      );
    } else {
      const typeDef = getProviderTypeDef(provider.type);
      if (typeDef?.requiresBaseUrl && !provider.base_url) {
        checks.push(
          buildCheck({
            id: `provider-base-url-missing:${provider.id}`,
            area: 'providers',
            severity: 'error',
            summary: t('doctor.providerMissingBaseUrl', { label: typeDef.label, alias: provider.alias }, undefined),
            suggestedFix: t('doctor.providerMissingBaseUrlFix', { alias: provider.alias }, undefined),
          }),
        );
      }
    }
  }

  for (const instance of channelInstances) {
    if (!instance.enabled) continue;
    const definition = channelDefinitions.get(instance.type);
    if (!definition) {
      checks.push(
        buildCheck({
          id: `channel-definition-missing:${instance.id}`,
          area: 'channels',
          severity: 'warn',
          summary: t('doctor.channelInstanceUnknownType', { name: instance.name, type: instance.type }, undefined),
          suggestedFix: t('doctor.auto_903634', {}, undefined),
        }),
      );
      continue;
    }

    const missingRequired = definition.fields
      .filter((field) => field.required)
      .filter((field) => {
        const value = instance.config[field.key];
        if (typeof value === 'boolean') return false;
        return String(value || '').trim().length === 0;
      });

    for (const field of missingRequired) {
      checks.push(
        buildCheck({
          id: `channel-required:${instance.id}:${field.key}`,
          area: 'channels',
          severity: 'error',
          summary: t('doctor.channelInstanceMissingField', { name: instance.name, field: field.label }, undefined),
          detail: summarizeMissingRisk(field.risk),
          suggestedFix: t('doctor.channelInstanceMissingFieldFix', { definition: definition.label, name: instance.name, field: field.label }, undefined),
        }),
      );
    }
  }

  const enabledChannels = channelInstances.filter((instance) => instance.enabled);
  if (enabledChannels.length === 0) {
    checks.push(
      buildCheck({
        id: 'channels-none-enabled',
        area: 'channels',
        severity: 'info',
        summary: t('doctor.auto_430a53', {}, undefined),
        detail:
          t('doctor.auto_500d54', {}, undefined),
      }),
    );
  }

  if (options.checkPortAvailability) {
    const port = Number.parseInt(String(config.WEB_PORT || '3377'), 10);
    if (Number.isFinite(port) && port > 0) {
      const bindable = await canBindPort(port);
      if (!bindable) {
        checks.push(
          buildCheck({
            id: `web-port-in-use:${port}`,
            area: 'network',
            severity: 'warn',
            summary: t('doctor.webPortOccupied', { port }, undefined),
            detail: t('doctor.auto_7de8ee', {}, undefined),
            suggestedFix:
              t('doctor.auto_32829b', {}, undefined),
          }),
        );
      }
    }
  }

  if (options.probeProviders) {
    for (const provider of providers) {
      if (!provider.api_key) continue;
      try {
        const result = await testAiProviderConnection(provider, 5000);
        checks.push(
          buildCheck({
            id: `provider-probe:${provider.id}`,
            area: 'providers',
            severity: result.ok ? 'info' : 'error',
            summary: result.ok
              ? t('doctor.providerConnectivityOk', { alias: provider.alias }, undefined)
              : t('doctor.providerConnectivityFailed', { alias: provider.alias }, undefined),
            detail: result.ok
              ? `${result.message}${result.latencyMs !== undefined ? ` (${result.latencyMs}ms)` : ''}`
              : result.message,
            suggestedFix: result.ok
              ? undefined
              : t('doctor.providerConnectivityCheck', { alias: provider.alias }, undefined),
          }),
        );
      } catch (err) {
        checks.push(
          buildCheck({
            id: `provider-probe:${provider.id}`,
            area: 'providers',
            severity: 'error',
            summary: t('doctor.providerConnectivityFailed', { alias: provider.alias }, undefined),
            detail: err instanceof Error ? err.message : t('doctor.auto_f91780', {}, undefined),
            suggestedFix: t('doctor.providerConnectivityFix', { alias: provider.alias }, undefined),
          }),
        );
      }
    }
  }

  if (checks.length === 0) {
    checks.push(
      buildCheck({
        id: 'baseline-ok',
        area: 'auth',
        severity: 'info',
        summary: t('doctor.auto_aaf4ad', {}, undefined),
        detail:
          t('doctor.auto_37b929', {}, undefined),
      }),
    );
  }

  const counts: Record<DoctorSeverity, number> = {
    info: 0,
    warn: 0,
    error: 0,
  };
  for (const check of checks) {
    counts[check.severity] += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    healthy: counts.error === 0,
    counts,
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `NanoClaw doctor (${report.healthy ? 'healthy' : 'issues found'})`,
    `Errors ${report.counts.error} | Warnings ${report.counts.warn} | Info ${report.counts.info}`,
    '',
  ];

  for (const check of report.checks) {
    lines.push(
      `[${check.severity.toUpperCase()}] ${check.area}: ${check.summary}`,
    );
    if (check.detail) lines.push(`  ${check.detail}`);
    if (check.suggestedFix) lines.push(`  Fix: ${check.suggestedFix}`);
  }

  return lines.join('\n');
}
