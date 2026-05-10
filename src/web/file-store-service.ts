import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  upsertFileStoreEntry,
  listFileStoreEntries,
  getFileStoreEntry,
  deleteFileStoreEntry,
} from '../db.js';
import { logger } from '../logger.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';

export type FileStoreCategory =
  | 'skill'
  | 'mcp-server'
  | 'extension'
  | 'agent-config';

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Save a text file to the file_store DB table and optionally write it to disk.
 */
export async function saveToFileStore(input: {
  category: FileStoreCategory;
  pathRef: string;
  content: string;
  diskPath?: string;
  metadata?: Record<string, unknown>;
  userId?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await upsertFileStoreEntry({
    category: input.category,
    path_ref: input.pathRef,
    content: input.content,
    content_hash: contentHash(input.content),
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
    user_id: input.userId || getCurrentUserId(),
    created_at: now,
    updated_at: now,
  });

  if (input.diskPath) {
    try {
      fs.mkdirSync(path.dirname(input.diskPath), { recursive: true });
      fs.writeFileSync(input.diskPath, input.content, 'utf-8');
    } catch (err) {
      logger.warn(
        { err, diskPath: input.diskPath },
        'file-store: failed to write to disk',
      );
    }
  }
}

export async function getFromFileStore(
  category: FileStoreCategory,
  pathRef: string,
  userId?: string,
) {
  return getFileStoreEntry(category, pathRef, userId);
}

export async function removeFromFileStore(
  category: FileStoreCategory,
  pathRef: string,
  userId?: string,
) {
  return deleteFileStoreEntry(category, pathRef, userId);
}

/**
 * Walk a directory tree and save all text files to file_store.
 * Binary files are skipped.
 */
export async function saveDirectoryToFileStore(input: {
  category: FileStoreCategory;
  basePathRef: string;
  diskRoot: string;
  metadata?: Record<string, unknown>;
  userId?: string;
}): Promise<number> {
  let count = 0;
  const entries = walkTextFiles(input.diskRoot, input.diskRoot);
  const now = new Date().toISOString();
  for (const { relPath, content } of entries) {
    const pathRef = `${input.basePathRef}/${relPath}`;
    await upsertFileStoreEntry({
      category: input.category,
      path_ref: pathRef,
      content,
      content_hash: contentHash(content),
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
      user_id: input.userId || getCurrentUserId(),
      created_at: now,
      updated_at: now,
    });
    count++;
  }
  return count;
}

function walkTextFiles(
  dir: string,
  baseDir: string,
): Array<{ relPath: string; content: string }> {
  const results: Array<{ relPath: string; content: string }> = [];
  if (!fs.existsSync(dir)) return results;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      results.push(...walkTextFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > 1024 * 1024) continue; // skip files > 1MB
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (content.includes('\0')) continue; // likely binary
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        results.push({ relPath, content });
      } catch {
        continue;
      }
    }
  }
  return results;
}

export async function removeFileStoreByPrefix(
  category: FileStoreCategory,
  pathRefPrefix: string,
  userId?: string,
): Promise<void> {
  const entries = await listFileStoreEntries({ category, userId });
  for (const entry of entries) {
    if (entry.path_ref.startsWith(pathRefPrefix)) {
      await deleteFileStoreEntry(category, entry.path_ref, userId || getCurrentUserId());
    }
  }
}

/**
 * Replay all entries of a given category from DB to disk.
 * Returns the number of files written.
 */
export async function hydrateFileStoreCategory(
  category: FileStoreCategory,
  resolveDiskPath: (pathRef: string) => string,
): Promise<{ written: number; skipped: number; errors: number }> {
  let written = 0;
  let skipped = 0;
  let errors = 0;
  let offset = 0;
  const pageSize = 500;

  for (;;) {
    const entries = await listFileStoreEntries({
      category,
      limit: pageSize,
      offset,
    });
    if (entries.length === 0) break;

    for (const entry of entries) {
      const diskPath = resolveDiskPath(entry.path_ref);
      try {
        if (fs.existsSync(diskPath)) {
          const existing = fs.readFileSync(diskPath, 'utf-8');
          if (contentHash(existing) === entry.content_hash) {
            skipped++;
            continue;
          }
        }
        fs.mkdirSync(path.dirname(diskPath), { recursive: true });
        fs.writeFileSync(diskPath, entry.content, 'utf-8');
        written++;
      } catch (err) {
        errors++;
        logger.warn(
          { err, category, pathRef: entry.path_ref },
          'file-store hydration: failed to write',
        );
      }
    }

    offset += entries.length;
    if (entries.length < pageSize) break;
  }

  return { written, skipped, errors };
}
