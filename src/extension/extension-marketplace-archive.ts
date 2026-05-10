import fs from 'fs';
import os from 'os';
import path from 'path';

import JSZip from 'jszip';
import * as tar from 'tar';

import type { ResolvedBundleSource } from './extension-marketplace-types.js';
import {
  BLOCKED_TAR_ENTRY_TYPES,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_EXTRACTED_BYTES,
  MAX_ARCHIVE_ENTRY_BYTES,
  resolveArchiveKind,
} from './extension-marketplace-types.js';
import {
  deriveSuggestedNameFromPath,
  resolveBundleRootFromPath,
} from './extension-marketplace-bundle.js';

function normalizeArchiveEntryPath(entryPath: string): string | null {
  const normalized = entryPath.replace(/\\/g, '/').trim();
  if (!normalized || normalized.endsWith('/')) {
    return null;
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`archive entry escapes root: ${entryPath}`);
  }
  const clean = path.posix.normalize(normalized);
  if (
    clean === '' ||
    clean === '.' ||
    clean === '..' ||
    clean.startsWith('../')
  ) {
    throw new Error(`archive entry escapes root: ${entryPath}`);
  }
  return clean;
}

function assertArchiveBudget(params: {
  archiveBytes?: number;
  entryCount: number;
  extractedBytes: number;
  entryBytes?: number;
}): void {
  if (
    typeof params.archiveBytes === 'number' &&
    params.archiveBytes > MAX_ARCHIVE_BYTES
  ) {
    throw new Error('archive size exceeds limit');
  }
  if (params.entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error('archive entry count exceeds limit');
  }
  if (
    typeof params.entryBytes === 'number' &&
    params.entryBytes > MAX_ARCHIVE_ENTRY_BYTES
  ) {
    throw new Error('archive entry extracted size exceeds limit');
  }
  if (params.extractedBytes > MAX_ARCHIVE_EXTRACTED_BYTES) {
    throw new Error('archive extracted size exceeds limit');
  }
}

async function extractZipArchive(params: {
  archivePath: string;
  extractDir: string;
}): Promise<void> {
  const buffer = await fs.promises.readFile(params.archivePath);
  assertArchiveBudget({
    archiveBytes: buffer.byteLength,
    entryCount: 0,
    extractedBytes: 0,
  });
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  assertArchiveBudget({
    archiveBytes: buffer.byteLength,
    entryCount: entries.length,
    extractedBytes: 0,
  });
  let extractedBytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const relativePath = normalizeArchiveEntryPath(entry.name);
    if (!relativePath) continue;
    const targetPath = path.join(params.extractDir, ...relativePath.split('/'));
    const resolvedTarget = path.resolve(targetPath);
    const resolvedExtractDir = path.resolve(params.extractDir);
    if (
      resolvedTarget !== resolvedExtractDir &&
      !resolvedTarget.startsWith(`${resolvedExtractDir}${path.sep}`)
    ) {
      throw new Error(`archive entry escapes root: ${entry.name}`);
    }
    const content = await entry.async('nodebuffer');
    extractedBytes += content.byteLength;
    assertArchiveBudget({
      archiveBytes: buffer.byteLength,
      entryCount: entries.length,
      extractedBytes,
      entryBytes: content.byteLength,
    });
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, content);
  }
}

async function extractTarArchive(params: {
  archivePath: string;
  extractDir: string;
}): Promise<void> {
  const archiveStat = await fs.promises.stat(params.archivePath);
  assertArchiveBudget({
    archiveBytes: archiveStat.size,
    entryCount: 0,
    extractedBytes: 0,
  });
  let entryCount = 0;
  let extractedBytes = 0;
  await tar.x({
    file: params.archivePath,
    cwd: params.extractDir,
    preservePaths: false,
    strict: true,
    gzip:
      params.archivePath.toLowerCase().endsWith('.tgz') ||
      params.archivePath.toLowerCase().endsWith('.tar.gz'),
    filter: (entryPath, entry) => {
      normalizeArchiveEntryPath(entryPath);
      const entryType =
        entry && typeof entry === 'object' && 'type' in entry
          ? String((entry as { type?: unknown }).type || '')
          : '';
      if (BLOCKED_TAR_ENTRY_TYPES.has(entryType)) {
        throw new Error(`tar entry is not supported: ${entryPath}`);
      }
      const entrySize =
        entry && typeof entry === 'object' && 'size' in entry
          ? Number((entry as { size?: unknown }).size || 0)
          : 0;
      entryCount += 1;
      extractedBytes += Math.max(0, Math.floor(entrySize));
      assertArchiveBudget({
        archiveBytes: archiveStat.size,
        entryCount,
        extractedBytes,
        entryBytes: entrySize,
      });
      return true;
    },
  });
}

function resolveExtractedBundleRoot(extractDir: string): string {
  const packageDir = path.join(extractDir, 'package');
  if (fs.existsSync(packageDir) && fs.statSync(packageDir).isDirectory()) {
    return packageDir;
  }

  const entries = fs
    .readdirSync(extractDir, { withFileTypes: true })
    .filter((entry) => entry.name !== '__MACOSX');
  const visibleFiles = entries.filter((entry) => entry.isFile());
  const visibleDirs = entries.filter((entry) => entry.isDirectory());
  if (visibleFiles.length === 0 && visibleDirs.length === 1) {
    return path.join(extractDir, visibleDirs[0]!.name);
  }
  return extractDir;
}

export async function extractArchiveToBundleRoot(
  archivePath: string,
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
  const archiveKind = resolveArchiveKind(archivePath);
  if (!archiveKind) {
    return { ok: false, error: `unsupported archive: ${archivePath}` };
  }

  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'nanoclaw-extension-archive-'),
  );
  const extractDir = path.join(tmpDir, 'extract');
  try {
    await fs.promises.mkdir(extractDir, { recursive: true });
    if (archiveKind === 'zip') {
      await extractZipArchive({ archivePath, extractDir });
    } else {
      await extractTarArchive({ archivePath, extractDir });
    }
    const extractedRoot = resolveExtractedBundleRoot(extractDir);
    return {
      ok: true,
      bundleRoot: resolveBundleRootFromPath(extractedRoot),
      sourceRef: archivePath,
      suggestedName: deriveSuggestedNameFromPath(archivePath),
      cleanup: async () => {
        await fs.promises
          .rm(tmpDir, { recursive: true, force: true })
          .catch(() => undefined);
      },
    };
  } catch (err) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    return {
      ok: false,
      error:
        err instanceof Error
          ? `failed to extract archive ${archivePath}: ${err.message}`
          : `failed to extract archive ${archivePath}`,
    };
  }
}
