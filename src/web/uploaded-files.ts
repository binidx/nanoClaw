import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { dba } from '../db/engine-access.js';
import type { AgentUploadedFile } from '../types.js';
import { t } from '../i18n/index.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';

export interface UploadedFileRequest {
  name: string;
  mimeType: string;
  contentBase64: string;
}

export interface UploadedFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
  absolutePath: string;
  textExcerpt?: string;
  textTruncated?: boolean;
}

export interface UploadedFileContext {
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
  absolutePath: string;
  mountPath: string;
  textExcerpt?: string;
  textTruncated?: boolean;
}

export interface UploadedFileSupportOptions {
  chatUploadsRoot: string;
  maxUploadFilesPerRequest: number;
  maxUploadTextExcerptBytes: number;
  maxUploadTextExcerptChars: number;
}

export interface UploadedFileCleanupSummary {
  scannedFiles: number;
  deletedFiles: string[];
  referencedFiles: number;
}

export interface UploadedFileCleanupOptions {
  maxAgeMs?: number;
  now?: Date;
}

const DEFAULT_ORPHAN_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function sanitizeUploadFileName(input: string): string {
  const base = path.basename(input || '').trim();
  const sanitized = base
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return 'upload.bin';
  return sanitized.slice(0, 180);
}

function sanitizeMimeType(input: string): string {
  const trimmed = (input || '').trim().toLowerCase();
  if (!trimmed) return 'application/octet-stream';
  if (
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(trimmed)
  ) {
    return 'application/octet-stream';
  }
  return trimmed;
}

function isLikelyTextFile(name: string, mimeType: string): boolean {
  const mime = sanitizeMimeType(mimeType);
  if (mime.startsWith('text/')) return true;
  if (
    [
      'application/json',
      'application/xml',
      'application/javascript',
      'application/typescript',
      'application/x-yaml',
      'application/yaml',
    ].includes(mime)
  ) {
    return true;
  }
  const lower = name.toLowerCase();
  return [
    '.md',
    '.txt',
    '.json',
    '.yaml',
    '.yml',
    '.xml',
    '.csv',
    '.log',
    '.js',
    '.ts',
    '.tsx',
    '.jsx',
    '.py',
    '.java',
    '.go',
    '.sql',
    '.html',
    '.css',
  ].some((suffix) => lower.endsWith(suffix));
}

function normalizeUploadRelativePath(relativePath: string): string | null {
  const normalized = relativePath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  if (!normalized) return null;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
}

function collectRelativePathsFromJson(value: unknown, target: Set<string>): void {
  if (typeof value !== 'string' || !value.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = (item as Record<string, unknown>).relativePath;
    if (typeof raw !== 'string') continue;
    const normalized = normalizeUploadRelativePath(raw);
    if (normalized) target.add(normalized);
  }
}

async function collectReferencedUploadPaths(): Promise<Set<string>> {
  const referenced = new Set<string>();
  const messageRows = (await dba
    .prepare(
      `SELECT uploaded_files_json FROM messages WHERE uploaded_files_json IS NOT NULL`,
    )
    .all()) as Array<{ uploaded_files_json: string | null }>;
  for (const row of messageRows) {
    collectRelativePathsFromJson(row.uploaded_files_json, referenced);
  }

  const pendingRows = (await dba
    .prepare(`SELECT files_json FROM pending_uploads`)
    .all()) as Array<{ files_json: string | null }>;
  for (const row of pendingRows) {
    collectRelativePathsFromJson(row.files_json, referenced);
  }
  return referenced;
}

async function listUploadFiles(root: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listUploadFiles(absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function removeEmptyUploadParents(root: string, startDir: string): Promise<void> {
  const normalizedRoot = path.resolve(root);
  let current = path.resolve(startDir);
  while (current !== normalizedRoot && current.startsWith(`${normalizedRoot}${path.sep}`)) {
    try {
      await fs.promises.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function inferUploadMimeTypeFromFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.pdf':
      return 'application/pdf';
    case '.json':
      return 'application/json';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.txt':
    case '.log':
      return 'text/plain; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

export function createUploadedFileSupport(opts: UploadedFileSupportOptions) {
  const normalizeUploadChatFolder = (chatJid: string): string => {
    const label =
      chatJid
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32) || 'chat';
    const digest = crypto
      .createHash('sha1')
      .update(chatJid)
      .digest('hex')
      .slice(0, 10);
    return `${label}_${digest}`;
  };

  const resolveUploadRelativeRoot = (
    chatJid: string,
    userId?: string,
  ): string => {
    const chatFolder = normalizeUploadChatFolder(chatJid);
    const normalizedUserId = typeof userId === 'string' ? userId.trim() : '';
    if (!normalizedUserId || normalizedUserId === SYSTEM_USER_ID) {
      return chatFolder;
    }
    return path.posix.join(normalizedUserId, chatFolder);
  };

  const resolveStoredUploadFile = (
    relativePathRaw: string,
    chatJid: string,
    options?: {
      userId?: string;
      allowAnyConversationUser?: boolean;
    },
  ): {
    relativePath: string;
    absolutePath: string;
    mimeType: string;
  } => {
    const relativePath = normalizeUploadRelativePath(relativePathRaw);
    if (!relativePath) {
      throw new Error('uploadedFiles.relativePath is invalid');
    }

    const normalizedChatFolder = normalizeUploadChatFolder(chatJid);
    const expectedFolder = resolveUploadRelativeRoot(chatJid, options?.userId);
    const pathParts = relativePath.split('/');
    const matchesConversation =
      pathParts[0] === normalizedChatFolder || pathParts[1] === normalizedChatFolder;

    if (options?.allowAnyConversationUser) {
      if (!matchesConversation) {
        throw new Error('uploadedFiles contains file from a different conversation');
      }
    } else if (!relativePath.startsWith(`${expectedFolder}/`)) {
      throw new Error('uploadedFiles contains file from a different conversation');
    }

    const uploadsRoot = path.resolve(opts.chatUploadsRoot);
    const absolutePath = path.resolve(opts.chatUploadsRoot, ...pathParts);
    if (
      absolutePath !== uploadsRoot &&
      !absolutePath.startsWith(`${uploadsRoot}${path.sep}`)
    ) {
      throw new Error('uploadedFiles.relativePath is invalid');
    }

    return {
      relativePath,
      absolutePath,
      mimeType: inferUploadMimeTypeFromFileName(relativePath),
    };
  };

  const buildTextExcerpt = (
    bytes: Buffer,
    fileName: string,
    mimeType: string,
  ): Pick<UploadedFileMetadata, 'textExcerpt' | 'textTruncated'> => {
    if (!isLikelyTextFile(fileName, mimeType)) return {};
    const preview = bytes.subarray(0, opts.maxUploadTextExcerptBytes);
    const text = preview
      .toString('utf-8')
      .replace(/\u0000/g, '')
      .trim();
    if (!text) return {};
    const truncated =
      bytes.length > opts.maxUploadTextExcerptBytes ||
      text.length > opts.maxUploadTextExcerptChars;
    return {
      textExcerpt: text.slice(0, opts.maxUploadTextExcerptChars),
      ...(truncated ? { textTruncated: true } : {}),
    };
  };

  const parseUploadRequestFiles = (value: unknown): UploadedFileRequest[] => {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error('files must be a non-empty array');
    }
    if (value.length > opts.maxUploadFilesPerRequest) {
      throw new Error(t('errors.maxUploadFiles', { count: opts.maxUploadFilesPerRequest }, undefined));
    }
    const parsed: UploadedFileRequest[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('Invalid upload file item');
      }
      const item = entry as Record<string, unknown>;
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const contentBase64 =
        typeof item.contentBase64 === 'string' ? item.contentBase64.trim() : '';
      const mimeType = typeof item.mimeType === 'string' ? item.mimeType : '';
      if (!name) throw new Error(t('errors.auto_f18597', {}, undefined));
      if (!contentBase64) throw new Error(t('errors.fileContentEmpty', { name }, undefined));
      parsed.push({
        name,
        mimeType: sanitizeMimeType(mimeType),
        contentBase64,
      });
    }
    return parsed;
  };

  const parseUploadedFileContexts = (
    uploadedFiles: unknown,
    chatJid: string,
    userId?: string,
  ): UploadedFileContext[] => {
    if (!Array.isArray(uploadedFiles) || uploadedFiles.length === 0) return [];
    if (uploadedFiles.length > opts.maxUploadFilesPerRequest) {
      throw new Error(t('errors.maxAttachFiles', { count: opts.maxUploadFilesPerRequest }, undefined));
    }

    const contexts: UploadedFileContext[] = [];

    for (const entry of uploadedFiles) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('uploadedFiles item is invalid');
      }
      const item = entry as Record<string, unknown>;
      const { relativePath, absolutePath } = resolveStoredUploadFile(
        typeof item.relativePath === 'string' ? item.relativePath : '',
        chatJid,
        { userId },
      );
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        throw new Error(t('errors.uploadFileNotFound', { path: relativePath }, undefined));
      }

      const name =
        typeof item.name === 'string' && item.name.trim()
          ? item.name.trim()
          : path.basename(relativePath);
      const mimeType = sanitizeMimeType(
        typeof item.mimeType === 'string' ? item.mimeType : '',
      );
      const sizeValue = Number(item.size);
      const size =
        Number.isFinite(sizeValue) && sizeValue >= 0
          ? sizeValue
          : fs.statSync(absolutePath).size;
      const textExcerpt =
        typeof item.textExcerpt === 'string' && item.textExcerpt.trim()
          ? item.textExcerpt.trim().slice(0, opts.maxUploadTextExcerptChars)
          : undefined;
      const textTruncated = Boolean(item.textTruncated);

      contexts.push({
        name,
        mimeType,
        size,
        relativePath,
        absolutePath,
        mountPath: `/workspace/uploads/${relativePath}`,
        ...(textExcerpt ? { textExcerpt } : {}),
        ...(textExcerpt && textTruncated ? { textTruncated: true } : {}),
      });
    }

    return contexts;
  };

  const buildUploadedFilesDisplayContent = (
    rawText: string,
    files: UploadedFileContext[],
  ): string => {
    const text = rawText.trim();
    if (files.length === 0) return text;
    const names = files.map((file) => file.name).join('、');
    const translatedLabel = t(
      'errors.uploadFileLabel',
      { names },
      undefined,
    ).trim();
    const uploadLabel =
      translatedLabel && translatedLabel !== 'uploadFileLabel'
        ? translatedLabel
        : `[上传文件] ${names}`;
    return [text, uploadLabel].filter(Boolean).join('\n\n');
  };

  const toAgentUploadedFiles = (
    files: UploadedFileContext[],
  ): AgentUploadedFile[] =>
    files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      relativePath: file.relativePath,
    }));

  const cleanupOrphanUploadedFiles = async (
    cleanupOptions: UploadedFileCleanupOptions = {},
  ): Promise<UploadedFileCleanupSummary> => {
    const uploadsRoot = path.resolve(opts.chatUploadsRoot);
    const referenced = await collectReferencedUploadPaths();
    const nowMs = (cleanupOptions.now || new Date()).getTime();
    const maxAgeMs =
      cleanupOptions.maxAgeMs ?? DEFAULT_ORPHAN_UPLOAD_MAX_AGE_MS;
    const cutoffMs = nowMs - maxAgeMs;
    const absoluteFiles = await listUploadFiles(uploadsRoot);
    const deletedFiles: string[] = [];

    for (const absolutePath of absoluteFiles) {
      const relativeRaw = path.relative(uploadsRoot, absolutePath);
      const relativePath = normalizeUploadRelativePath(relativeRaw);
      if (!relativePath || referenced.has(relativePath)) continue;
      const stat = await fs.promises.stat(absolutePath);
      if (stat.mtimeMs > cutoffMs) continue;
      await fs.promises.unlink(absolutePath);
      deletedFiles.push(relativePath);
      await removeEmptyUploadParents(uploadsRoot, path.dirname(absolutePath));
    }

    return {
      scannedFiles: absoluteFiles.length,
      deletedFiles,
      referencedFiles: referenced.size,
    };
  };

  return {
    buildTextExcerpt,
    buildUploadedFilesDisplayContent,
    cleanupOrphanUploadedFiles,
    normalizeUploadChatFolder,
    resolveStoredUploadFile,
    resolveUploadRelativeRoot,
    parseUploadRequestFiles,
    parseUploadedFileContexts,
    sanitizeUploadFileName,
    toAgentUploadedFiles,
  };
}
