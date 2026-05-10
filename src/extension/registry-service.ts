import fs, { createWriteStream } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { pipeline } from 'node:stream/promises';

import { logger } from '../logger.js';
import { createUserSkill } from '../user/user-skill-service.js';
import { createUserMcpServer } from '../user/user-mcp-service.js';
import type { UserSkillView } from '../user/user-skill-service.js';
import type { UserMcpServerView } from '../user/user-mcp-service.js';
import { t } from '../i18n/index.js';

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryCatalogItem {
  slug: string;
  name: string;
  description: string;
  type: 'skill' | 'mcp' | 'bundle';
  source: { kind: 'github'; repo: string; ref?: string; path?: string };
  tags: string[];
  author?: string;
  version?: string;
  stars?: number;
  iconUrl?: string;
}

export interface RegistryCatalog {
  name: string;
  description: string;
  items: RegistryCatalogItem[];
  updatedAt: string;
}

export interface RegistryInstallResult {
  type: 'skill' | 'mcp';
  item: UserSkillView | UserMcpServerView;
}

// ---------------------------------------------------------------------------
// Catalog sources (configurable via env or config)
// ---------------------------------------------------------------------------

const CATALOG_URLS = buildCatalogUrls();

function buildCatalogUrls(): string[] {
  const envUrls = process.env.NANOCLAW_REGISTRY_CATALOG_URLS?.trim();
  if (envUrls) {
    return envUrls.split(',').map((u) => u.trim()).filter(Boolean);
  }
  return [
    'https://raw.githubusercontent.com/nicepkg/openclaw/main/registry/catalog.json',
  ];
}

let catalogCache: { catalog: RegistryCatalog; fetchedAt: number } | null = null;

function getBuiltinFallbackCatalog(): RegistryCatalog {
  return {
    name: 'OpenClaw Community',
    description: t('errors.auto_1d437e', {}, undefined),
    updatedAt: new Date().toISOString(),
    items: [
      {
        slug: 'colleague-skill',
        name: t('errors.auto_cc98ae', {}, undefined),
        description: t('errors.auto_e68162', {}, undefined),
        type: 'skill',
        source: { kind: 'github', repo: 'titanwings/colleague-skill' },
        tags: ['knowledge', 'persona', 'team'],
        author: 'titanwings',
        stars: 12874,
      },
      {
        slug: 'codebase-doctor',
        name: 'Codebase Doctor',
        description: t('errors.auto_2e9d6b', {}, undefined),
        type: 'skill',
        source: { kind: 'github', repo: 'nicepkg/codebase-doctor' },
        tags: ['code-quality', 'diagnostics'],
        author: 'nicepkg',
      },
      {
        slug: 'ai-commit',
        name: 'AI Commit',
        description: t('errors.auto_d7ca37', {}, undefined),
        type: 'skill',
        source: { kind: 'github', repo: 'nicepkg/ai-commit-skill' },
        tags: ['git', 'commit', 'automation'],
        author: 'nicepkg',
      },
      {
        slug: 'test-writer',
        name: 'Test Writer',
        description: t('errors.auto_d535f1', {}, undefined),
        type: 'skill',
        source: { kind: 'github', repo: 'nicepkg/test-writer' },
        tags: ['testing', 'automation'],
        author: 'nicepkg',
      },
      {
        slug: 'code-reviewer',
        name: 'Code Reviewer',
        description: t('errors.auto_32ea0d', {}, undefined),
        type: 'skill',
        source: { kind: 'github', repo: 'nicepkg/code-reviewer-skill' },
        tags: ['code-review', 'quality'],
        author: 'nicepkg',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Catalog fetch — tries all configured URLs, merges results
// ---------------------------------------------------------------------------

export async function fetchRegistryCatalog(options?: {
  forceRefresh?: boolean;
  search?: string;
  type?: 'skill' | 'mcp' | 'bundle';
}): Promise<RegistryCatalog> {
  const now = Date.now();

  if (
    !options?.forceRefresh &&
    catalogCache &&
    now - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS
  ) {
    return applyFilters(catalogCache.catalog, options);
  }

  const allItems: RegistryCatalogItem[] = [];
  let remoteName = 'Registry';
  let remoteDescription = '';
  let anySuccess = false;

  for (const url of CATALOG_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        logger.warn({ url, status: res.status }, 'registry: remote catalog returned non-OK');
        continue;
      }
      const raw = await res.json();
      const data = normalizeCatalog(raw);
      if (data) {
        anySuccess = true;
        if (!remoteDescription) {
          remoteName = data.name;
          remoteDescription = data.description;
        }
        const seenSlugs = new Set(allItems.map((i) => i.slug));
        for (const item of data.items) {
          if (!seenSlugs.has(item.slug)) {
            seenSlugs.add(item.slug);
            allItems.push(item);
          }
        }
        logger.info({ url, count: data.items.length }, 'registry: fetched remote catalog');
      }
    } catch (err) {
      logger.warn({ err, url }, 'registry: failed to fetch remote catalog');
    }
  }

  if (anySuccess && allItems.length > 0) {
    const merged: RegistryCatalog = {
      name: remoteName,
      description: remoteDescription,
      items: allItems,
      updatedAt: new Date().toISOString(),
    };
    catalogCache = { catalog: merged, fetchedAt: now };
    return applyFilters(merged, options);
  }

  logger.warn('registry: all remote catalogs failed, using fallback');
  const fallback = getBuiltinFallbackCatalog();
  catalogCache = { catalog: fallback, fetchedAt: now };
  return applyFilters(fallback, options);
}

function normalizeCatalogItem(raw: Record<string, unknown>): RegistryCatalogItem | null {
  const slug = typeof raw.slug === 'string' ? raw.slug : '';
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!slug || !name) return null;
  const source = raw.source as { kind?: string; repo?: string; ref?: string; path?: string } | undefined;
  if (!source?.repo) return null;
  return {
    slug,
    name,
    description: typeof raw.description === 'string' ? raw.description : '',
    type: (['skill', 'mcp', 'bundle'] as const).includes(raw.type as 'skill')
      ? (raw.type as 'skill' | 'mcp' | 'bundle')
      : 'skill',
    source: { kind: 'github', repo: source.repo, ref: source.ref, path: source.path },
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]).filter((t) => typeof t === 'string') : [],
    author: typeof raw.author === 'string' ? raw.author : undefined,
    version: typeof raw.version === 'string' ? raw.version : undefined,
    stars: typeof raw.stars === 'number' ? raw.stars : undefined,
    iconUrl: typeof raw.iconUrl === 'string' ? raw.iconUrl : undefined,
  };
}

function normalizeCatalog(raw: unknown): RegistryCatalog | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items = rawItems
    .map((item) => normalizeCatalogItem(item as Record<string, unknown>))
    .filter((item): item is RegistryCatalogItem => item !== null);
  if (items.length === 0) return null;
  return {
    name: typeof obj.name === 'string' ? obj.name : 'Registry',
    description: typeof obj.description === 'string' ? obj.description : '',
    items,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
  };
}

function applyFilters(
  catalog: RegistryCatalog,
  options?: { search?: string; type?: string },
): RegistryCatalog {
  if (!options?.search && !options?.type) return catalog;

  let items = catalog.items;
  if (options.type) {
    items = items.filter((i) => i.type === options.type);
  }
  if (options.search) {
    const term = options.search.toLowerCase();
    items = items.filter(
      (i) =>
        (i.name || '').toLowerCase().includes(term) ||
        (i.description || '').toLowerCase().includes(term) ||
        (i.slug || '').toLowerCase().includes(term) ||
        (i.tags || []).some((t) => (t || '').toLowerCase().includes(term)),
    );
  }
  return { ...catalog, items };
}

// ---------------------------------------------------------------------------
// Install from registry
// ---------------------------------------------------------------------------

export async function installFromRegistry(
  userId: string,
  slug: string,
): Promise<RegistryInstallResult[]> {
  if (!SAFE_SLUG_RE.test(slug)) {
    throw new Error(`Invalid registry slug: ${slug}`);
  }

  const catalog = await fetchRegistryCatalog();
  const entry = catalog.items.find((i) => i.slug === slug);
  if (!entry) {
    throw new Error(`Registry item not found: ${slug}`);
  }

  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-registry-'),
  );

  try {
    await fetchRepoContent(entry.source.repo, tmpDir, entry.source.ref);

    let repoRoot = tmpDir;
    if (entry.source.path) {
      const resolved = path.resolve(tmpDir, entry.source.path);
      if (!resolved.startsWith(tmpDir + path.sep) && resolved !== tmpDir) {
        throw new Error(`Invalid source path: ${entry.source.path}`);
      }
      repoRoot = resolved;
    }

    const results: RegistryInstallResult[] = [];

    const skillMd = path.join(repoRoot, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, 'utf-8');
      const skill = await createUserSkill(userId, {
        name: entry.name,
        description: entry.description,
        skillContent: content,
        enabled: true,
        visibility: 'private',
        sourceType: 'registry',
        sourceRef: `${entry.slug}@${entry.version || 'latest'}`,
        tags: entry.tags,
      });
      results.push({ type: 'skill', item: skill });
    }

    const mcpJson = path.join(repoRoot, '.mcp.json');
    if (fs.existsSync(mcpJson)) {
      try {
        const mcpConfig = JSON.parse(fs.readFileSync(mcpJson, 'utf-8'));
        const servers = mcpConfig.mcpServers || mcpConfig.servers || {};
        for (const [key, cfg] of Object.entries(servers)) {
          const serverCfg = cfg as {
            command?: string;
            args?: string[];
            env?: Record<string, string>;
          };
          if (!serverCfg.command) continue;
          const mcp = await createUserMcpServer(userId, {
            name: `${entry.name} - ${key}`,
            description: entry.description,
            command: serverCfg.command,
            args: serverCfg.args,
            env: serverCfg.env,
            enabled: true,
            visibility: 'private',
            sourceType: 'registry',
            sourceRef: `${entry.slug}@${entry.version || 'latest'}`,
            tags: entry.tags,
          });
          results.push({ type: 'mcp', item: mcp });
        }
      } catch (err) {
        logger.warn({ err, slug }, 'registry: failed to parse .mcp.json');
      }
    }

    if (results.length === 0) {
      throw new Error(
        `No installable content found in ${slug}. Expected SKILL.md or .mcp.json.`,
      );
    }

    return results;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Repo download helpers — tarball first, git clone fallback
// ---------------------------------------------------------------------------

function isGitHubShorthand(repo: string): boolean {
  return /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo);
}

async function downloadTarball(
  repo: string,
  targetDir: string,
  ref?: string,
): Promise<boolean> {
  if (!isGitHubShorthand(repo) && !repo.startsWith('https://github.com/')) {
    return false;
  }
  const ownerRepo = isGitHubShorthand(repo)
    ? repo
    : repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');

  const candidateUrls: string[] = [];
  if (ref) {
    candidateUrls.push(
      `https://github.com/${ownerRepo}/archive/refs/heads/${ref}.tar.gz`,
      `https://github.com/${ownerRepo}/archive/refs/tags/${ref}.tar.gz`,
    );
  } else {
    candidateUrls.push(
      `https://github.com/${ownerRepo}/archive/refs/heads/main.tar.gz`,
      `https://github.com/${ownerRepo}/archive/refs/heads/master.tar.gz`,
    );
  }

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
      });
      if (res.ok && res.body) {
        return await extractTarball(res, targetDir);
      }
    } catch {
      // try next candidate
    }
  }

  logger.warn({ repo, ref }, 'registry: all tarball candidates failed');
  return false;
}

async function extractTarball(res: Response, targetDir: string): Promise<boolean> {
  const tarPath = path.join(targetDir, '__archive.tar.gz');
  try {
    const fileStream = createWriteStream(tarPath);
    // @ts-expect-error Node.js ReadableStream compat
    await pipeline(res.body, fileStream);

    const tarResult = spawnSync('tar', [
      'xzf', tarPath,
      '--strip-components=1',
      '-C', targetDir,
    ], { timeout: 30_000, stdio: 'pipe' });

    if (tarResult.status !== 0) {
      logger.warn({ stderr: tarResult.stderr?.toString() }, 'registry: tar extract failed');
      return false;
    }
    return true;
  } finally {
    try { fs.unlinkSync(tarPath); } catch { /* best effort */ }
  }
}

function cloneRepo(repo: string, targetDir: string, ref?: string): void {
  const url = repo.startsWith('http')
    ? repo
    : `https://github.com/${repo}.git`;

  const args = ['clone', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  args.push(url, targetDir);

  const cleanEnv: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    // Bypass system/global git config (e.g. insteadOf URL rewrites to mirrors)
    // that may cause clone failures in certain network environments
    GIT_CONFIG_GLOBAL: '',
    GIT_CONFIG_SYSTEM: '',
  };

  const result = spawnSync('git', args, {
    timeout: DEFAULT_GIT_TIMEOUT_MS,
    stdio: 'pipe',
    env: cleanEnv,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || 'unknown error';
    throw new Error(`git clone failed for ${repo}: ${stderr}`);
  }
}

async function fetchRepoContent(
  repo: string,
  targetDir: string,
  ref?: string,
): Promise<void> {
  const tarballOk = await downloadTarball(repo, targetDir, ref);
  if (tarballOk) {
    logger.info({ repo, ref }, 'registry: installed via tarball download');
    return;
  }
  logger.info({ repo }, 'registry: tarball unavailable, falling back to git clone');
  cloneRepo(repo, targetDir, ref);
}
