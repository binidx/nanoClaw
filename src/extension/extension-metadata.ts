import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { t } from '../i18n/index.js';

export type ExtensionHealthState = 'ready' | 'warning' | 'blocked';
export type ExtensionRequirementSeverity = 'warning' | 'blocked';

export interface ExtensionRequirementIssue {
  severity: ExtensionRequirementSeverity;
  code: string;
  message: string;
}

export interface ExtensionHealthStatus {
  state: ExtensionHealthState;
  summary: string;
  checkedAt: string;
  issues: ExtensionRequirementIssue[];
}

export interface ExtensionCommandRequirement {
  command: string;
  optional?: boolean;
  installHint?: string;
}

export interface ExtensionEnvRequirement {
  key: string;
  optional?: boolean;
  secret?: boolean;
  description?: string;
}

export interface ExtensionFileRequirement {
  path: string;
  kind?: 'file' | 'directory';
  optional?: boolean;
}

export interface ExtensionNetworkRequirement {
  baseUrl?: string;
  envKey?: string;
  optional?: boolean;
  description?: string;
}

export interface ExtensionRequirements {
  commands?: ExtensionCommandRequirement[];
  env?: ExtensionEnvRequirement[];
  files?: ExtensionFileRequirement[];
  network?: ExtensionNetworkRequirement[];
}

export interface ExtensionArtifactMetadata {
  kinds?: string[];
  producesImages?: boolean;
  producesFiles?: boolean;
}

export interface ExtensionGeneratorMetadata {
  kind?: 'manual' | 'imported' | 'ai-generated';
  templateId?: string;
  sourceDocs?: string[];
}

export interface ExtensionUiMetadata {
  displayName?: string;
  category?: string;
}

export interface ExtensionMetadata {
  capabilities: string[];
  runtime?: {
    kind?: string;
    entryFile?: string;
  };
  requirements?: ExtensionRequirements;
  artifacts?: ExtensionArtifactMetadata;
  generator?: ExtensionGeneratorMetadata;
  ui?: ExtensionUiMetadata;
  notes?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeCommandRequirements(
  value: unknown,
): ExtensionCommandRequirement[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({
      command: typeof entry.command === 'string' ? entry.command.trim() : '',
      ...(entry.optional !== undefined
        ? { optional: Boolean(entry.optional) }
        : {}),
      ...(typeof entry.installHint === 'string' && entry.installHint.trim()
        ? { installHint: entry.installHint.trim() }
        : {}),
    }))
    .filter((entry) => entry.command);
}

function normalizeEnvRequirements(value: unknown): ExtensionEnvRequirement[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({
      key: typeof entry.key === 'string' ? entry.key.trim() : '',
      ...(entry.optional !== undefined
        ? { optional: Boolean(entry.optional) }
        : {}),
      ...(entry.secret !== undefined ? { secret: Boolean(entry.secret) } : {}),
      ...(typeof entry.description === 'string' && entry.description.trim()
        ? { description: entry.description.trim() }
        : {}),
    }))
    .filter((entry) => entry.key);
}

function normalizeFileRequirements(value: unknown): ExtensionFileRequirement[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({
      path: typeof entry.path === 'string' ? entry.path.trim() : '',
      ...(entry.kind === 'directory' ? { kind: 'directory' as const } : {}),
      ...(entry.optional !== undefined
        ? { optional: Boolean(entry.optional) }
        : {}),
    }))
    .filter((entry) => entry.path);
}

function normalizeNetworkRequirements(
  value: unknown,
): ExtensionNetworkRequirement[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({
      ...(typeof entry.baseUrl === 'string' && entry.baseUrl.trim()
        ? { baseUrl: entry.baseUrl.trim() }
        : {}),
      ...(typeof entry.envKey === 'string' && entry.envKey.trim()
        ? { envKey: entry.envKey.trim() }
        : {}),
      ...(entry.optional !== undefined
        ? { optional: Boolean(entry.optional) }
        : {}),
      ...(typeof entry.description === 'string' && entry.description.trim()
        ? { description: entry.description.trim() }
        : {}),
    }))
    .filter((entry) => entry.baseUrl || entry.envKey);
}

export function normalizeExtensionMetadata(
  value: unknown,
): ExtensionMetadata {
  if (!isRecord(value)) {
    return {
      capabilities: [],
    };
  }

  const requirements = isRecord(value.requirements)
    ? {
        commands: normalizeCommandRequirements(value.requirements.commands),
        env: normalizeEnvRequirements(value.requirements.env),
        files: normalizeFileRequirements(value.requirements.files),
        network: normalizeNetworkRequirements(value.requirements.network),
      }
    : undefined;

  return {
    capabilities: normalizeStringArray(value.capabilities),
    ...(isRecord(value.runtime)
      ? {
          runtime: {
            ...(typeof value.runtime.kind === 'string' &&
            value.runtime.kind.trim()
              ? { kind: value.runtime.kind.trim() }
              : {}),
            ...(typeof value.runtime.entryFile === 'string' &&
            value.runtime.entryFile.trim()
              ? { entryFile: value.runtime.entryFile.trim() }
              : {}),
          },
        }
      : {}),
    ...(requirements ? { requirements } : {}),
    ...(isRecord(value.artifacts)
      ? {
          artifacts: {
            kinds: normalizeStringArray(value.artifacts.kinds),
            ...(value.artifacts.producesImages !== undefined
              ? { producesImages: Boolean(value.artifacts.producesImages) }
              : {}),
            ...(value.artifacts.producesFiles !== undefined
              ? { producesFiles: Boolean(value.artifacts.producesFiles) }
              : {}),
          },
        }
      : {}),
    ...(isRecord(value.generator)
      ? {
          generator: {
            ...(typeof value.generator.kind === 'string' &&
            value.generator.kind.trim()
              ? {
                  kind: value.generator.kind.trim() as ExtensionGeneratorMetadata['kind'],
                }
              : {}),
            ...(typeof value.generator.templateId === 'string' &&
            value.generator.templateId.trim()
              ? { templateId: value.generator.templateId.trim() }
              : {}),
            ...(Array.isArray(value.generator.sourceDocs)
              ? {
                  sourceDocs: normalizeStringArray(value.generator.sourceDocs),
                }
              : {}),
          },
        }
      : {}),
    ...(isRecord(value.ui)
      ? {
          ui: {
            ...(typeof value.ui.displayName === 'string' &&
            value.ui.displayName.trim()
              ? { displayName: value.ui.displayName.trim() }
              : {}),
            ...(typeof value.ui.category === 'string' &&
            value.ui.category.trim()
              ? { category: value.ui.category.trim() }
              : {}),
          },
        }
      : {}),
    ...(typeof value.notes === 'string' && value.notes.trim()
      ? { notes: value.notes.trim() }
      : {}),
  };
}

export function serializeExtensionMetadata(
  metadata: ExtensionMetadata | undefined,
): string | null {
  if (!metadata) return null;
  const normalized = normalizeExtensionMetadata(metadata);
  const hasContent =
    normalized.capabilities.length > 0 ||
    normalized.runtime ||
    normalized.requirements ||
    normalized.artifacts ||
    normalized.generator ||
    normalized.ui ||
    normalized.notes;
  return hasContent ? JSON.stringify(normalized) : null;
}

export function parseExtensionMetadata(
  raw: string | null | undefined,
): ExtensionMetadata {
  if (!raw?.trim()) return normalizeExtensionMetadata(null);
  try {
    return normalizeExtensionMetadata(JSON.parse(raw));
  } catch {
    return normalizeExtensionMetadata(null);
  }
}

function commandExists(command: string): boolean {
  try {
    const lookup =
      process.platform === 'win32'
        ? `where ${JSON.stringify(command)}`
        : `command -v ${JSON.stringify(command)}`;
    execSync(lookup, {
      stdio: 'ignore',
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
    });
    return true;
  } catch {
    return false;
  }
}

export function evaluateExtensionHealth(input: {
  metadata?: ExtensionMetadata;
  env?: Record<string, string>;
  baseDir?: string | null;
  command?: string | null;
}): ExtensionHealthStatus {
  const metadata = normalizeExtensionMetadata(input.metadata);
  const env = input.env || {};
  const issues: ExtensionRequirementIssue[] = [];
  const checkedAt = new Date().toISOString();
  const requirements = metadata.requirements;

  if (input.command && !commandExists(input.command)) {
    issues.push({
      severity: 'blocked',
      code: 'missing_command',
      message: t('extension.missingExecutable', { command: input.command }, undefined),
    });
  }

  for (const item of requirements?.commands || []) {
    if (!commandExists(item.command)) {
      issues.push({
        severity: item.optional ? 'warning' : 'blocked',
        code: 'missing_requirement_command',
        message: item.installHint
          ? t(
            'extension.missingRequirementCommandWithHint',
            { command: item.command, hint: item.installHint },
            undefined,
          )
          : t(
            'extension.missingRequirementCommand',
            { command: item.command },
            undefined,
          ),
      });
    }
  }

  for (const item of requirements?.env || []) {
    if (!env[item.key]?.trim()) {
      issues.push({
        severity: item.optional ? 'warning' : 'blocked',
        code: 'missing_env',
        message: item.description
          ? t(
            'extension.missingEnvWithDescription',
            { key: item.key, description: item.description },
            undefined,
          )
          : t('extension.missingEnv', { key: item.key }, undefined),
      });
    }
  }

  const baseDir = input.baseDir ? path.resolve(input.baseDir) : null;
  for (const item of requirements?.files || []) {
    if (!baseDir) {
      issues.push({
        severity: item.optional ? 'warning' : 'blocked',
        code: 'missing_base_dir',
        message: t('extension.missingBaseDir', { path: item.path }, undefined),
      });
      continue;
    }
    const resolved = path.resolve(baseDir, item.path);
    const exists = fs.existsSync(resolved);
    if (!exists) {
      issues.push({
        severity: item.optional ? 'warning' : 'blocked',
        code: 'missing_file',
        message: t('extension.missingPath', { path: item.path }, undefined),
      });
      continue;
    }
    if (item.kind === 'directory' && !fs.statSync(resolved).isDirectory()) {
      issues.push({
        severity: item.optional ? 'warning' : 'blocked',
        code: 'wrong_path_kind',
        message: t('extension.directoryRequired', { path: item.path }, undefined),
      });
    }
  }

  for (const item of requirements?.network || []) {
    if (item.envKey && !env[item.envKey]?.trim()) {
      issues.push({
        severity: item.optional ? 'warning' : 'blocked',
        code: 'missing_network_base',
        message: t('extension.missingNetworkEnv', { key: item.envKey }, undefined),
      });
    }
  }

  const blocked = issues.filter((item) => item.severity === 'blocked');
  const state: ExtensionHealthState =
    blocked.length > 0
      ? 'blocked'
      : issues.length > 0
        ? 'warning'
        : 'ready';
  const summary =
    state === 'ready'
      ? t('extension.envSatisfied', {}, undefined)
      : state === 'warning'
        ? t('extension.warningSummary', { count: issues.length }, undefined)
        : t('extension.blockedSummary', { count: blocked.length }, undefined);

  return {
    state,
    summary,
    checkedAt,
    issues,
  };
}
