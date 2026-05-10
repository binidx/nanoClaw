import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { logger } from '../logger.js';
import type { ManagedMcpServerConfig } from '../runtime/runtime-customization.js';
import {
  CUSTOM_SKILLS_ROOT,
  normalizeManagedMcpServers,
  normalizeSkillId,
} from '../runtime/runtime-customization.js';
import type { BundleScanResult } from './extension-marketplace-types.js';
import { resolveArchiveKind, stripArchiveExtension } from './extension-marketplace-types.js';
import { normalizeInstallId, normalizeMarketplaceSourceId } from './extension-marketplace-config.js';
import { t } from '../i18n/index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function ensureInsideRoot(rootDir: string, candidatePath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`path escapes bundle root: ${candidatePath}`);
  }
  return resolvedCandidate;
}

function normalizeBundleManifestPathList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

export function splitPathSegments(input: string): string[] {
  return input
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function deriveSuggestedNameFromPath(input: string): string | undefined {
  const segments = splitPathSegments(input);
  if (segments.length === 0) return undefined;

  const last = segments[segments.length - 1] ?? '';
  const lastLower = last.toLowerCase();
  if (resolveArchiveKind(last)) {
    const stripped = stripArchiveExtension(last);
    return stripped || undefined;
  }
  if (lastLower === 'skill.md' || lastLower === '.mcp.json') {
    return segments[segments.length - 2] || undefined;
  }
  if (
    lastLower === 'plugin.json' &&
    (segments[segments.length - 2] ?? '').toLowerCase() === '.claude-plugin'
  ) {
    return segments[segments.length - 3] || undefined;
  }
  if (
    lastLower === 'marketplace.json' &&
    (segments[segments.length - 2] ?? '').toLowerCase() === '.claude-plugin'
  ) {
    return segments[segments.length - 3] || undefined;
  }
  if (lastLower === 'plugin.json' || lastLower === 'marketplace.json') {
    return segments[segments.length - 2] || undefined;
  }
  return path.parse(last).name || last || undefined;
}

export function loadBundleScan(rootDir: string): BundleScanResult {
  const manifestPath = path.join(rootDir, '.claude-plugin', 'plugin.json');
  let manifest: Record<string, unknown> = {};
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
      if (isRecord(raw)) manifest = raw;
    } catch (err) {
      logger.warn(
        { err, manifestPath },
        'Failed to read extension bundle manifest',
      );
    }
  }

  const skillRoots = [
    path.join(rootDir, 'skills'),
    ...normalizeBundleManifestPathList(manifest.skills).map((entry) =>
      ensureInsideRoot(rootDir, path.join(rootDir, entry)),
    ),
  ];
  const commandRoots = [
    path.join(rootDir, 'commands'),
    ...normalizeBundleManifestPathList(manifest.commands).map((entry) =>
      ensureInsideRoot(rootDir, path.join(rootDir, entry)),
    ),
  ];
  const agentRoots = [
    path.join(rootDir, 'agents'),
    ...normalizeBundleManifestPathList(manifest.agents).map((entry) =>
      ensureInsideRoot(rootDir, path.join(rootDir, entry)),
    ),
  ];
  const mcpCandidates = [
    path.join(rootDir, '.mcp.json'),
    ...normalizeBundleManifestPathList(manifest.mcpServers).map((entry) =>
      ensureInsideRoot(rootDir, path.join(rootDir, entry)),
    ),
  ];

  const seenSkillSource = new Set<string>();
  const skills: Array<{ sourceDir: string; suggestedId: string }> = [];
  if (fs.existsSync(path.join(rootDir, 'SKILL.md'))) {
    seenSkillSource.add(rootDir);
    skills.push({
      sourceDir: rootDir,
      suggestedId: normalizeSkillId(path.basename(rootDir)) || 'skill',
    });
  }
  for (const skillRoot of skillRoots) {
    if (!fs.existsSync(skillRoot) || !fs.statSync(skillRoot).isDirectory())
      continue;
    for (const entry of fs.readdirSync(skillRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourceDir = path.join(skillRoot, entry.name);
      if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) continue;
      if (seenSkillSource.has(sourceDir)) continue;
      seenSkillSource.add(sourceDir);
      skills.push({
        sourceDir,
        suggestedId:
          normalizeSkillId(entry.name) ||
          normalizeSkillId(path.basename(sourceDir)),
      });
    }
  }

  const seenCommandSource = new Set<string>();
  const commandSkills: Array<{ sourceFile: string; suggestedId: string }> = [];
  for (const commandRoot of commandRoots) {
    if (!fs.existsSync(commandRoot) || !fs.statSync(commandRoot).isDirectory())
      continue;
    for (const entry of fs.readdirSync(commandRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      const sourceFile = path.join(commandRoot, entry.name);
      if (seenCommandSource.has(sourceFile)) continue;
      seenCommandSource.add(sourceFile);
      commandSkills.push({
        sourceFile,
        suggestedId:
          normalizeSkillId(path.parse(entry.name).name) ||
          normalizeSkillId(entry.name),
      });
    }
  }

  const mcpFiles = mcpCandidates.filter((entry, index, list) => {
    const resolved = path.resolve(entry);
    return (
      list.findIndex((candidate) => path.resolve(candidate) === resolved) ===
        index &&
      fs.existsSync(entry) &&
      fs.statSync(entry).isFile()
    );
  });

  const agentDirs = agentRoots.filter((entry, index, list) => {
    const resolved = path.resolve(entry);
    return (
      list.findIndex((candidate) => path.resolve(candidate) === resolved) ===
        index &&
      fs.existsSync(entry) &&
      fs.statSync(entry).isDirectory()
    );
  });

  return {
    skills,
    commandSkills,
    mcpFiles,
    agentDirs,
    manifestPath: fs.existsSync(manifestPath) ? manifestPath : undefined,
  };
}

export function readBundleCanonicalId(bundleRoot: string, fallbackId: string): string {
  const manifestPath = path.join(bundleRoot, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
      if (isRecord(parsed)) {
        const manifestId = normalizeSkillId(String(parsed.id || ''));
        if (manifestId) {
          return manifestId;
        }
      }
    } catch (err) {
      logger.warn({ err, manifestPath }, 'Failed to parse bundle canonical id');
    }
  }
  return normalizeSkillId(fallbackId) || normalizeInstallId(fallbackId);
}

export function computeBundleContentHash(rootDir: string): string {
  const hash = createHash('sha256');

  const visit = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path
        .relative(rootDir, fullPath)
        .split(path.sep)
        .join('/');
      if (entry.isDirectory()) {
        hash.update(`dir:${relativePath}\n`);
        visit(fullPath);
        continue;
      }
      if (entry.isFile()) {
        hash.update(`file:${relativePath}\n`);
        hash.update(fs.readFileSync(fullPath));
      }
    }
  };

  visit(rootDir);
  return hash.digest('hex');
}

export function chooseAvailableSkillId(baseId: string, installId: string): string {
  const candidates = [
    baseId,
    normalizeSkillId(`${installId}-${baseId}`),
    normalizeSkillId(`${installId}_${baseId}`),
  ].filter(Boolean) as string[];
  for (let index = 0; index < 20; index += 1) {
    const fallback =
      index === 0
        ? normalizeSkillId(`${installId}-skill`)
        : normalizeSkillId(`${installId}-skill-${index + 1}`);
    if (fallback) candidates.push(fallback);
  }
  for (const candidate of candidates) {
    const targetDir = path.join(CUSTOM_SKILLS_ROOT, candidate);
    if (!fs.existsSync(targetDir)) return candidate;
  }
  throw new Error(`Unable to allocate skill id for ${baseId}`);
}

export function chooseAvailableMcpId(
  baseId: string,
  installId: string,
  existing: ManagedMcpServerConfig[],
): string {
  const occupied = new Set(existing.map((entry) => entry.id));
  const candidates = [
    normalizeMarketplaceSourceId(baseId),
    normalizeMarketplaceSourceId(`${installId}-${baseId}`),
    normalizeMarketplaceSourceId(`${installId}_${baseId}`),
  ];
  for (let index = 0; index < 20; index += 1) {
    candidates.push(
      normalizeMarketplaceSourceId(
        index === 0 ? `${installId}-mcp` : `${installId}-mcp-${index + 1}`,
      ),
    );
  }
  for (const candidate of candidates) {
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate MCP id for ${baseId}`);
}

export function parseManagedMcpBundleFile(filePath: string): ManagedMcpServerConfig[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`MCP JSON is invalid: ${filePath}`);
  }
  if (isRecord(parsed) && isRecord(parsed.mcpServers)) {
    parsed = parsed.mcpServers;
  } else if (isRecord(parsed) && Array.isArray(parsed.servers)) {
    parsed = parsed.servers;
  }
  return normalizeManagedMcpServers(parsed);
}

export function absolutizeBundleMcpServer(
  server: ManagedMcpServerConfig,
  bundleRoot: string,
): ManagedMcpServerConfig {
  const rewriteIfLocalPath = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed || path.isAbsolute(trimmed)) return value;
    if (!/^\.{1,2}[\\/]/.test(trimmed) && !/[\\/]/.test(trimmed)) {
      return value;
    }
    const candidate = path.resolve(bundleRoot, trimmed);
    return fs.existsSync(candidate) ? candidate : value;
  };

  return {
    ...server,
    command: rewriteIfLocalPath(server.command),
    args: server.args.map((arg) => rewriteIfLocalPath(arg)),
  };
}

export function resolveBundleRootFromPath(input: string): string {
  const absolute = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
  if (!fs.existsSync(absolute)) {
    throw new Error(t('extension.pathNotFound', { path: absolute }, undefined));
  }
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) return absolute;

  const baseName = path.basename(absolute).toLowerCase();
  if (
    baseName === 'plugin.json' &&
    path.basename(path.dirname(absolute)) === '.claude-plugin'
  ) {
    return path.dirname(path.dirname(absolute));
  }
  if (baseName === '.mcp.json' || baseName === 'skill.md') {
    return path.dirname(absolute);
  }

  throw new Error(
    t('extension.unsupportedImportPath', {}, undefined),
  );
}
