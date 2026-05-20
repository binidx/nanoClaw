import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { deleteConfig, getConfig, setConfig } from '../db.js';
import { logger } from '../logger.js';
import { normalizeSkillId } from '../runtime/runtime-customization.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import {
  listAllMarketplaceSources,
  replaceAdminMarketplaceSources,
  type MarketplaceSourceInput,
} from './marketplace-source-service.js';
import type {
  ExtensionInstallRecord,
  ExtensionMarketplaceSource,
} from './extension-marketplace-types.js';
import {
  WEB_EXTENSION_INSTALLS_CONFIG_KEY,
  WEB_EXTENSION_MARKETPLACES_CONFIG_KEY,
} from './extension-marketplace-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeMarketplaceSourceId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!normalized) {
    throw new Error('Marketplace source id is invalid');
  }
  return normalized;
}

export function normalizeInstallId(input: string): string {
  return normalizeMarketplaceSourceId(input);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isGitUrl(value: string): boolean {
  return (
    /^git@/i.test(value) ||
    /^ssh:\/\//i.test(value) ||
    /^https?:\/\/.+\.git(?:#.*)?$/i.test(value)
  );
}

function looksLikeGitHubRepoShorthand(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.+)?$/.test(value.trim());
}

function looksLikeGitHubUrl(value: string): boolean {
  if (!isHttpUrl(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.hostname.toLowerCase() === 'github.com' ||
      parsed.hostname.toLowerCase() === 'raw.githubusercontent.com'
    );
  } catch {
    return false;
  }
}

export function deriveSourceKindFromRef(
  sourceRef: string,
  sourceType: 'marketplace' | 'import',
): ExtensionInstallRecord['sourceKind'] {
  const trimmed = sourceRef.trim();
  if (!trimmed) {
    return sourceType === 'marketplace' ? 'github' : 'local_path';
  }
  if (looksLikeGitHubRepoShorthand(trimmed) || looksLikeGitHubUrl(trimmed)) {
    return 'github';
  }
  if (isGitUrl(trimmed)) {
    return 'git';
  }
  if (isHttpUrl(trimmed)) {
    return 'remote_file';
  }
  return 'local_path';
}

export function deriveTrustState(input: {
  sourceType: 'marketplace' | 'import';
  sourceKind: ExtensionInstallRecord['sourceKind'];
}): ExtensionInstallRecord['trustState'] {
  if (input.sourceType === 'marketplace') {
    return 'trusted';
  }
  if (input.sourceKind === 'local_path') {
    return 'local';
  }
  return 'needs_review';
}

function parseExtensionMarketplaceSourcesConfig(
  raw: string | undefined,
): ExtensionMarketplaceSource[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Stored extension marketplaces config is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Extension marketplaces config must be an array');
  }
  const seen = new Set<string>();
  const output: ExtensionMarketplaceSource[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const id = normalizeMarketplaceSourceId(
      String(entry.id || entry.name || ''),
    );
    if (seen.has(id)) continue;
    seen.add(id);
    const source = toOptionalString(entry.source);
    if (!source) continue;
    output.push({
      id,
      name: toOptionalString(entry.name) || id,
      source,
      enabled: entry.enabled === undefined ? true : Boolean(entry.enabled),
      origin: 'legacy_config',
      readOnly: true,
    });
  }
  return output;
}

function serializeExtensionMarketplaceSourcesConfig(
  sources: ExtensionMarketplaceSource[],
): string {
  return JSON.stringify(
    sources
      .map((entry) => ({
        id: normalizeMarketplaceSourceId(entry.id),
        name: entry.name.trim() || entry.id.trim(),
        source: entry.source.trim(),
        enabled: entry.enabled !== false,
      }))
      .filter((entry) => entry.source)
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function getBundledMarketplaceRoot(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'marketplaces',
    'agent-reach',
  );
}

function getBundledMarketplaceSources(): ExtensionMarketplaceSource[] {
  const sourceRoot = getBundledMarketplaceRoot();
  const manifestPath = path.join(
    sourceRoot,
    '.claude-plugin',
    'marketplace.json',
  );
  if (!fs.existsSync(manifestPath)) {
    return [];
  }
  return [
    {
      id: 'agent-reach',
      name: 'Agent Reach',
      source: sourceRoot,
      enabled: true,
      origin: 'bundled_legacy',
      readOnly: true,
    },
  ];
}

function mergeMarketplaceSources(
  configured: ExtensionMarketplaceSource[],
): ExtensionMarketplaceSource[] {
  const merged = new Map<string, ExtensionMarketplaceSource>();
  for (const source of getBundledMarketplaceSources()) {
    merged.set(source.id, source);
  }
  for (const source of configured) {
    merged.set(source.id, source);
  }
  return Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));
}

async function getAdminMarketplaceSources(): Promise<
  ExtensionMarketplaceSource[]
> {
  const records = await listAllMarketplaceSources(false);
  return records.map((entry) => ({
    id: entry.id,
    name: entry.name,
    source: entry.source,
    enabled: entry.enabled,
    origin: 'admin_registry',
    readOnly: false,
  }));
}

function isSameMarketplaceSource(
  left: ExtensionMarketplaceSource,
  right: ExtensionMarketplaceSource,
): boolean {
  return (
    left.id === right.id &&
    left.source.trim() === right.source.trim() &&
    left.name.trim() === right.name.trim() &&
    (left.enabled !== false) === (right.enabled !== false)
  );
}

async function getLegacyReadOnlyMarketplaceSources(): Promise<
  ExtensionMarketplaceSource[]
> {
  try {
    return mergeMarketplaceSources(
      parseExtensionMarketplaceSourcesConfig(
        await getConfig(WEB_EXTENSION_MARKETPLACES_CONFIG_KEY),
      ),
    ).map((entry) => ({
      ...entry,
      readOnly: true,
      origin: entry.origin ?? 'legacy_config',
    }));
  } catch (err) {
    logger.warn(
      { err },
      'Failed to parse legacy extension marketplace sources',
    );
    return mergeMarketplaceSources([]);
  }
}

function parseExtensionInstallsConfig(
  raw: string | undefined,
): ExtensionInstallRecord[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Stored extension installs config is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Extension installs config must be an array');
  }
  return parsed
    .filter(isRecord)
    .map(
      (entry): ExtensionInstallRecord => ({
        id: normalizeInstallId(String(entry.id || '')),
        canonicalId:
          normalizeSkillId(String(entry.canonicalId || entry.id || '')) ||
          normalizeInstallId(String(entry.id || '')),
        name: toOptionalString(entry.name) || String(entry.id || ''),
        version: toOptionalString(entry.version),
        sourceType:
          entry.sourceType === 'marketplace' ? 'marketplace' : 'import',
        sourceKind:
          entry.sourceKind === 'github' ||
          entry.sourceKind === 'git' ||
          entry.sourceKind === 'git_subdir' ||
          entry.sourceKind === 'remote_file' ||
          entry.sourceKind === 'local_path'
            ? entry.sourceKind
            : deriveSourceKindFromRef(
                toOptionalString(entry.resolvedSource) ||
                  toOptionalString(entry.sourceRef) ||
                  '',
                entry.sourceType === 'marketplace' ? 'marketplace' : 'import',
              ),
        sourceRef: toOptionalString(entry.sourceRef) || '',
        resolvedSource:
          toOptionalString(entry.resolvedSource) ||
          toOptionalString(entry.sourceRef) ||
          '',
        contentHash: toOptionalString(entry.contentHash) || '',
        trustState:
          entry.trustState === 'trusted' ||
          entry.trustState === 'local' ||
          entry.trustState === 'needs_review'
            ? entry.trustState
            : deriveTrustState({
                sourceType:
                  entry.sourceType === 'marketplace' ? 'marketplace' : 'import',
                sourceKind:
                  entry.sourceKind === 'github' ||
                  entry.sourceKind === 'git' ||
                  entry.sourceKind === 'git_subdir' ||
                  entry.sourceKind === 'remote_file' ||
                  entry.sourceKind === 'local_path'
                    ? entry.sourceKind
                    : deriveSourceKindFromRef(
                        toOptionalString(entry.resolvedSource) ||
                          toOptionalString(entry.sourceRef) ||
                          '',
                        entry.sourceType === 'marketplace'
                          ? 'marketplace'
                          : 'import',
                      ),
              }),
        marketplaceName: toOptionalString(entry.marketplaceName),
        marketplaceSource: toOptionalString(entry.marketplaceSource),
        marketplaceEntry: toOptionalString(entry.marketplaceEntry),
        installedSkillIds: Array.isArray(entry.installedSkillIds)
          ? entry.installedSkillIds
              .map((item) => String(item || '').trim())
              .filter(Boolean)
          : [],
        installedMcpServerIds: Array.isArray(entry.installedMcpServerIds)
          ? entry.installedMcpServerIds
              .map((item) => String(item || '').trim())
              .filter(Boolean)
          : [],
        agentCount:
          typeof entry.agentCount === 'number' &&
          Number.isFinite(entry.agentCount)
            ? Math.max(0, Math.trunc(entry.agentCount))
            : 0,
        installedAt:
          toOptionalString(entry.installedAt) || new Date(0).toISOString(),
        status:
          entry.status === 'needs_attention' ? 'needs_attention' : 'installed',
        warnings: Array.isArray(entry.warnings)
          ? entry.warnings
              .map((item) => String(item || '').trim())
              .filter(Boolean)
          : [],
      }),
    )
    .filter(
      (entry) =>
        entry.id &&
        entry.canonicalId &&
        entry.name &&
        entry.sourceRef &&
        entry.resolvedSource,
    )
    .sort((a, b) => b.installedAt.localeCompare(a.installedAt));
}

function serializeExtensionInstallsConfig(
  installs: ExtensionInstallRecord[],
): string {
  return JSON.stringify(
    installs
      .map((entry) => ({
        id: normalizeInstallId(entry.id),
        canonicalId:
          normalizeSkillId(entry.canonicalId || entry.id) ||
          normalizeInstallId(entry.id),
        name: entry.name.trim() || entry.id.trim(),
        version: entry.version?.trim() || undefined,
        sourceType: entry.sourceType,
        sourceKind: entry.sourceKind,
        sourceRef: entry.sourceRef.trim(),
        resolvedSource: entry.resolvedSource.trim() || entry.sourceRef.trim(),
        contentHash: entry.contentHash.trim() || undefined,
        trustState: entry.trustState,
        marketplaceName: entry.marketplaceName?.trim() || undefined,
        marketplaceSource: entry.marketplaceSource?.trim() || undefined,
        marketplaceEntry: entry.marketplaceEntry?.trim() || undefined,
        installedSkillIds: Array.from(
          new Set(
            entry.installedSkillIds.map((id) => id.trim()).filter(Boolean),
          ),
        ).sort((a, b) => a.localeCompare(b)),
        installedMcpServerIds: Array.from(
          new Set(
            entry.installedMcpServerIds.map((id) => id.trim()).filter(Boolean),
          ),
        ).sort((a, b) => a.localeCompare(b)),
        agentCount: Math.max(0, Math.trunc(entry.agentCount || 0)),
        installedAt: entry.installedAt,
        status: entry.status,
        warnings: Array.from(
          new Set(entry.warnings.map((item) => item.trim()).filter(Boolean)),
        ),
      }))
      .filter(
        (entry) =>
          entry.id &&
          entry.canonicalId &&
          entry.name &&
          entry.sourceRef &&
          entry.resolvedSource,
      )
      .sort((a, b) => b.installedAt.localeCompare(a.installedAt)),
  );
}

export async function getExtensionMarketplaceSourcesForResponse(): Promise<
  ExtensionMarketplaceSource[]
> {
  try {
    const legacySources = await getLegacyReadOnlyMarketplaceSources();
    const adminSources = await getAdminMarketplaceSources();
    return mergeMarketplaceSources([...legacySources, ...adminSources]);
  } catch (err) {
    logger.warn({ err }, 'Failed to parse extension marketplace sources');
    return mergeMarketplaceSources([]);
  }
}

export async function persistExtensionMarketplaceSources(
  sources: ExtensionMarketplaceSource[],
): Promise<ExtensionMarketplaceSource[]> {
  const normalized = parseExtensionMarketplaceSourcesConfig(
    serializeExtensionMarketplaceSourcesConfig(sources),
  );
  const legacySources = await getLegacyReadOnlyMarketplaceSources();
  const existingAdminById = new Map(
    (await getAdminMarketplaceSources()).map((entry) => [entry.id, entry]),
  );
  const adminInputs: MarketplaceSourceInput[] = [];
  for (const source of normalized) {
    const legacy = legacySources.find((entry) => entry.id === source.id);
    const existingAdmin = existingAdminById.get(source.id);
    if (!existingAdmin && legacy) {
      if (!isSameMarketplaceSource(source, legacy)) {
        throw new Error(
          `Marketplace source is read-only legacy config: ${source.id}`,
        );
      }
      continue;
    }
    adminInputs.push({
      id: source.id,
      name: source.name,
      source: source.source,
      enabled: source.enabled,
    });
  }
  await replaceAdminMarketplaceSources(getCurrentUserId(), adminInputs);
  return getExtensionMarketplaceSourcesForResponse();
}

export async function getExtensionInstallsForResponse(): Promise<
  ExtensionInstallRecord[]
> {
  try {
    return parseExtensionInstallsConfig(
      await getConfig(WEB_EXTENSION_INSTALLS_CONFIG_KEY),
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to parse extension installs');
    return [];
  }
}

export async function persistExtensionInstalls(
  installs: ExtensionInstallRecord[],
): Promise<ExtensionInstallRecord[]> {
  const normalized = parseExtensionInstallsConfig(
    serializeExtensionInstallsConfig(installs),
  );
  if (normalized.length === 0) {
    await deleteConfig(WEB_EXTENSION_INSTALLS_CONFIG_KEY);
  } else {
    await setConfig(
      WEB_EXTENSION_INSTALLS_CONFIG_KEY,
      serializeExtensionInstallsConfig(normalized),
    );
  }
  return normalized;
}
