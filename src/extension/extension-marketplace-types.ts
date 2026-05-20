import path from 'path';
import os from 'os';

import { DATA_DIR } from '../config.js';

export const MANAGED_EXTENSIONS_ROOT = path.join(DATA_DIR, 'extensions');
export const WEB_EXTENSION_MARKETPLACES_CONFIG_KEY =
  'WEB_EXTENSION_MARKETPLACES';
export const WEB_EXTENSION_INSTALLS_CONFIG_KEY = 'WEB_EXTENSION_INSTALLS';
export const CLAUDE_KNOWN_MARKETPLACES_PATH = path.join(
  os.homedir(),
  '.claude',
  'plugins',
  'known_marketplaces.json',
);
export const MARKETPLACE_MANIFEST_CANDIDATES = [
  path.join('.claude-plugin', 'marketplace.json'),
  'marketplace.json',
] as const;
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 5_000;
export const MAX_ARCHIVE_EXTRACTED_BYTES = 128 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_REMOTE_FETCH_BYTES = MAX_ARCHIVE_BYTES;
export const TAR_ARCHIVE_SUFFIXES = ['.tgz', '.tar.gz', '.tar'] as const;
export const BLOCKED_TAR_ENTRY_TYPES = new Set([
  'SymbolicLink',
  'Link',
  'BlockDevice',
  'CharacterDevice',
  'FIFO',
  'Socket',
]);

export type MarketplaceEntrySource =
  | { kind: 'path'; path: string }
  | { kind: 'github'; repo: string; ref?: string; path?: string }
  | { kind: 'git'; url: string; ref?: string; path?: string }
  | { kind: 'git-subdir'; url: string; ref?: string; path: string }
  | { kind: 'url'; url: string };

export type MarketplacePluginEntry = {
  name: string;
  version?: string;
  description?: string;
  source: MarketplaceEntrySource;
};

export type MarketplaceManifest = {
  name?: string;
  version?: string;
  plugins: MarketplacePluginEntry[];
};

export type LoadedMarketplace = {
  manifest: MarketplaceManifest;
  rootDir: string;
  sourceLabel: string;
  cleanup?: () => Promise<void>;
};

export type BundleScanResult = {
  skills: Array<{ sourceDir: string; suggestedId: string }>;
  commandSkills: Array<{ sourceFile: string; suggestedId: string }>;
  mcpFiles: string[];
  agentDirs: string[];
  manifestPath?: string;
};

export type KnownMarketplaceRecord = {
  installLocation?: string;
  source?: unknown;
};

export type ResolvedBundleSource =
  | {
      ok: true;
      bundleRoot: string;
      sourceRef: string;
      suggestedName?: string;
      cleanup?: () => Promise<void>;
    }
  | { ok: false; error: string };

export type NormalizedGitCloneSource = {
  url: string;
  ref?: string;
  label: string;
  path?: string;
};

export type ExistingInstallBackup = {
  tempDir: string;
  rawMcpConfig: string | undefined;
};

export interface ExtensionMarketplaceSource {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  origin?: 'admin_registry' | 'legacy_config' | 'bundled_legacy';
  readOnly?: boolean;
}

export interface ExtensionCatalogEntry {
  id: string;
  entryName: string;
  title: string;
  description?: string;
  version?: string;
  sourceId: string;
  sourceName: string;
  sourceLabel: string;
  marketplaceName?: string;
  marketplaceVersion?: string;
  skillCount: number;
  mcpCount: number;
  agentCount: number;
  installable: boolean;
}

export interface ExtensionInstallRecord {
  id: string;
  canonicalId: string;
  name: string;
  version?: string;
  sourceType: 'marketplace' | 'import';
  sourceKind: 'local_path' | 'github' | 'git' | 'git_subdir' | 'remote_file';
  sourceRef: string;
  resolvedSource: string;
  contentHash: string;
  trustState: 'trusted' | 'local' | 'needs_review';
  marketplaceName?: string;
  marketplaceSource?: string;
  marketplaceEntry?: string;
  installedSkillIds: string[];
  installedMcpServerIds: string[];
  agentCount: number;
  installedAt: string;
  status: 'installed' | 'needs_attention';
  warnings: string[];
}

export interface ExtensionInstallResult {
  installs: ExtensionInstallRecord[];
  installed: ExtensionInstallRecord;
}

export interface ExtensionUninstallResult {
  installs: ExtensionInstallRecord[];
  removed: ExtensionInstallRecord;
}

export interface ExtensionReconcileResult {
  installs: ExtensionInstallRecord[];
}

export function resolveArchiveKind(value: string): 'zip' | 'tar' | null {
  const normalized =
    value.trim().toLowerCase().split('?')[0]?.split('#')[0] || '';
  if (normalized.endsWith('.zip')) {
    return 'zip';
  }
  if (TAR_ARCHIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return 'tar';
  }
  return null;
}

export function stripArchiveExtension(value: string): string {
  const lower = value.toLowerCase();
  if (lower.endsWith('.tar.gz')) {
    return value.slice(0, -'.tar.gz'.length);
  }
  if (lower.endsWith('.tgz')) {
    return value.slice(0, -'.tgz'.length);
  }
  if (lower.endsWith('.tar')) {
    return value.slice(0, -'.tar'.length);
  }
  if (lower.endsWith('.zip')) {
    return value.slice(0, -'.zip'.length);
  }
  return value;
}
