import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { listAllMemoryDocumentsForHydration } from '../db.js';
import {
  hydrateFileStoreCategory,
  type FileStoreCategory,
} from '../web/file-store-service.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import type { MemoryDocumentRecord } from '../types.js';
import { hydrateUserMcpServersToDisk } from '../user/user-mcp-service.js';
import { hydrateUserSkillsToDisk } from '../user/user-skill-service.js';
import {
  shouldRunMcpSkillsMigration,
  runMcpSkillsMigration,
} from '../migration/mcp-skills-migration.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';

export interface HydrationReport {
  memoryFiles: number;
  storeFiles: number;
  skipped: number;
  errors: number;
  elapsedMs: number;
}

const PAGE_SIZE = 500;

/** Users whose private MCP/skills have been synced to disk at least once this process. */
export const hydratedUsers = new Set<string>();

/**
 * Lazily hydrates per-user MCP and skill rows from the DB to disk on first use.
 * Startup only hydrates shared + `__system__` rows; call this before reads that depend on disk.
 */
export async function ensureUserHydrated(userId: string): Promise<void> {
  if (hydratedUsers.has(userId)) return;
  await hydrateUserMcpServersToDisk({ userId });
  await hydrateUserSkillsToDisk({ userId });
  hydratedUsers.add(userId);
}

function resolveMemoryFilePath(
  doc: MemoryDocumentRecord,
): string | null {
  const pathRef = doc.path_ref;
  if (!pathRef) return null;

  const colonIndex = pathRef.indexOf(':');
  if (colonIndex < 0) return null;

  const scope = pathRef.slice(0, colonIndex);
  const relPath = pathRef.slice(colonIndex + 1);
  if (!relPath) return null;

  let rootDir: string;
  if (scope === 'group') {
    const ownerId = doc.owner_id;
    if (!ownerId || ownerId === 'global') return null;
    try {
      rootDir = resolveGroupFolderPath(ownerId);
    } catch {
      rootDir = path.join(GROUPS_DIR, ownerId);
    }
  } else {
    rootDir = path.join(GROUPS_DIR, 'global');
  }

  return path.join(rootDir, ...relPath.split('/'));
}

function shouldOverwrite(targetPath: string, doc: MemoryDocumentRecord): boolean {
  if (process.env.NANOCLAW_FORCE_HYDRATE === 'true') return true;
  if (!fs.existsSync(targetPath)) return true;

  try {
    const stat = fs.statSync(targetPath);
    const docDate = new Date(doc.updated_at);
    if (!Number.isNaN(docDate.getTime()) && docDate > stat.mtime) return true;
  } catch {
    return true;
  }
  return false;
}

async function hydrateMemoryDocuments(): Promise<{
  files: number;
  skipped: number;
  errors: number;
}> {
  let files = 0;
  let skipped = 0;
  let errors = 0;
  let offset = 0;

  for (;;) {
    const docs = await listAllMemoryDocumentsForHydration({
      limit: PAGE_SIZE,
      offset,
    });
    if (docs.length === 0) break;

    for (const doc of docs) {
      const targetPath = resolveMemoryFilePath(doc);
      if (!targetPath) {
        skipped++;
        continue;
      }
      if (!shouldOverwrite(targetPath, doc)) {
        skipped++;
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, doc.body, 'utf-8');
        files++;
      } catch (err) {
        errors++;
        logger.warn(
          { err, pathRef: doc.path_ref },
          'Hydration: failed to write memory file',
        );
      }
    }

    offset += docs.length;
    if (docs.length < PAGE_SIZE) break;
  }

  return { files, skipped, errors };
}

/**
 * Replay DB-persisted memory documents (and later file_store entries)
 * back to the filesystem. Called once at startup, after initDatabase()
 * but before loadState().
 */
export async function hydrateFileSystemFromDb(): Promise<HydrationReport> {
  const start = Date.now();
  const report: HydrationReport = {
    memoryFiles: 0,
    storeFiles: 0,
    skipped: 0,
    errors: 0,
    elapsedMs: 0,
  };

  const memResult = await hydrateMemoryDocuments();
  report.memoryFiles = memResult.files;
  report.skipped += memResult.skipped;
  report.errors += memResult.errors;

  const categoryMap: Array<{
    category: FileStoreCategory;
    resolver: (pathRef: string) => string;
  }> = [
    {
      category: 'skill',
      resolver: (ref) => path.join(DATA_DIR, 'custom-skills', ...ref.split('/')),
    },
    {
      category: 'mcp-server',
      resolver: (ref) => path.join(DATA_DIR, 'mcp-servers', ...ref.split('/')),
    },
    {
      category: 'extension',
      resolver: (ref) => path.join(DATA_DIR, 'extensions', ...ref.split('/')),
    },
  ];

  for (const { category, resolver } of categoryMap) {
    try {
      const result = await hydrateFileStoreCategory(category, resolver);
      report.storeFiles += result.written;
      report.skipped += result.skipped;
      report.errors += result.errors;
    } catch (err) {
      logger.warn({ err, category }, 'file_store hydration failed for category');
    }
  }

  // Run MCP/Skills v2 migration if needed
  try {
    if (await shouldRunMcpSkillsMigration()) {
      const migResult = await runMcpSkillsMigration();
      logger.info(migResult, 'MCP/Skills v2 migration executed during hydration');
    }
  } catch (err) {
    logger.warn({ err }, 'MCP/Skills v2 migration failed');
    report.errors++;
  }

  // Hydrate shared + __system__ MCP/skills only; per-user rows hydrate on first access
  try {
    const mcpCount = await hydrateUserMcpServersToDisk({ sharedAndSystemOnly: true });
    const skillCount = await hydrateUserSkillsToDisk({ sharedAndSystemOnly: true });
    report.storeFiles += mcpCount + skillCount;
    hydratedUsers.add(SYSTEM_USER_ID);
    logger.info({ mcpCount, skillCount }, 'Shared/system user MCP/Skills hydrated to disk');
  } catch (err) {
    logger.warn({ err }, 'User MCP/Skills hydration failed');
    report.errors++;
  }

  report.elapsedMs = Date.now() - start;
  logger.info(
    {
      memoryFiles: report.memoryFiles,
      storeFiles: report.storeFiles,
      skipped: report.skipped,
      errors: report.errors,
      elapsedMs: report.elapsedMs,
    },
    'Filesystem hydration from DB complete',
  );
  return report;
}
