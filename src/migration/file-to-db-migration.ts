import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { getConfig, setConfig, upsertMemoryDocuments } from '../db.js';
import { saveDirectoryToFileStore } from '../web/file-store-service.js';
import { logger } from '../logger.js';
import { listIndexedMemoryFiles } from '../memory/document-indexing.js';

const MIGRATION_KEY = 'FILE_TO_DB_MIGRATED';

export async function shouldRunFileToDbMigration(): Promise<boolean> {
  const value = await getConfig(MIGRATION_KEY);
  return value !== 'true';
}

export async function runFileToDbMigration(): Promise<{
  memoryFiles: number;
  skills: number;
  mcpServers: number;
  extensions: number;
}> {
  const report = { memoryFiles: 0, skills: 0, mcpServers: 0, extensions: 0 };

  report.memoryFiles = await migrateMemoryFiles();
  report.skills = await migrateDirectory('skill', path.join(DATA_DIR, 'custom-skills'));
  report.mcpServers = await migrateDirectory('mcp-server', path.join(DATA_DIR, 'mcp-servers'));
  report.extensions = await migrateDirectory('extension', path.join(DATA_DIR, 'extensions'));

  await setConfig(MIGRATION_KEY, 'true');
  logger.info(report, 'File-to-DB migration complete');
  return report;
}

async function migrateMemoryFiles(): Promise<number> {
  let count = 0;

  const groupsDir = GROUPS_DIR;
  if (!fs.existsSync(groupsDir)) return count;

  let groupFolders: string[];
  try {
    groupFolders = fs.readdirSync(groupsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return count;
  }

  for (const folder of groupFolders) {
    const isGlobal = folder === 'global';
    const scope = isGlobal ? 'global' : 'group';
    const files = listIndexedMemoryFiles(scope, { groupFolder: folder });

    for (const file of files) {
      try {
        if (!fs.existsSync(file.absolutePath)) continue;
        const body = fs.readFileSync(file.absolutePath, 'utf-8');
        if (!body.trim()) continue;

        await upsertMemoryDocuments([
          {
            doc_id: `memory-file:${file.pathRef}`,
            scope: file.scope,
            owner_type: isGlobal ? 'global' : 'group',
            owner_id: isGlobal ? 'global' : folder,
            path_ref: file.pathRef,
            source_type: 'memory_file',
            title: file.relPath,
            body,
            metadata_json: JSON.stringify({
              relPath: file.relPath,
              scope: file.scope,
              migrated: true,
            }),
            updated_at: new Date().toISOString(),
          },
        ]);
        count++;
      } catch (err) {
        logger.warn(
          { err, pathRef: file.pathRef },
          'Migration: failed to import memory file',
        );
      }
    }
  }

  return count;
}

async function migrateDirectory(
  category: 'skill' | 'mcp-server' | 'extension',
  rootDir: string,
): Promise<number> {
  if (!fs.existsSync(rootDir)) return 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const entryDir = path.join(rootDir, entry.name);
    try {
      const saved = await saveDirectoryToFileStore({
        category,
        basePathRef: entry.name,
        diskRoot: entryDir,
      });
      count += saved;
    } catch (err) {
      logger.warn(
        { err, category, id: entry.name },
        'Migration: failed to import directory',
      );
    }
  }

  return count;
}
