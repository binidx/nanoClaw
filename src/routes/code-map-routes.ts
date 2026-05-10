import fs from 'node:fs';
import path from 'node:path';

import type { Express, Request } from 'express';

import { buildCodeMapAsync, computeCodeMapManifestHash } from '../code-intelligence/code-map-builder.js';
import { listCandidateFiles, normalizeRelativePath } from '../code-intelligence/code-search-collect.js';
import { resolveBuildOptions } from '../code-intelligence/code-search-index.js';
import { renderCodeMapText, renderCodeMapSummary } from '../code-intelligence/code-map-render.js';
import {
  buildRepoDescriptionPrompt,
  assembleRepoDescription,
  identifyModules,
  identifyEntryPoints,
  extractTechStack,
  computeLanguageStats,
  type RepoDescription,
} from '../code-intelligence/code-map-description.js';
import {
  loadCodeMapFromDb,
  saveCodeMapToDb,
} from '../code-intelligence/code-map-persist.js';
import type { CodeMapSnapshot } from '../code-intelligence/code-map-types.js';
import { generateTextWithDefaultProvider, generateTextStreamWithDefaultProvider } from '../provider/provider-api.js';
import {
  getReviewRepositoryById,
  listReviewRepositories,
  type ReviewRepositoryRecord,
} from '../db/review.js';
import {
  getCodeMapAiAnalysis,
  saveCodeMapAiAnalysis,
  upsertCodeMapAiAnalysis,
  pruneCodeMapAiAnalyses,
} from '../db/code-map-analysis-db.js';
import { acquireWorktree, listWorktrees } from '../agent/worktree-manager.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { canAccessRepositoryResource } from '../auth/resource-access-policy.js';
import { t } from '../i18n/index.js';

export interface CodeMapRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  auditMutation: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
}

const MAX_CACHE_ENTRIES = 32;
const snapshotCache = new Map<string, CodeMapSnapshot>();
const buildingSet = new Set<string>();
const aiSummaryCache = new Map<string, string>();
const aiAnalysisCache = new Map<string, object>();
const repoDescriptionCache = new Map<string, RepoDescription>();

interface CodeRef {
  file: string;
  line: number;
  snippet: string;
  label: string;
}
interface AiSection {
  id: string;
  title: string;
  description: string;
  codeRefs: CodeRef[];
  children?: AiSection[];
}
interface AiAnalysis {
  title: string;
  summary: string;
  sections: AiSection[];
}

function safeRelativePath(rootDir: string, filePath: string): string | null {
  if (filePath.includes('..') || path.isAbsolute(filePath)) return null;
  const resolved = path.resolve(rootDir, filePath);
  if (!resolved.startsWith(path.resolve(rootDir) + path.sep) && resolved !== path.resolve(rootDir)) return null;
  return resolved;
}

function detectLanguageFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust',
    '.css': 'css', '.html': 'html', '.json': 'json', '.md': 'markdown',
    '.yaml': 'yaml', '.yml': 'yaml', '.sql': 'sql', '.sh': 'shell',
    '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.rb': 'ruby', '.kt': 'kotlin',
  };
  return map[ext] || 'text';
}

function evictOldestIfNeeded(): void {
  while (snapshotCache.size > MAX_CACHE_ENTRIES) {
    const firstKey = snapshotCache.keys().next().value;
    if (firstKey !== undefined) snapshotCache.delete(firstKey);
    else break;
  }
}

function memCacheKey(repoId: string, branch: string): string {
  return `${repoId}\0${branch}`;
}

function resolveDefaultBranch(repo: { default_target_branch?: string | null }): string {
  return repo.default_target_branch?.trim() || 'main';
}

function isExistingDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

async function resolveCodeMapRootDirectory(
  repo: ReviewRepositoryRecord,
  branch: string,
): Promise<string | null> {
  const shouldPreferRemoteSource = Boolean(repo.clone_url || repo.remote_provider);
  const worktrees = await listWorktrees(repo.id);
  const match = worktrees.find((w) => w.branch === branch);
  if (match?.workDirectory && isExistingDirectory(match.workDirectory)) return match.workDirectory;
  if (shouldPreferRemoteSource) {
    return await acquireWorktree({
      repositoryId: repo.id,
      branch,
      cloneUrl: repo.clone_url || undefined,
      purpose: 'codemap',
    });
  }
  if (repo.local_repo_path && isExistingDirectory(repo.local_repo_path)) {
    return repo.local_repo_path;
  }
  return null;
}

async function loadSnapshot(
  repoId: string,
  branch: string,
): Promise<CodeMapSnapshot | null> {
  const key = memCacheKey(repoId, branch);
  const cached = snapshotCache.get(key);
  if (cached) return cached;
  const fromDb = await loadCodeMapFromDb(repoId, branch);
  if (fromDb) {
    snapshotCache.set(key, fromDb);
    evictOldestIfNeeded();
  }
  return fromDb;
}

export async function scheduleCodeMapRebuild(
  repositoryId: string,
  branch: string,
): Promise<void> {
  const key = memCacheKey(repositoryId, branch);
  if (buildingSet.has(key)) return;

  const existing = await loadSnapshot(repositoryId, branch);
  if (!existing) return;

  const repo = await getReviewRepositoryById(repositoryId);
  if (!repo) return;

  let rootDir = await resolveCodeMapRootDirectory(repo, branch);
  if (!rootDir) return;

  buildingSet.add(key);
  try {
    const snapshot = await buildCodeMapAsync(rootDir, repositoryId, branch);
    snapshotCache.set(key, snapshot);
    evictOldestIfNeeded();
    await saveCodeMapToDb(snapshot);
  } catch {
    /* background rebuild failures are non-fatal */
  } finally {
    buildingSet.delete(key);
  }
}

export function registerCodeMapRoutes(
  app: Express,
  opts: CodeMapRouteOptions,
): void {
  const guard = opts.requirePermission('project.view', 'codemap.view');
  const manageGuard = opts.requirePermission('project.manage', 'codemap.manage');

  async function requireRepositoryAccess(
    req: Request,
    res: import('express').Response,
    repositoryId: string,
    requiredLevel = 'viewer',
  ): Promise<ReviewRepositoryRecord | null> {
    const repo = await getReviewRepositoryById(repositoryId);
    if (!repo) {
      res.status(404).json({ error: t('repo.notFound', {}, req.locale) });
      return null;
    }
    if (!await canAccessRepositoryResource(getTenantUserId(req), repositoryId, requiredLevel)) {
      res.status(403).json({ error: t('repo.noPermission', {}, req.locale) });
      return null;
    }
    return repo;
  }

  app.get('/api/code-map/repositories', guard, async (req, res) => {
    try {
      const repos = await listReviewRepositories();
      const items = [];
      for (const r of repos) {
        if (!await canAccessRepositoryResource(getTenantUserId(req), r.id)) continue;
        const branch = resolveDefaultBranch(r);
        const snapshot = await loadSnapshot(r.id, branch);
        const worktrees = await listWorktrees(r.id);
        const worktreeItems = [];
        for (const w of worktrees) {
          const ws = await loadSnapshot(r.id, w.branch);
          worktreeItems.push({ branch: w.branch, hasCodeMap: !!ws });
        }
        items.push({
          id: r.id,
          name: r.name,
          language: r.language,
          defaultBranch: branch,
          hasCodeMap: !!snapshot,
          generatedAt: snapshot?.generatedAt ?? null,
          stats: snapshot?.stats ?? null,
          worktrees: worktreeItems,
        });
      }
      res.json({ repositories: items });
    } catch (err) {
      res.status(500).json({
        error: t('errors.auto_a11e18', {}, req.locale),
      });
    }
  });

  app.get('/api/code-map/:repositoryId', guard, async (req, res) => {
    try {
      const repositoryId = decodeURIComponent(String(req.params.repositoryId || ''));
      const repo = await requireRepositoryAccess(req, res, repositoryId);
      if (!repo) return;

      const branch = String(req.query.branch || '').trim() || resolveDefaultBranch(repo);

      if (buildingSet.has(memCacheKey(repositoryId, branch))) {
        res.json({ source: 'building', snapshot: null, status: 'building' });
        return;
      }

      const snapshot = await loadSnapshot(repositoryId, branch);
      if (snapshot) {
        res.json({ source: 'cache', snapshot });
        return;
      }

      res.json({ source: 'none', snapshot: null, status: 'not_built' });
    } catch (err) {
      res.status(500).json({
        error: t('errors.auto_6ef252', {}, req.locale),
      });
    }
  });

  app.get('/api/code-map/:repositoryId/text', guard, async (req, res) => {
    try {
      const repositoryId = decodeURIComponent(String(req.params.repositoryId || ''));
      const repo = await requireRepositoryAccess(req, res, repositoryId, 'manager');
      if (!repo) return;

      const branch = String(req.query.branch || '').trim() || resolveDefaultBranch(repo);
      const maxTokens = Math.min(Number(req.query.maxTokens) || 2048, 16384);

      const snapshot = await loadSnapshot(repositoryId, branch);
      if (!snapshot) {
        res.status(404).json({ error: t('errors.auto_c0c012', {}, req.locale) });
        return;
      }

      const text = renderCodeMapText(snapshot, { maxTokens });
      res.type('text/plain').send(text);
    } catch (err) {
      res.status(500).json({
        error: t('errors.auto_83cc81', {}, req.locale),
      });
    }
  });

  app.get('/api/code-map/:repositoryId/stats', guard, async (req, res) => {
    try {
      const repositoryId = decodeURIComponent(String(req.params.repositoryId || ''));
      const repo = await requireRepositoryAccess(req, res, repositoryId, 'manager');
      if (!repo) return;

      const branch = String(req.query.branch || '').trim() || resolveDefaultBranch(repo);
      const key = memCacheKey(repositoryId, branch);
      const snapshot = await loadSnapshot(repositoryId, branch);

      res.json({
        repositoryId,
        branch,
        fileCount: snapshot?.stats.fileCount ?? 0,
        symbolCount: snapshot?.stats.symbolCount ?? 0,
        edgeCount: snapshot?.stats.edgeCount ?? 0,
        totalLines: snapshot?.stats.totalLines ?? 0,
        generatedAt: snapshot?.generatedAt ?? null,
        status: buildingSet.has(key)
          ? 'building'
          : snapshot
            ? 'fresh'
            : 'missing',
      });
    } catch (err) {
      res.status(500).json({
        error: t('errors.auto_26b8ab', {}, req.locale),
      });
    }
  });

  app.post('/api/code-map/:repositoryId/rebuild', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'code-map.rebuild', 'normal');
      const repositoryId = decodeURIComponent(String(req.params.repositoryId || ''));
      const repo = await requireRepositoryAccess(req, res, repositoryId, 'manager');
      if (!repo) return;

      const branch = String(req.query.branch || req.body?.branch || '').trim() || resolveDefaultBranch(repo);
      const key = memCacheKey(repositoryId, branch);

      if (buildingSet.has(key)) {
        res.json({ status: 'already_building' });
        return;
      }

      const rootDir = await resolveCodeMapRootDirectory(repo, branch);
      if (!rootDir) {
        res.status(400).json({ error: t('errors.codemap.noWorkDir', { branch }, req.locale) });
        return;
      }

      buildingSet.add(key);
      try {
        const force = req.query.force === '1' || req.body?.force === true;
        if (!force) {
          const existing = await loadSnapshot(repositoryId, branch);
          if (existing) {
            const searchOpts = resolveBuildOptions({ maxFiles: 2000 });
            const candidates = listCandidateFiles(rootDir, searchOpts);
            const manifestEntries = candidates.map((absPath) => {
              try {
                const st = fs.statSync(absPath);
                return {
                  relativePath: normalizeRelativePath(rootDir, absPath),
                  byteSize: st.size,
                  modifiedTimeMs: Math.trunc(st.mtimeMs),
                };
              } catch {
                return { relativePath: normalizeRelativePath(rootDir, absPath), byteSize: 0, modifiedTimeMs: 0 };
              }
            });
            const currentHash = computeCodeMapManifestHash(rootDir, manifestEntries);
            if (currentHash === existing.manifestHash) {
              res.json({ status: 'unchanged', stats: existing.stats });
              return;
            }
          }
        }

        snapshotCache.delete(key);
        const snapshot = await buildCodeMapAsync(rootDir, repositoryId, branch);
        snapshotCache.set(key, snapshot);
        evictOldestIfNeeded();
        await saveCodeMapToDb(snapshot);
        res.json({ status: 'rebuilt', stats: snapshot.stats });
      } finally {
        buildingSet.delete(key);
      }
    } catch (err) {
      res.status(500).json({
        error: t('errors.auto_df4592', {}, req.locale),
      });
    }
  });

  app.post('/api/code-map/:repositoryId/ai-summary', guard, async (req, res) => {
    try {
      const repositoryId = decodeURIComponent(String(req.params.repositoryId || ''));
      const repo = await requireRepositoryAccess(req, res, repositoryId);
      if (!repo) return;

      const branch = String(req.query.branch || req.body?.branch || '').trim() || resolveDefaultBranch(repo);
      const filePath: string = String(req.body?.filePath || '').trim();
      const dirPath: string = String(req.body?.dirPath || '').trim();
      if (!filePath && !dirPath) {
        res.status(400).json({ error: t('errors.auto_3032c9', {}, req.locale) });
        return;
      }

      const snapshot = await loadSnapshot(repositoryId, branch);
      if (!snapshot) {
        res.status(404).json({ error: t('errors.auto_c0c012', {}, req.locale) });
        return;
      }

      const cacheKey = `${repositoryId}\0${branch}\0${filePath || dirPath}\0${snapshot.manifestHash}`;
      const cached = aiSummaryCache.get(cacheKey);
      if (cached) { res.json({ summary: cached, cached: true }); return; }

      const MAX_SYMBOLS_IN_PROMPT = 40;
      const MAX_DEPS_IN_PROMPT = 20;

      let prompt: string;
      if (filePath) {
        const file = snapshot.files.find((f) => f.relativePath === filePath);
        if (!file) { res.status(404).json({ error: t('errors.auto_b831d6', {}, req.locale) }); return; }
        const deps = snapshot.edges.filter((e) => e.fromFile === filePath);
        const refs = snapshot.edges.filter((e) => e.toFile === filePath);
        const topSymbols = [...file.symbols].sort((a, b) => b.rank - a.rank).slice(0, MAX_SYMBOLS_IN_PROMPT);
        const symbolStr = topSymbols.map((s) => `${s.kind} ${s.name}`).join(', ')
          + (file.symbols.length > MAX_SYMBOLS_IN_PROMPT ? ` ${t('errors.codemap.moreCount', { count: file.symbols.length }, req.locale)}` : '');
        const depStr = deps.slice(0, MAX_DEPS_IN_PROMPT).map((e) => e.toFile).join(', ')
          + (deps.length > MAX_DEPS_IN_PROMPT ? ` ${t('errors.codemap.moreCount', { count: deps.length }, req.locale)}` : '');
        const refStr = refs.slice(0, MAX_DEPS_IN_PROMPT).map((e) => e.fromFile).join(', ')
          + (refs.length > MAX_DEPS_IN_PROMPT ? ` ${t('errors.codemap.moreCount', { count: refs.length }, req.locale)}` : '');
        prompt = [
          t('errors.codemap.promptFileAnalysis', {}, req.locale),
          `\n${t('errors.codemap.labelFile', {}, req.locale)} ${file.relativePath}`,
          `${t('errors.codemap.labelLanguage', {}, req.locale)} ${file.language}  ${t('errors.codemap.labelLines', {}, req.locale)} ${file.lineCount}`,
          `${t('errors.codemap.labelSymbols', {}, req.locale)} ${symbolStr}`,
          deps.length > 0 ? `${t('errors.codemap.labelDeps', {}, req.locale)} ${depStr}` : '',
          refs.length > 0 ? `${t('errors.codemap.labelRefs', {}, req.locale)} ${refStr}` : '',
          `\n${t('errors.codemap.promptOutputDirect', {}, req.locale)}`,
        ].filter(Boolean).join('\n');
      } else {
        const dirFiles = snapshot.files.filter((f) => f.relativePath.startsWith(dirPath + '/'));
        if (dirFiles.length === 0) { res.status(404).json({ error: t('errors.auto_910524', {}, req.locale) }); return; }
        const topFiles = dirFiles.sort((a, b) => b.rank - a.rank).slice(0, 15);
        prompt = [
          t('errors.codemap.promptDirAnalysis', {}, req.locale),
          `\n${t('errors.codemap.labelDir', { dirPath, count: dirFiles.length }, req.locale)}`,
          t('errors.codemap.labelMainFiles', {}, req.locale),
          ...topFiles.map((f) => `  - ${f.relativePath} (${f.language}, ${t('errors.codemap.symbolsCount', { count: f.symbols.length }, req.locale)})`),
          `\n${t('errors.codemap.promptOutputResult', {}, req.locale)}`,
        ].join('\n');
      }

      const summary = await generateTextWithDefaultProvider(prompt);
      aiSummaryCache.set(cacheKey, summary);
      while (aiSummaryCache.size > 200) {
        const k = aiSummaryCache.keys().next().value;
        if (k !== undefined) aiSummaryCache.delete(k); else break;
      }
      res.json({ summary, cached: false });
    } catch (err) {
      const isNoProvider = err instanceof Error && err.message.includes('No default AI provider');
      if (isNoProvider) {
        res.status(501).json({ error: t('errors.auto_9d995b', {}, req.locale) });
        return;
      }
      console.error('[code-map] AI summary error:', err);
      res.status(500).json({ error: t('errors.auto_741cff', {}, req.locale) });
    }
  });

  interface AnalysisProfile {
    maxSyms: number;
    maxDeps: number;
    maxRelatedSyms: number;
    sigMaxLen: number;
    maxTokens: number;
  }

  function pickFileProfile(lineCount: number, symbolCount: number): AnalysisProfile {
    if (lineCount <= 100 && symbolCount <= 10) {
      return { maxSyms: 10, maxDeps: 8, maxRelatedSyms: 3, sigMaxLen: 80, maxTokens: 1536 };
    }
    if (lineCount <= 500 && symbolCount <= 30) {
      return { maxSyms: 20, maxDeps: 12, maxRelatedSyms: 4, sigMaxLen: 100, maxTokens: 2560 };
    }
    return { maxSyms: 30, maxDeps: 15, maxRelatedSyms: 5, sigMaxLen: 120, maxTokens: 3584 };
  }

  function truncSig(sig: string, max: number): string {
    if (sig.length <= max) return sig;
    const parenIdx = sig.indexOf('(');
    if (parenIdx > 0 && parenIdx < max) {
      const closeIdx = sig.indexOf(')', parenIdx);
      if (closeIdx > 0 && closeIdx <= max + 20) return sig.slice(0, closeIdx + 1);
    }
    return sig.slice(0, max) + '...';
  }

  function buildAnalysisContext(
    snapshot: CodeMapSnapshot,
    filePath: string | null,
    dirPath: string | null,
    locale?: string,
  ): { context: string; profile: AnalysisProfile } | null {
    if (filePath) {
      const file = snapshot.files.find((f) => f.relativePath === filePath);
      if (!file) return null;
      const profile = pickFileProfile(file.lineCount, file.symbols.length);
      const topSyms = [...file.symbols].sort((a, b) => b.rank - a.rank).slice(0, profile.maxSyms);
      const depEdges = snapshot.edges.filter((e) => e.fromFile === filePath).slice(0, profile.maxDeps);
      const refEdges = snapshot.edges.filter((e) => e.toFile === filePath).slice(0, profile.maxDeps);

      const lines: string[] = [
        t(
          'errors.codemap.targetFile',
          { path: file.relativePath, language: file.language, lines: file.lineCount },
          locale,
        ),
        t('errors.codemap.symbolList', {}, locale),
        ...topSyms.map((s) => `  - [${s.kind}] ${s.name} (${t('errors.codemap.line', { line: s.line }, locale)}) ${truncSig(s.signature, profile.sigMaxLen)}`),
      ];

      if (depEdges.length > 0) {
        lines.push('', t('errors.auto_dcdda6', {}, locale));
        for (const e of depEdges) {
          const depFile = snapshot.files.find((f) => f.relativePath === e.toFile);
          const symsStr = e.symbols.length > 0 ? ` (${t('errors.codemap.referenced', {}, locale)}: ${e.symbols.join(', ')})` : '';
          if (depFile) {
            const depSyms = [...depFile.symbols].sort((a, b) => b.rank - a.rank).slice(0, profile.maxRelatedSyms);
            lines.push(`  ${e.toFile}${symsStr}`);
            lines.push(`    ${t('errors.codemap.keySymbols', {}, locale)}: ${depSyms.map((s) => `[${s.kind}] ${s.name} (${t('errors.codemap.line', { line: s.line }, locale)})`).join(', ')}`);
          } else {
            lines.push(`  ${e.toFile}${symsStr}`);
          }
        }
      }

      if (refEdges.length > 0) {
        lines.push('', t('errors.auto_b27af6', {}, locale));
        for (const e of refEdges) {
          const refFile = snapshot.files.find((f) => f.relativePath === e.fromFile);
          const symsStr = e.symbols.length > 0 ? ` (${t('errors.codemap.referenced', {}, locale)}: ${e.symbols.join(', ')})` : '';
          if (refFile) {
            const refSyms = [...refFile.symbols].sort((a, b) => b.rank - a.rank).slice(0, profile.maxRelatedSyms);
            lines.push(`  ${e.fromFile}${symsStr}`);
            lines.push(`    ${t('errors.codemap.keySymbols', {}, locale)}: ${refSyms.map((s) => `[${s.kind}] ${s.name} (${t('errors.codemap.line', { line: s.line }, locale)})`).join(', ')}`);
          } else {
            lines.push(`  ${e.fromFile}${symsStr}`);
          }
        }
      }

      if (depEdges.length + refEdges.length > 0) {
        lines.push('', t('errors.auto_c2217b', {}, locale));
        for (const e of depEdges) lines.push(`  ${filePath} → ${e.toFile} (${e.symbols.join(', ') || t('errors.codemap.importedVia', {}, locale)})`);
        for (const e of refEdges) lines.push(`  ${e.fromFile} → ${filePath} (${e.symbols.join(', ') || t('errors.codemap.importedVia', {}, locale)})`);
      }

      return { context: lines.filter(Boolean).join('\n'), profile };
    }

    if (dirPath) {
      const dirFiles = snapshot.files.filter((f) => f.relativePath.startsWith(dirPath + '/'));
      if (dirFiles.length === 0) return null;
      const profile: AnalysisProfile = dirFiles.length <= 5
        ? { maxSyms: 15, maxDeps: 10, maxRelatedSyms: 3, sigMaxLen: 80, maxTokens: 2048 }
        : { maxSyms: 20, maxDeps: 15, maxRelatedSyms: 4, sigMaxLen: 80, maxTokens: 3584 };
      const topFiles = [...dirFiles].sort((a, b) => b.rank - a.rank).slice(0, 12);
      const internalEdges = snapshot.edges.filter(
        (e) => e.fromFile.startsWith(dirPath + '/') && e.toFile.startsWith(dirPath + '/'),
      ).slice(0, 20);
      const externalDeps = snapshot.edges.filter(
        (e) => e.fromFile.startsWith(dirPath + '/') && !e.toFile.startsWith(dirPath + '/'),
      ).slice(0, 15);
      const externalRefs = snapshot.edges.filter(
        (e) => !e.fromFile.startsWith(dirPath + '/') && e.toFile.startsWith(dirPath + '/'),
      ).slice(0, 15);

      const lines: string[] = [
        t('errors.codemap.targetDirectory', { dirPath, count: dirFiles.length }, locale),
        t('errors.auto_ef6a77', {}, locale),
        ...topFiles.map((f) => {
          const syms = [...f.symbols].sort((a, b) => b.rank - a.rank).slice(0, 5);
          return `  - ${f.relativePath} (${f.language}, ${t('errors.codemap.lineCount', { count: f.lineCount }, locale)})\n    ${t('errors.codemap.labelSymbols', {}, locale)} ${syms.map((s) => `[${s.kind}] ${s.name} (${t('errors.codemap.line', { line: s.line }, locale)})`).join(', ')}`;
        }),
      ];
      if (internalEdges.length > 0) {
        lines.push('', t('errors.auto_e30528', {}, locale));
        for (const e of internalEdges) lines.push(`  ${e.fromFile} → ${e.toFile} (${e.symbols.join(', ') || t('errors.codemap.importedVia', {}, locale)})`);
      }
      if (externalDeps.length > 0) {
        lines.push('', t('errors.auto_682aff', {}, locale));
        for (const e of externalDeps) {
          const depFile = snapshot.files.find((f) => f.relativePath === e.toFile);
          if (depFile) {
            const syms = [...depFile.symbols].sort((a, b) => b.rank - a.rank).slice(0, 3);
            lines.push(`  → ${e.toFile}: ${syms.map((s) => `[${s.kind}] ${s.name}`).join(', ')}`);
          } else {
            lines.push(`  → ${e.toFile}`);
          }
        }
      }
      if (externalRefs.length > 0) {
        lines.push('', t('errors.auto_d5feae', {}, locale));
        for (const e of externalRefs) lines.push(`  ← ${e.fromFile}`);
      }
      return { context: lines.filter(Boolean).join('\n'), profile };
    }

    return null;
  }

  function buildAnalysisPromptTemplate(locale?: string): string {
    return [
      t('errors.codemap.analysisPromptIntro', {}, locale),
      '',
      t('errors.codemap.analysisPromptRequirements', {}, locale),
      `1. ${t('errors.codemap.analysisReqTarget', {}, locale)}`,
      `2. ${t('errors.codemap.analysisReqStructure', { viewA: t('errors.auto_a94b22', {}, locale), viewB: t('errors.auto_c32ead', {}, locale) }, locale)}`,
      `3. ${t('errors.codemap.analysisReqCodeRefs', {}, locale)}`,
      `4. ${t('errors.codemap.analysisReqLocalizedText', {}, locale)}`,
      `5. ${t('errors.codemap.analysisReqFunctionalTitle', {}, locale)}`,
      `6. ${t('errors.codemap.analysisReqDescription', {}, locale)}`,
      '',
      t('errors.codemap.analysisPromptSchema', {}, locale),
      '{',
      `  "title": "${t('errors.auto_0bb33b', {}, locale)}",`,
      `  "summary": "${t('errors.auto_dafcc9', {}, locale)}",`,
      '  "sections": [',
      '    {',
      `      "id": "${t('errors.auto_9c08f7', {}, locale)}",`,
      `      "title": "${t('errors.auto_f3918c', {}, locale)}",`,
      `      "description": "${t('errors.auto_2b9361', {}, locale)}",`,
      '      "codeRefs": [',
      `        { "file": "${t('errors.auto_079ff7', {}, locale)}", "line": number, "snippet": "${t('errors.auto_cc8616', {}, locale)}", "label": "${t('errors.auto_ade865', {}, locale)}" }`,
      '      ],',
      `      "children": [ ${t('errors.codemap.analysisPromptChildrenHint', {}, locale)} ]`,
      '    }',
      '  ]',
      '}',
      '',
      t('errors.codemap.analysisPromptContext', {}, locale),
      '',
    ].join('\n');
  }

  app.post('/api/code-map/:repositoryId/ai-analysis', guard, async (req, res) => {
    try {
      const repositoryId = decodeURIComponent(String(req.params.repositoryId || ''));
      const repo = await requireRepositoryAccess(req, res, repositoryId);
      if (!repo) return;

      const branch = String(req.query.branch || req.body?.branch || '').trim() || resolveDefaultBranch(repo);
      const filePath: string = String(req.body?.filePath || '').trim();
      const dirPath: string = String(req.body?.dirPath || '').trim();
      const forceRefresh: boolean = !!req.body?.forceRefresh;
      if (!filePath && !dirPath) {
        res.status(400).json({ error: t('errors.auto_3032c9', {}, req.locale) });
        return;
      }

      const snapshot = await loadSnapshot(repositoryId, branch);
      if (!snapshot) {
        res.status(404).json({ error: t('errors.auto_c0c012', {}, req.locale) });
        return;
      }

      const targetPath = filePath || dirPath;
      const targetType = filePath ? 'file' : 'dir';
      const cacheOnly: boolean = !!req.body?.cacheOnly;

      if (!forceRefresh) {
        const memCacheKey = `analysis\0${repositoryId}\0${branch}\0${targetPath}\0${snapshot.manifestHash}`;
        const memCached = aiAnalysisCache.get(memCacheKey);
        if (memCached) { res.json({ analysis: memCached, cached: true }); return; }

        const dbCached = await getCodeMapAiAnalysis(repositoryId, branch, targetPath, snapshot.manifestHash);
        if (dbCached) {
          try {
            const parsed = JSON.parse(dbCached.analysis_json);
            aiAnalysisCache.set(memCacheKey, parsed);
            res.json({ analysis: parsed, cached: true });
            return;
          } catch { /* corrupt record, regenerate */ }
        }
      }

      if (cacheOnly) {
        res.json({ analysis: null, cached: false });
        return;
      }

      const analysisCtx = buildAnalysisContext(
        snapshot,
        filePath || null,
        dirPath || null,
        req.locale,
      );
      if (!analysisCtx) {
        res.status(404).json({ error: filePath ? t('errors.auto_b831d6', {}, req.locale) : t('errors.auto_910524', {}, req.locale) });
        return;
      }

      const { context: contextBlock, profile } = analysisCtx;
      const prompt =
        buildAnalysisPromptTemplate(req.locale)
        + contextBlock
        + t('errors.auto_f08666', {}, req.locale);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const sendSSE = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      let aborted = false;
      req.on('close', () => { aborted = true; });

      sendSSE('status', { message: t('errors.auto_acfbe7', {}, req.locale) });

      try {
        const stream = await generateTextStreamWithDefaultProvider(prompt, {
          maxTokens: profile.maxTokens,
          systemPrompt: 'Return only valid JSON. No markdown wrapping.',
        });

        sendSSE('status', { message: t('errors.auto_4d2bb7', {}, req.locale) });

        let fullText = '';
        for await (const chunk of stream) {
          if (aborted) break;
          fullText += chunk;
          sendSSE('chunk', { text: chunk });
        }

        if (aborted) { res.end(); return; }

        let analysis: AiAnalysis;
        try {
          const cleaned = fullText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
          analysis = JSON.parse(cleaned);
        } catch {
          analysis = { title: targetPath, summary: fullText.slice(0, 300), sections: [] };
        }

        const memCacheKey = `analysis\0${repositoryId}\0${branch}\0${targetPath}\0${snapshot.manifestHash}`;
        aiAnalysisCache.set(memCacheKey, analysis);
        while (aiAnalysisCache.size > 100) {
          const k = aiAnalysisCache.keys().next().value;
          if (k !== undefined) aiAnalysisCache.delete(k); else break;
        }

        const id = `cma_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        saveCodeMapAiAnalysis({
          id,
          repository_id: repositoryId,
          branch,
          target_path: targetPath,
          target_type: targetType,
          manifest_hash: snapshot.manifestHash,
          analysis_json: JSON.stringify(analysis),
          created_at: new Date().toISOString(),
        }).then(() => pruneCodeMapAiAnalyses(repositoryId, 200)).catch((e) => {
          console.error('[code-map] Failed to persist AI analysis:', e);
        });

        sendSSE('done', { analysis, cached: false });
      } catch (err) {
        const isNoProvider = err instanceof Error && err.message.includes('No default AI provider');
        sendSSE('error', {
          message: isNoProvider ? t('errors.auto_1c62f2', {}, req.locale) : t('errors.auto_ef3e0d', {}, req.locale),
        });
        if (!isNoProvider) console.error('[code-map] AI analysis stream error:', err);
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        const isNoProvider = err instanceof Error && err.message.includes('No default AI provider');
        if (isNoProvider) {
          res.status(501).json({ error: t('errors.auto_1c62f2', {}, req.locale) });
          return;
        }
        console.error('[code-map] AI analysis error:', err);
        res.status(500).json({ error: t('errors.auto_ef3e0d', {}, req.locale) });
      }
    }
  });

  app.get('/api/code-map/:repositoryId/file-content', guard, async (req, res) => {
    try {
      const repositoryId = decodeURIComponent(String(req.params.repositoryId || ''));
      const repo = await requireRepositoryAccess(req, res, repositoryId);
      if (!repo) return;

      const branch = String(req.query.branch || '').trim() || resolveDefaultBranch(repo);
      const filePath = String(req.query.file || '').trim();
      if (!filePath) { res.status(400).json({ error: t('errors.auto_369996', {}, req.locale) }); return; }

      let rootDir = await resolveCodeMapRootDirectory(repo, branch);
      if (!rootDir) {
        const cloneUrl = repo.clone_url || undefined;
        const recovered = await acquireWorktree({ repositoryId, branch, cloneUrl, purpose: 'codemap' });
        if (recovered) rootDir = recovered;
      }
      if (!rootDir) {
        res.status(404).json({ error: t('errors.auto_b4ea78', {}, req.locale) });
        return;
      }

      const absPath = safeRelativePath(rootDir, filePath);
      if (!absPath) {
        res.status(400).json({ error: t('errors.auto_640680', {}, req.locale) });
        return;
      }

      let content: string;
      try {
        const stat = fs.statSync(absPath);
        if (stat.size > 512 * 1024) {
          res.status(413).json({ error: t('errors.auto_1c8479', {}, req.locale) });
          return;
        }
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        res.status(404).json({ error: t('live2d.fileNotFound', {}, req.locale) });
        return;
      }

      const lines = content.split('\n');
      res.json({
        content,
        language: detectLanguageFromExt(filePath),
        lineCount: lines.length,
        filePath,
      });
    } catch (err) {
      res.status(500).json({
        error: t('errors.auto_8b9c9b', {}, req.locale),
      });
    }
  });

  app.get('/api/code-map/:repositoryId/repo-description', guard, async (req, res) => {
    try {
      const repositoryId = decodeURIComponent(String(req.params.repositoryId || ''));
      const repo = await requireRepositoryAccess(req, res, repositoryId);
      if (!repo) return;

      const branch = String(req.query.branch || '').trim() || resolveDefaultBranch(repo);
      const snapshot = await loadSnapshot(repositoryId, branch);
      if (!snapshot) { res.status(404).json({ error: t('errors.auto_c0c012', {}, req.locale) }); return; }

      const cacheKey = `repo-desc\0${repositoryId}\0${branch}\0${snapshot.manifestHash}`;
      const memCached = repoDescriptionCache.get(cacheKey);
      if (memCached) { res.json({ description: memCached, cached: true }); return; }

      const dbCached = await getCodeMapAiAnalysis(repositoryId, branch, '', snapshot.manifestHash);
      if (dbCached) {
        try {
          const parsed = JSON.parse(dbCached.analysis_json) as RepoDescription;
          repoDescriptionCache.set(cacheKey, parsed);
          res.json({ description: parsed, cached: true });
          return;
        } catch { /* corrupt record, fall through */ }
      }

      res.json({ description: null, cached: false });
    } catch (err) {
      console.error('[code-map] repo-description GET error:', err);
      res.status(500).json({ error: t('errors.auto_c43130', {}, req.locale) });
    }
  });

  app.post('/api/code-map/:repositoryId/repo-description', manageGuard, async (req, res) => {
    try {
      const repositoryId = decodeURIComponent(String(req.params.repositoryId || ''));
      const repo = await requireRepositoryAccess(req, res, repositoryId, 'manager');
      if (!repo) return;

      const branch = String(req.query.branch || req.body?.branch || '').trim() || resolveDefaultBranch(repo);
      const forceRefresh = !!req.body?.forceRefresh;

      const snapshot = await loadSnapshot(repositoryId, branch);
      if (!snapshot) { res.status(404).json({ error: t('errors.auto_c0c012', {}, req.locale) }); return; }

      const cacheKey = `repo-desc\0${repositoryId}\0${branch}\0${snapshot.manifestHash}`;

      if (!forceRefresh) {
        const memCached = repoDescriptionCache.get(cacheKey);
        if (memCached) { res.json({ description: memCached, cached: true }); return; }

        const dbCached = await getCodeMapAiAnalysis(repositoryId, branch, '', snapshot.manifestHash);
        if (dbCached) {
          try {
            const parsed = JSON.parse(dbCached.analysis_json) as RepoDescription;
            repoDescriptionCache.set(cacheKey, parsed);
            res.json({ description: parsed, cached: true });
            return;
          } catch { /* corrupt record, regenerate */ }
        }
      }

      let rootDir = await resolveCodeMapRootDirectory(repo, branch);
      if (!rootDir) {
        const cloneUrl = repo.clone_url || undefined;
        const recovered = await acquireWorktree({ repositoryId, branch, cloneUrl, purpose: 'codemap' });
        if (recovered) rootDir = recovered;
      }
      if (!rootDir) {
        const modules = identifyModules(snapshot);
        const entryPoints = identifyEntryPoints(snapshot);
        const langStats = computeLanguageStats(snapshot);
        const fallback: RepoDescription = {
          repositoryId, branch, manifestHash: snapshot.manifestHash,
          overview: '', techStack: [], architecture: '',
          modules: modules.map((m) => ({ ...m, description: '' })),
          entryPoints,
          stats: { languages: langStats, totalFiles: snapshot.stats.fileCount, totalLines: snapshot.stats.totalLines, totalSymbols: snapshot.stats.symbolCount },
          generatedAt: new Date().toISOString(),
        };
        res.json({ description: fallback, cached: false });
        return;
      }

      const prompt = buildRepoDescriptionPrompt(snapshot, rootDir);

      let aiText: string;
      try {
        aiText = await generateTextWithDefaultProvider(prompt);
      } catch (err) {
        const isNoProvider = err instanceof Error && err.message.includes('No default AI provider');
        if (isNoProvider) {
          const modules = identifyModules(snapshot);
          const entryPoints = identifyEntryPoints(snapshot);
          const techStack = extractTechStack(rootDir);
          const langStats = computeLanguageStats(snapshot);
          const noAiDesc: RepoDescription = {
            repositoryId, branch, manifestHash: snapshot.manifestHash,
            overview: '', techStack, architecture: '',
            modules: modules.map((m) => ({ ...m, description: '' })),
            entryPoints,
            stats: { languages: langStats, totalFiles: snapshot.stats.fileCount, totalLines: snapshot.stats.totalLines, totalSymbols: snapshot.stats.symbolCount },
            generatedAt: new Date().toISOString(),
          };
          res.json({ description: noAiDesc, cached: false, noAi: true });
          return;
        }
        throw err;
      }

      let aiResult: { overview: string; architecture: string; modules: Array<{ name: string; directory: string; description: string }> };
      try {
        const cleaned = aiText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        aiResult = JSON.parse(cleaned);
      } catch {
        aiResult = {
          overview: t(
            'errors.codemap.invalidJsonResult',
            { excerpt: aiText.slice(0, 250) },
            req.locale,
          ),
          architecture: '',
          modules: [],
        };
      }

      const description = assembleRepoDescription(snapshot, rootDir, aiResult);

      repoDescriptionCache.set(cacheKey, description);
      while (repoDescriptionCache.size > 50) {
        const k = repoDescriptionCache.keys().next().value;
        if (k !== undefined) repoDescriptionCache.delete(k); else break;
      }

      const id = `cma_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      upsertCodeMapAiAnalysis({
        id,
        repository_id: repositoryId,
        branch,
        target_path: '',
        target_type: 'repo-description',
        manifest_hash: snapshot.manifestHash,
        analysis_json: JSON.stringify(description),
        created_at: new Date().toISOString(),
      }).then(() => pruneCodeMapAiAnalyses(repositoryId, 200)).catch((e) => {
        console.error('[code-map] Failed to persist repo description:', e);
      });

      res.json({ description, cached: false });
    } catch (err) {
      console.error('[code-map] repo-description POST error:', err);
      res.status(500).json({ error: t('errors.auto_a197fe', {}, req.locale) });
    }
  });

  app.get('/api/code-map/:repositoryId/summary', guard, async (req, res) => {
    try {
      const repositoryId = decodeURIComponent(String(req.params.repositoryId || ''));
      const repo = await requireRepositoryAccess(req, res, repositoryId);
      if (!repo) return;

      const branch = String(req.query.branch || '').trim() || resolveDefaultBranch(repo);
      const snapshot = await loadSnapshot(repositoryId, branch);

      if (!snapshot) {
        res.status(404).json({ error: t('errors.auto_23250d', {}, req.locale) });
        return;
      }

      const topN = Math.min(Number(req.query.topN) || 10, 100);
      res.type('text/plain').send(renderCodeMapSummary(snapshot, topN));
    } catch (err) {
      res.status(500).json({
        error: t('errors.auto_0e27ba', {}, req.locale),
      });
    }
  });
}
