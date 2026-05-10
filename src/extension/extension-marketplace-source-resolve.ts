import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import type {
  ExtensionCatalogEntry,
  KnownMarketplaceRecord,
  LoadedMarketplace,
  MarketplaceEntrySource,
  MarketplaceManifest,
  MarketplacePluginEntry,
  NormalizedGitCloneSource,
  ResolvedBundleSource,
} from './extension-marketplace-types.js';
import {
  CLAUDE_KNOWN_MARKETPLACES_PATH,
  DEFAULT_GIT_TIMEOUT_MS,
  MARKETPLACE_MANIFEST_CANDIDATES,
  MAX_REMOTE_FETCH_BYTES,
  resolveArchiveKind,
  stripArchiveExtension,
} from './extension-marketplace-types.js';
import { extractArchiveToBundleRoot } from './extension-marketplace-archive.js';
import {
  deriveSuggestedNameFromPath,
  ensureInsideRoot,
  loadBundleScan,
  parseManagedMcpBundleFile,
  resolveBundleRootFromPath,
} from './extension-marketplace-bundle.js';
import { t } from '../i18n/index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
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

export function splitRef(value: string): { base: string; ref?: string } {
  const trimmed = value.trim();
  const hashIndex = trimmed.lastIndexOf('#');
  if (hashIndex <= 0 || hashIndex >= trimmed.length - 1) {
    return { base: trimmed };
  }
  return {
    base: trimmed.slice(0, hashIndex),
    ref: trimmed.slice(hashIndex + 1).trim() || undefined,
  };
}

function normalizeGitHubHttpCloneSource(
  source: string,
): NormalizedGitCloneSource | null {
  const split = splitRef(source);
  try {
    const url = new URL(split.base);
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'raw.githubusercontent.com') {
      const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      if (parts.length < 4) return null;
      const repo = `${parts[0]}/${parts[1]?.replace(/\.git$/i, '')}`;
      return {
        url: `https://github.com/${repo}.git`,
        ref: split.ref || parts[2],
        label: repo,
        path: parts.slice(3).join('/'),
      };
    }

    if (hostname !== 'github.com') return null;
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const repo = `${parts[0]}/${parts[1]?.replace(/\.git$/i, '')}`;
    const action = parts[2]?.toLowerCase();
    if ((action === 'tree' || action === 'blob') && parts.length >= 5) {
      return {
        url: `https://github.com/${repo}.git`,
        ref: split.ref || parts[3],
        label: repo,
        path: parts.slice(4).join('/'),
      };
    }

    return {
      url: `https://github.com/${repo}.git`,
      ref: split.ref,
      label: repo,
    };
  } catch {
    return null;
  }
}

export function normalizeGitCloneSource(
  source: string,
): NormalizedGitCloneSource | null {
  const split = splitRef(source);
  if (looksLikeGitHubRepoShorthand(split.base)) {
    return {
      url: `https://github.com/${split.base}.git`,
      ref: split.ref,
      label: split.base,
    };
  }

  if (isGitUrl(source)) {
    return { url: split.base, ref: split.ref, label: split.base };
  }

  if (isHttpUrl(source)) {
    return normalizeGitHubHttpCloneSource(source);
  }

  return null;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readClaudeKnownMarketplaces(): Promise<
  Record<string, KnownMarketplaceRecord>
> {
  if (!(await pathExists(CLAUDE_KNOWN_MARKETPLACES_PATH))) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await fs.promises.readFile(CLAUDE_KNOWN_MARKETPLACES_PATH, 'utf-8'),
    );
  } catch {
    return {};
  }

  if (!isRecord(parsed)) return {};

  const output: Record<string, KnownMarketplaceRecord> = {};
  for (const [name, entry] of Object.entries(parsed)) {
    if (!isRecord(entry)) continue;
    output[name] = {
      installLocation: toOptionalString(entry.installLocation),
      source: entry.source,
    };
  }
  return output;
}

function deriveMarketplaceRootFromManifestPath(manifestPath: string): string {
  const manifestDir = path.dirname(manifestPath);
  return path.basename(manifestDir) === '.claude-plugin'
    ? path.dirname(manifestDir)
    : manifestDir;
}

function normalizeEntrySource(
  raw: unknown,
): { ok: true; source: MarketplaceEntrySource } | { ok: false; error: string } {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { ok: false, error: 'empty extension source' };
    }
    if (isHttpUrl(trimmed)) {
      return { ok: true, source: { kind: 'url', url: trimmed } };
    }
    return { ok: true, source: { kind: 'path', path: trimmed } };
  }

  if (!isRecord(raw)) {
    return { ok: false, error: 'extension source must be a string or object' };
  }

  const kind = toOptionalString(raw.type) ?? toOptionalString(raw.source);
  if (!kind) {
    return { ok: false, error: 'source object missing "type"' };
  }

  if (kind === 'path') {
    const sourcePath = toOptionalString(raw.path);
    if (!sourcePath) return { ok: false, error: 'path source missing "path"' };
    return { ok: true, source: { kind: 'path', path: sourcePath } };
  }

  if (kind === 'github') {
    const repo = toOptionalString(raw.repo) ?? toOptionalString(raw.url);
    if (!repo) return { ok: false, error: 'github source missing "repo"' };
    return {
      ok: true,
      source: {
        kind: 'github',
        repo,
        ref: toOptionalString(raw.ref) ?? toOptionalString(raw.branch),
        path: toOptionalString(raw.path),
      },
    };
  }

  if (kind === 'git') {
    const url = toOptionalString(raw.url) ?? toOptionalString(raw.repo);
    if (!url) return { ok: false, error: 'git source missing "url"' };
    return {
      ok: true,
      source: {
        kind: 'git',
        url,
        ref: toOptionalString(raw.ref) ?? toOptionalString(raw.branch),
        path: toOptionalString(raw.path),
      },
    };
  }

  if (kind === 'git-subdir') {
    const url = toOptionalString(raw.url) ?? toOptionalString(raw.repo);
    const sourcePath = toOptionalString(raw.path) ?? toOptionalString(raw.subdir);
    if (!url) return { ok: false, error: 'git-subdir source missing "url"' };
    if (!sourcePath) {
      return { ok: false, error: 'git-subdir source missing "path"' };
    }
    return {
      ok: true,
      source: {
        kind: 'git-subdir',
        url,
        ref: toOptionalString(raw.ref) ?? toOptionalString(raw.branch),
        path: sourcePath,
      },
    };
  }

  if (kind === 'url') {
    const url = toOptionalString(raw.url);
    if (!url) return { ok: false, error: 'url source missing "url"' };
    return { ok: true, source: { kind: 'url', url } };
  }

  return { ok: false, error: `unsupported source kind: ${kind}` };
}

function parseMarketplaceManifest(
  raw: string,
  sourceLabel: string,
): { ok: true; manifest: MarketplaceManifest } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `invalid marketplace JSON at ${sourceLabel}: ${String(err)}`,
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      error: `invalid marketplace JSON at ${sourceLabel}: expected object`,
    };
  }
  if (!Array.isArray(parsed.plugins)) {
    return {
      ok: false,
      error: `invalid marketplace JSON at ${sourceLabel}: missing plugins[]`,
    };
  }
  const plugins: MarketplacePluginEntry[] = [];
  for (const entry of parsed.plugins) {
    if (!isRecord(entry)) {
      return {
        ok: false,
        error: `invalid marketplace entry in ${sourceLabel}: expected object`,
      };
    }
    const name = toOptionalString(entry.name);
    if (!name) {
      return {
        ok: false,
        error: `invalid marketplace entry in ${sourceLabel}: missing name`,
      };
    }
    const normalizedSource = normalizeEntrySource(entry.source);
    if (!normalizedSource.ok) {
      return {
        ok: false,
        error: `invalid marketplace entry "${name}" in ${sourceLabel}: ${normalizedSource.error}`,
      };
    }
    plugins.push({
      name,
      version: toOptionalString(entry.version),
      description: toOptionalString(entry.description),
      source: normalizedSource.source,
    });
  }
  return {
    ok: true,
    manifest: {
      name: toOptionalString(parsed.name),
      version: toOptionalString(parsed.version),
      plugins,
    },
  };
}

async function resolveLocalMarketplaceSource(
  input: string,
): Promise<
  | { ok: true; rootDir: string; manifestPath: string }
  | { ok: false; error: string }
  | null
> {
  const resolved = path.isAbsolute(input)
    ? input
    : path.resolve(process.cwd(), input);
  if (!(await pathExists(resolved))) return null;

  const stat = await fs.promises.stat(resolved);
  if (stat.isFile()) {
    return {
      ok: true,
      rootDir: deriveMarketplaceRootFromManifestPath(resolved),
      manifestPath: resolved,
    };
  }

  if (!stat.isDirectory()) {
    return { ok: false, error: `unsupported marketplace source: ${resolved}` };
  }

  const rootDir =
    path.basename(resolved) === '.claude-plugin'
      ? path.dirname(resolved)
      : resolved;
  for (const candidate of MARKETPLACE_MANIFEST_CANDIDATES) {
    const manifestPath = path.join(rootDir, candidate);
    if (await pathExists(manifestPath)) {
      return { ok: true, rootDir, manifestPath };
    }
  }

  return {
    ok: false,
    error: `marketplace manifest not found under ${resolved}`,
  };
}

export async function resolveLocalBundleSource(
  input: string,
): Promise<ResolvedBundleSource> {
  const absolute = path.isAbsolute(input)
    ? input
    : path.resolve(process.cwd(), input);
  if (!(await pathExists(absolute))) {
    return {
      ok: false,
      error: t('extension.pathNotFound', { path: absolute }, undefined),
    };
  }

  const stat = await fs.promises.stat(absolute);
  if (stat.isFile() && resolveArchiveKind(absolute)) {
    return await extractArchiveToBundleRoot(absolute);
  }

  try {
    return {
      ok: true,
      bundleRoot: resolveBundleRootFromPath(absolute),
      sourceRef: absolute,
      suggestedName: deriveSuggestedNameFromPath(absolute),
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : t('extension.resolvePathFailed', { path: absolute }, undefined),
    };
  }
}

async function cloneMarketplaceRepo(params: {
  source: string;
  timeoutMs?: number;
}): Promise<
  | {
      ok: true;
      rootDir: string;
      cleanup: () => Promise<void>;
      label: string;
      sourcePath?: string;
    }
  | { ok: false; error: string }
> {
  const normalized = normalizeGitCloneSource(params.source);
  if (!normalized) {
    return {
      ok: false,
      error: `unsupported marketplace source: ${params.source}`,
    };
  }

  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'nanoclaw-marketplace-'),
  );
  const repoDir = path.join(tmpDir, 'repo');
  const args = ['clone', '--depth', '1'];
  if (normalized.ref) {
    args.push('--branch', normalized.ref);
  }
  args.push(normalized.url, repoDir);
  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    timeout: params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    await fs.promises
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => undefined);
    const detail =
      result.stderr?.trim() || result.stdout?.trim() || 'git clone failed';
    return {
      ok: false,
      error: `failed to clone marketplace source ${normalized.label}: ${detail}`,
    };
  }

  return {
    ok: true,
    rootDir: repoDir,
    label: normalized.label,
    sourcePath: normalized.path,
    cleanup: async () => {
      await fs.promises
        .rm(tmpDir, { recursive: true, force: true })
        .catch(() => undefined);
    },
  };
}

async function fetchRemoteBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  const declaredLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_FETCH_BYTES) {
    throw new Error('remote response exceeds size limit');
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_REMOTE_FETCH_BYTES) {
      throw new Error('remote response exceeds size limit');
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_REMOTE_FETCH_BYTES) {
        throw new Error('remote response exceeds size limit');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

async function fetchRemoteText(url: string): Promise<string> {
  const buffer = await fetchRemoteBuffer(url);
  return buffer.toString('utf-8');
}

function getRemoteBundleFileName(url: string): string | null {
  try {
    const parsed = new URL(url);
    const baseName = path.posix.basename(decodeURIComponent(parsed.pathname));
    const normalized = baseName.toLowerCase();
    if (
      normalized === 'skill.md' ||
      normalized === '.mcp.json' ||
      normalized === 'plugin.json'
    ) {
      return baseName;
    }
    return null;
  } catch {
    return null;
  }
}

export async function downloadRemoteBundleFile(
  url: string,
): Promise<
  | {
      ok: true;
      bundleRoot: string;
      sourceRef: string;
      suggestedName?: string;
      cleanup: () => Promise<void>;
    }
  | { ok: false; error: string }
> {
  if (resolveArchiveKind(url)) {
    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'nanoclaw-extension-download-'),
    );
    try {
      const archiveName =
        stripArchiveExtension(path.posix.basename(new URL(url).pathname)) ||
        'bundle';
      const fileName = path.posix.basename(new URL(url).pathname) || `${archiveName}.zip`;
      const archivePath = path.join(tmpDir, fileName);
      await fs.promises.writeFile(archivePath, await fetchRemoteBuffer(url));
      const extracted = await extractArchiveToBundleRoot(archivePath);
      if (!extracted.ok) {
        await fs.promises
          .rm(tmpDir, { recursive: true, force: true })
          .catch(() => undefined);
        return extracted;
      }
      return {
        ok: true,
        bundleRoot: extracted.bundleRoot,
        sourceRef: url,
        suggestedName:
          extracted.suggestedName ||
          deriveSuggestedNameFromPath(decodeURIComponent(new URL(url).pathname)),
        cleanup: async () => {
          await extracted.cleanup();
          await fs.promises
            .rm(tmpDir, { recursive: true, force: true })
            .catch(() => undefined);
        },
      };
    } catch (err) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      return {
        ok: false,
        error: `failed to fetch remote extension source ${url}: ${err instanceof Error ? err.message : 'request failed'}`,
      };
    }
  }

  const fileName = getRemoteBundleFileName(url);
  if (!fileName) {
    return {
      ok: false,
      error:
        'unsupported remote extension source: only SKILL.md, .mcp.json, or .claude-plugin/plugin.json links are supported',
    };
  }

  try {
    const raw = await fetchRemoteText(url);
    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'nanoclaw-extension-download-'),
    );
    const normalized = fileName.toLowerCase();
    const targetFile =
      normalized === 'plugin.json'
        ? path.join(tmpDir, '.claude-plugin', 'plugin.json')
        : normalized === '.mcp.json'
          ? path.join(tmpDir, '.mcp.json')
          : path.join(tmpDir, 'SKILL.md');
    await fs.promises.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.promises.writeFile(targetFile, raw, 'utf-8');
    return {
      ok: true,
      bundleRoot: resolveBundleRootFromPath(targetFile),
      sourceRef: url,
      suggestedName: deriveSuggestedNameFromPath(
        decodeURIComponent(new URL(url).pathname),
      ),
      cleanup: async () => {
        await fs.promises
          .rm(tmpDir, { recursive: true, force: true })
          .catch(() => undefined);
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `failed to fetch remote extension source ${url}: ${err instanceof Error ? err.message : 'request failed'}`,
    };
  }
}

export async function loadMarketplace(params: {
  source: string;
}): Promise<{ ok: true; marketplace: LoadedMarketplace } | { ok: false; error: string }> {
  const knownMarketplaces = await readClaudeKnownMarketplaces();
  const known = knownMarketplaces[params.source];
  if (known?.installLocation) {
    const local = await resolveLocalMarketplaceSource(known.installLocation);
    if (local?.ok) {
      const raw = await fs.promises.readFile(local.manifestPath, 'utf-8');
      const parsed = parseMarketplaceManifest(raw, local.manifestPath);
      if (!parsed.ok) return parsed;
      return {
        ok: true,
        marketplace: {
          manifest: parsed.manifest,
          rootDir: local.rootDir,
          sourceLabel: params.source,
        },
      };
    }
  }

  if (known?.source) {
    if (typeof known.source === 'string') {
      return await loadMarketplace({ source: known.source });
    }
    if (isRecord(known.source)) {
      const normalized = normalizeEntrySource(known.source);
      if (normalized.ok) {
        if (normalized.source.kind === 'github') {
          return await loadMarketplace({
            source: `${normalized.source.repo}${normalized.source.ref ? `#${normalized.source.ref}` : ''}`,
          });
        }
        if (normalized.source.kind === 'git') {
          return await loadMarketplace({
            source: `${normalized.source.url}${normalized.source.ref ? `#${normalized.source.ref}` : ''}`,
          });
        }
        if (normalized.source.kind === 'path') {
          return await loadMarketplace({ source: normalized.source.path });
        }
        if (normalized.source.kind === 'url') {
          return await loadMarketplace({ source: normalized.source.url });
        }
      }
    }
  }

  const local = await resolveLocalMarketplaceSource(params.source);
  if (local?.ok) {
    const raw = await fs.promises.readFile(local.manifestPath, 'utf-8');
    const parsed = parseMarketplaceManifest(raw, local.manifestPath);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      marketplace: {
        manifest: parsed.manifest,
        rootDir: local.rootDir,
        sourceLabel: local.manifestPath,
      },
    };
  }
  if (local && !local.ok) {
    return local;
  }

  if (
    isHttpUrl(params.source) &&
    /marketplace\.json(?:$|\?)/i.test(params.source) &&
    !normalizeGitCloneSource(params.source)
  ) {
    try {
      const raw = await fetchRemoteText(params.source);
      const parsed = parseMarketplaceManifest(raw, params.source);
      if (!parsed.ok) return parsed;
      return {
        ok: true,
        marketplace: {
          manifest: parsed.manifest,
          rootDir: '',
          sourceLabel: params.source,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: `failed to fetch marketplace source ${params.source}: ${err instanceof Error ? err.message : 'request failed'}`,
      };
    }
  }

  const cloned = await cloneMarketplaceRepo({ source: params.source });
  if (!cloned.ok) return cloned;
  const rootsToTry = [
    cloned.sourcePath
      ? ensureInsideRoot(cloned.rootDir, path.join(cloned.rootDir, cloned.sourcePath))
      : undefined,
    cloned.rootDir,
  ].filter(Boolean) as string[];
  for (const rootToTry of rootsToTry) {
    const localResolved = await resolveLocalMarketplaceSource(rootToTry);
    if (!localResolved?.ok) continue;
    const raw = await fs.promises.readFile(localResolved.manifestPath, 'utf-8');
    const parsed = parseMarketplaceManifest(raw, localResolved.manifestPath);
    if (!parsed.ok) {
      await cloned.cleanup();
      return parsed;
    }
    return {
      ok: true,
      marketplace: {
        manifest: parsed.manifest,
        rootDir: localResolved.rootDir,
        sourceLabel: cloned.label,
        cleanup: cloned.cleanup,
      },
    };
  }

  await cloned.cleanup();
  return {
    ok: false,
    error: `marketplace manifest not found in ${cloned.label}`,
  };
}

export async function resolveBundleSourceFromEntry(
  source: MarketplaceEntrySource,
  marketplaceRootDir: string,
): Promise<ResolvedBundleSource> {
  if (source.kind === 'path') {
    if (!marketplaceRootDir.trim()) {
      return {
        ok: false,
        error:
          'remote marketplace path sources are not supported; use github, git, or direct URLs instead',
      };
    }
    const sourcePath = path.isAbsolute(source.path)
      ? source.path
      : ensureInsideRoot(
          marketplaceRootDir,
          path.join(marketplaceRootDir, source.path),
        );
    return await resolveLocalBundleSource(sourcePath);
  }

  if (source.kind === 'url') {
    if (normalizeGitCloneSource(source.url)) {
      const cloned = await cloneMarketplaceRepo({ source: source.url });
      if (!cloned.ok) return cloned;
      const bundleRoot = cloned.sourcePath
        ? ensureInsideRoot(
            cloned.rootDir,
            path.join(cloned.rootDir, cloned.sourcePath),
          )
        : cloned.rootDir;
      return {
        ok: true,
        bundleRoot: resolveBundleRootFromPath(bundleRoot),
        sourceRef: source.url,
        suggestedName:
          deriveSuggestedNameFromPath(cloned.sourcePath || '') ||
          deriveSuggestedNameFromPath(cloned.label),
        cleanup: cloned.cleanup,
      };
    }
    return await downloadRemoteBundleFile(source.url);
  }

  const cloneableSource =
    source.kind === 'github'
      ? `${source.repo}${source.ref ? `#${source.ref}` : ''}`
      : source.kind === 'git'
        ? `${source.url}${source.ref ? `#${source.ref}` : ''}`
        : `${source.url}${source.ref ? `#${source.ref}` : ''}`;

  const cloned = await cloneMarketplaceRepo({ source: cloneableSource });
  if (!cloned.ok) return cloned;

  let bundleRoot = cloned.sourcePath
    ? ensureInsideRoot(
        cloned.rootDir,
        path.join(cloned.rootDir, cloned.sourcePath),
      )
    : cloned.rootDir;
  let suggestedName =
    deriveSuggestedNameFromPath(cloned.sourcePath || '') ||
    deriveSuggestedNameFromPath(cloned.label);
  if (source.kind === 'git-subdir') {
    bundleRoot = ensureInsideRoot(
      cloned.rootDir,
      path.join(cloned.rootDir, source.path),
    );
    suggestedName = deriveSuggestedNameFromPath(source.path) || suggestedName;
  } else if ((source.kind === 'github' || source.kind === 'git') && source.path) {
    bundleRoot = ensureInsideRoot(
      cloned.rootDir,
      path.join(cloned.rootDir, source.path),
    );
    suggestedName = deriveSuggestedNameFromPath(source.path) || suggestedName;
  }

  return {
    ok: true,
    bundleRoot: resolveBundleRootFromPath(bundleRoot),
    sourceRef: cloneableSource,
    suggestedName,
    cleanup: cloned.cleanup,
  };
}

async function inspectCatalogEntryBundle(params: {
  source: MarketplaceEntrySource;
  marketplaceRootDir: string;
}): Promise<
  | {
      ok: true;
      skillCount: number;
      mcpCount: number;
      agentCount: number;
      installable: boolean;
    }
  | { ok: false; error: string }
> {
  const resolvedSource = await resolveBundleSourceFromEntry(
    params.source,
    params.marketplaceRootDir,
  );
  if (!resolvedSource.ok) {
    return resolvedSource;
  }

  try {
    const bundleScan = loadBundleScan(resolvedSource.bundleRoot);
    let mcpCount = 0;
    for (const mcpFile of bundleScan.mcpFiles) {
      mcpCount += parseManagedMcpBundleFile(mcpFile).length;
    }
    const skillCount = bundleScan.skills.length + bundleScan.commandSkills.length;
    const agentCount = bundleScan.agentDirs.length;
    return {
      ok: true,
      skillCount,
      mcpCount,
      agentCount,
      installable: skillCount > 0 || mcpCount > 0 || agentCount > 0,
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : 'Failed to inspect extension bundle',
    };
  } finally {
    await resolvedSource.cleanup?.();
  }
}

export async function describeCatalogEntrySource(
  sourceId: string,
  sourceName: string,
  sourceLabel: string,
  marketplaceRootDir: string,
  marketplace: MarketplaceManifest,
  entry: MarketplacePluginEntry,
): Promise<ExtensionCatalogEntry> {
  const inspected = await inspectCatalogEntryBundle({
    source: entry.source,
    marketplaceRootDir,
  });
  return {
    id: `${sourceId}:${entry.name}`,
    entryName: entry.name,
    title: entry.name,
    description:
      inspected.ok || !inspected.error
        ? entry.description
        : entry.description
          ? `${entry.description} (${inspected.error})`
          : inspected.error,
    version: entry.version,
    sourceId,
    sourceName,
    sourceLabel,
    marketplaceName: marketplace.name,
    marketplaceVersion: marketplace.version,
    skillCount: inspected.ok ? inspected.skillCount : 0,
    mcpCount: inspected.ok ? inspected.mcpCount : 0,
    agentCount: inspected.ok ? inspected.agentCount : 0,
    installable: inspected.ok ? inspected.installable : false,
  };
}
