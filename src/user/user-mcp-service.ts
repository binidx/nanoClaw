import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import {
  evaluateExtensionHealth,
  parseExtensionMetadata,
  normalizeExtensionMetadata,
  serializeExtensionMetadata,
  type ExtensionHealthStatus,
  type ExtensionMetadata,
} from '../extension/extension-metadata.js';
import { saveDirectoryToFileStore } from '../web/file-store-service.js';
import { getNodeExecutable } from '../node-executable.js';
import {
  type UserMcpServerRecord,
  generateMcpServerId,
  upsertUserMcpServer,
  getUserMcpServer,
  listUserMcpServers,
  listVisibleMcpServers,
  deleteUserMcpServer,
  deleteMarketplaceInstallsByTarget,
} from '../db.js';
import { logger } from '../logger.js';
import { generateTextWithDefaultProvider } from '../provider/provider-api.js';
import {
  resolveInstallSourcePath,
  resolveMcpEntryFileFromDirectory,
} from '../runtime/runtime-customization-service.js';
import { resolvePromptText } from '../prompt/prompt-service.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { t } from '../i18n/index.js';

export interface UserMcpServerInput {
  id?: string;
  name: string;
  description?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  visibility?: 'private' | 'shared';
  sourceType?: string;
  sourceRef?: string | null;
  iconUrl?: string;
  tags?: string[];
  metadata?: ExtensionMetadata;
}

export interface UserMcpServerView {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  visibility: 'private' | 'shared';
  sourceType: string;
  sourceRef: string | null;
  iconUrl: string | null;
  tags: string[];
  metadata: ExtensionMetadata;
  healthStatus: ExtensionHealthStatus;
  createdAt: string;
  updatedAt: string;
  isOwner?: boolean;
}

function recordToView(record: UserMcpServerRecord, currentUserId?: string): UserMcpServerView {
  const env = safeParse<Record<string, string>>(record.env_json, {});
  const metadata = parseExtensionMetadata(record.metadata_json);
  const isOwner = currentUserId ? record.user_id === currentUserId : undefined;
  const visibleEnv = isOwner === false ? {} : env;
  return {
    id: record.id,
    userId: record.user_id,
    name: record.name,
    description: record.description,
    command: record.command,
    args: safeParse<string[]>(record.args_json, []),
    env: visibleEnv,
    enabled: record.enabled === 1,
    visibility: record.visibility as 'private' | 'shared',
    sourceType: record.source_type,
    sourceRef: record.source_ref,
    iconUrl: record.icon_url,
    tags: safeParse<string[]>(record.tags_json, []),
    metadata,
    healthStatus: evaluateExtensionHealth({
      metadata,
      env: visibleEnv,
      baseDir: path.join(getUserMcpDir(record.user_id), record.id),
      command: record.command,
    }),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    isOwner,
  };
}

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const HYDRATE_PAGE_SIZE = 500;

async function ensureUserDiskHydrated(userId: string): Promise<void> {
  const { ensureUserHydrated } = await import('../runtime/startup-hydration.js');
  await ensureUserHydrated(userId);
}

async function listAllMcpRecordsForHydration(options: {
  userId?: string;
  visibility?: string;
}): Promise<UserMcpServerRecord[]> {
  const out: UserMcpServerRecord[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await listUserMcpServers({
      ...options,
      limit: HYDRATE_PAGE_SIZE,
      offset,
    });
    out.push(...chunk);
    if (chunk.length < HYDRATE_PAGE_SIZE) break;
    offset += chunk.length;
  }
  return out;
}

function getUserMcpDir(userId: string): string {
  return path.join(DATA_DIR, 'users', userId, 'mcp-servers');
}

function getSharedMcpDir(): string {
  return path.join(DATA_DIR, 'shared', 'mcp-servers');
}

function syncMcpToDisk(record: UserMcpServerRecord): void {
  const userDir = path.join(getUserMcpDir(record.user_id), record.id);
  fs.mkdirSync(userDir, { recursive: true });
  const config = {
    id: record.id,
    name: record.name,
    description: record.description,
    command: record.command,
    args: safeParse<string[]>(record.args_json, []),
    env: safeParse<Record<string, string>>(record.env_json, {}),
    metadata: parseExtensionMetadata(record.metadata_json),
    enabled: record.enabled === 1,
  };
  fs.writeFileSync(path.join(userDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');

  if (record.visibility === 'shared') {
    const sharedDir = path.join(getSharedMcpDir(), record.id);
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(
      path.join(sharedDir, 'config.json'),
      JSON.stringify({ ...config, env: {} }, null, 2),
      'utf-8',
    );
  }
}

function removeMcpFromDisk(userId: string, mcpId: string): void {
  try {
    const userDir = path.join(getUserMcpDir(userId), mcpId);
    if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true });
    const sharedDir = path.join(getSharedMcpDir(), mcpId);
    if (fs.existsSync(sharedDir)) fs.rmSync(sharedDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ err, mcpId }, 'user-mcp: failed to remove from disk');
  }
}

interface AiGeneratedMcpDraft {
  name: string;
  description?: string;
  metadata?: ExtensionMetadata;
  entryFile?: string;
  env?: Record<string, string>;
  files: Array<{ path: string; content: string }>;
}

export interface UserMcpImportPathInput {
  sourcePath: string;
  name?: string;
  entryFile?: string;
  visibility?: 'private' | 'shared';
}

interface AiCreateUserMcpInput {
  request?: unknown;
  docsText?: unknown;
  name?: unknown;
  visibility?: unknown;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI did not return JSON');
  }
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

function parseAiGeneratedMcpDraft(value: unknown): AiGeneratedMcpDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AI MCP draft must be an object');
  }
  const record = value as Record<string, unknown>;
  const files = Array.isArray(record.files)
    ? record.files
        .filter(
          (entry): entry is Record<string, unknown> =>
            !!entry && typeof entry === 'object' && !Array.isArray(entry),
        )
        .map((entry) => ({
          path: typeof entry.path === 'string' ? entry.path.trim() : '',
          content:
            typeof entry.content === 'string' ? entry.content : '',
        }))
        .filter((entry) => entry.path && !entry.path.includes('..'))
    : [];
  if (files.length === 0) {
    throw new Error('AI MCP draft must include files');
  }
  const env =
    record.env && typeof record.env === 'object' && !Array.isArray(record.env)
      ? Object.fromEntries(
          Object.entries(record.env as Record<string, unknown>).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === 'string',
          ),
        )
      : {};
  return {
    name: typeof record.name === 'string' ? record.name.trim() : '',
    ...(typeof record.description === 'string' && record.description.trim()
      ? { description: record.description.trim() }
      : {}),
    ...(typeof record.entryFile === 'string' && record.entryFile.trim()
      ? { entryFile: record.entryFile.trim() }
      : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(record.metadata ? { metadata: normalizeExtensionMetadata(record.metadata) } : {}),
    files,
  };
}

function writeGeneratedMcpPackage(input: {
  userId: string;
  mcpId: string;
  draft: AiGeneratedMcpDraft;
}): string {
  const mcpDir = path.join(getUserMcpDir(input.userId), input.mcpId);
  const packageDir = path.join(mcpDir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  for (const file of input.draft.files) {
    const filePath = path.resolve(packageDir, file.path);
    if (!filePath.startsWith(`${packageDir}${path.sep}`)) continue;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content, 'utf-8');
  }
  const entryFile =
    input.draft.entryFile ||
    input.draft.files.find((file) => file.path.endsWith('index.mjs'))?.path ||
    input.draft.files[0]!.path;
  const entryPath = path.resolve(packageDir, entryFile);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Generated MCP entry file not found: ${entryFile}`);
  }
  return entryPath;
}

function copyImportedMcpPackage(input: {
  userId: string;
  mcpId: string;
  sourcePath: string;
  entryFile?: string;
}): { packageRoot: string; entryPath: string } {
  const sourceAbsolutePath = resolveInstallSourcePath(input.sourcePath);
  if (!fs.existsSync(sourceAbsolutePath)) {
    throw new Error(
      t('errors.mcpPathNotFound', { path: sourceAbsolutePath }, undefined),
    );
  }
  const mcpDir = path.join(getUserMcpDir(input.userId), input.mcpId);
  const packageDir = path.join(mcpDir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });

  let entryPath = '';
  const stat = fs.statSync(sourceAbsolutePath);
  if (stat.isFile()) {
    const fileName = path.basename(sourceAbsolutePath);
    const copiedPath = path.join(packageDir, fileName);
    fs.copyFileSync(sourceAbsolutePath, copiedPath);
    entryPath = copiedPath;
  } else if (stat.isDirectory()) {
    fs.cpSync(sourceAbsolutePath, packageDir, {
      recursive: true,
      force: true,
    });
    entryPath = resolveMcpEntryFileFromDirectory(
      packageDir,
      input.entryFile,
    );
  } else {
    throw new Error('MCP sourcePath must be a file or directory');
  }

  return { packageRoot: packageDir, entryPath };
}

export async function createUserMcpServer(
  userId: string,
  input: UserMcpServerInput,
): Promise<UserMcpServerView> {
  const now = new Date().toISOString();
  const record: UserMcpServerRecord = {
    id: input.id ?? generateMcpServerId(),
    user_id: userId,
    name: input.name,
    description: input.description ?? null,
    command: input.command,
    args_json: JSON.stringify(input.args ?? []),
    env_json: JSON.stringify(input.env ?? {}),
    metadata_json: serializeExtensionMetadata(input.metadata),
    enabled: input.enabled !== false ? 1 : 0,
    visibility: input.visibility ?? 'private',
    source_type: input.sourceType ?? 'manual',
    source_ref: input.sourceRef ?? null,
    icon_url: input.iconUrl ?? null,
    tags_json: input.tags ? JSON.stringify(input.tags) : null,
    created_at: now,
    updated_at: now,
  };
  await upsertUserMcpServer(record);
  try { syncMcpToDisk(record); } catch (err) {
    logger.warn({ err, mcpId: record.id }, 'user-mcp: disk sync failed after create');
  }
  return recordToView(record, userId);
}

export async function importUserMcpServerFromPath(
  userId: string,
  input: UserMcpImportPathInput,
): Promise<{
  server: UserMcpServerView;
  imported: {
    path: string;
    entryPath: string;
  };
}> {
  const sourcePath = String(input.sourcePath || '').trim();
  if (!sourcePath) {
    throw new Error('sourcePath is required');
  }
  const mcpId = generateMcpServerId();
  const { packageRoot, entryPath } = copyImportedMcpPackage({
    userId,
    mcpId,
    sourcePath,
    entryFile: input.entryFile,
  });
  const sourceAbsolutePath = resolveInstallSourcePath(sourcePath);
  const defaultName =
    path.parse(sourceAbsolutePath).name || path.basename(sourceAbsolutePath);
  const server = await createUserMcpServer(userId, {
    id: mcpId,
    name: String(input.name || '').trim() || defaultName,
    description: `Imported from ${sourcePath}`,
    command: getNodeExecutable(),
    args: [entryPath],
    visibility: input.visibility === 'shared' ? 'shared' : 'private',
    sourceType: 'import',
    sourceRef: sourceAbsolutePath,
    metadata: {
      capabilities: [],
      runtime: {
        kind: 'node',
        entryFile: path.relative(packageRoot, entryPath).replace(/\\/g, '/'),
      },
      requirements: {
        commands: [{ command: 'node' }],
      },
      generator: {
        kind: 'imported',
      },
    },
  });

  void saveDirectoryToFileStore({
    category: 'mcp-server',
    basePathRef: server.id,
    diskRoot: path.join(getUserMcpDir(userId), server.id),
  }).catch((err) => {
    logger.warn({ err, mcpId: server.id }, 'user-mcp: failed to mirror imported MCP package');
  });

  return {
    server,
    imported: {
      path: path.join(getUserMcpDir(userId), server.id),
      entryPath,
    },
  };
}

export async function createUserMcpServerWithAi(
  userId: string,
  input: AiCreateUserMcpInput,
): Promise<{
  server: UserMcpServerView;
  created: {
    id: string;
    path: string;
    files: string[];
  };
}> {
  const request =
    typeof input.request === 'string' ? input.request.trim() : '';
  if (!request) {
    throw new Error('request is required');
  }
  const docsText =
    typeof input.docsText === 'string' ? input.docsText.trim() : '';
  const requestedName =
    typeof input.name === 'string' ? input.name.trim() : '';
  const visibility =
    input.visibility === 'shared' ? 'shared' : 'private';

  const prompt = [
    t('errors.auto_4aa166', {}, undefined),
    t('errors.auto_94abe1', {}, undefined),
    t('errors.auto_fe6f15', {}, undefined),
    '',
    t('errors.auto_547e14', {}, undefined),
    '{',
    t('errors.auto_183953', {}, undefined),
    t('errors.auto_81f04d', {}, undefined),
    t('errors.auto_a653a0', {}, undefined),
    '  "env": { "ENV_KEY": "" },',
    '  "metadata": {',
    '    "capabilities": ["image.generate"],',
    '    "runtime": { "kind": "node", "entryFile": "index.mjs" },',
    '    "requirements": {',
    '      "commands": [{ "command": "node" }],',
    '      "env": [{ "key": "API_KEY", "secret": true }]',
    '    },',
    '    "artifacts": { "kinds": ["images"], "producesImages": true },',
    '    "generator": { "kind": "ai-generated", "templateId": "generic-http-json" }',
    '  },',
    '  "files": [',
    '    { "path": "index.mjs", "content": "..." },',
    '    { "path": "src/index.ts", "content": "..." }',
    '  ]',
    '}',
    '',
    t('errors.auto_d0dfe9', {}, undefined),
    t('errors.auto_2f3ef6', {}, undefined),
    t('errors.auto_2775b6', {}, undefined),
    t('errors.auto_991ca2', {}, undefined),
    t('errors.auto_a22227', {}, undefined),
    '',
    t('errors.auto_49827d', {}, undefined),
    request,
    '',
    t('errors.auto_cd4297', {}, undefined),
    docsText || '(none)',
    '',
    t('errors.auto_8271fb', {}, undefined),
    requestedName || '(auto)',
  ].join('\n');

  const resolvedPrompt = await resolvePromptText({
    promptKey: 'user_mcp.ai_create',
    targetUserId: userId,
    variables: {
      request,
      docsText: docsText || '(none)',
      requestedName: requestedName || '(auto)',
    },
    fallbackText: prompt,
  });
  const raw = await generateTextWithDefaultProvider(resolvedPrompt.text, {
    promptTrace: {
      promptKey: 'user_mcp.ai_create',
      featureScope: 'user_mcp',
      targetUserId: userId,
      metadata: {
        requestedName: requestedName || null,
      },
    },
  });
  const parsed = extractJsonObject(raw);
  const draft = parseAiGeneratedMcpDraft(parsed);
  const serverName = requestedName || draft.name || 'AI Generated MCP';
  const metadata = normalizeExtensionMetadata({
    ...draft.metadata,
    generator: {
      ...(draft.metadata?.generator || {}),
      kind: 'ai-generated',
      ...(draft.metadata?.generator?.templateId
        ? { templateId: draft.metadata.generator.templateId }
        : {}),
      ...(docsText ? { sourceDocs: [docsText.slice(0, 2000)] } : {}),
    },
    runtime: {
      ...(draft.metadata?.runtime || {}),
      kind: 'node',
      ...(draft.entryFile ? { entryFile: draft.entryFile } : {}),
    },
    requirements: {
      ...(draft.metadata?.requirements || {}),
      commands: [
        ...(draft.metadata?.requirements?.commands || []),
        { command: 'node' },
      ],
    },
  });

  const mcpId = generateMcpServerId();
  const entryPath = writeGeneratedMcpPackage({
    userId,
    mcpId,
    draft,
  });
  const server = await createUserMcpServer(userId, {
    id: mcpId,
    name: serverName,
    description: draft.description,
    command: getNodeExecutable(),
    args: [entryPath],
    env: draft.env || {},
    visibility,
    sourceType: 'generated',
    sourceRef: null,
    metadata,
  });

  void saveDirectoryToFileStore({
    category: 'mcp-server',
    basePathRef: server.id,
    diskRoot: path.join(getUserMcpDir(userId), server.id),
  }).catch((err) => {
    logger.warn({ err, mcpId: server.id }, 'user-mcp: failed to mirror generated MCP package');
  });

  return {
    server,
    created: {
      id: server.id,
      path: path.join(getUserMcpDir(userId), server.id),
      files: draft.files.map((file) => file.path),
    },
  };
}

export async function updateUserMcpServer(
  userId: string,
  mcpId: string,
  input: Partial<UserMcpServerInput>,
): Promise<UserMcpServerView | null> {
  const existing = await getUserMcpServer(mcpId);
  if (!existing || existing.user_id !== userId) return null;

  const now = new Date().toISOString();
  const updated: UserMcpServerRecord = {
    ...existing,
    name: input.name ?? existing.name,
    description: input.description !== undefined ? (input.description ?? null) : existing.description,
    command: input.command ?? existing.command,
    args_json: input.args ? JSON.stringify(input.args) : existing.args_json,
    env_json: input.env ? JSON.stringify(input.env) : existing.env_json,
    metadata_json:
      input.metadata !== undefined
        ? serializeExtensionMetadata(input.metadata)
        : existing.metadata_json,
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
    visibility: input.visibility ?? existing.visibility,
    source_type: input.sourceType ?? existing.source_type,
    source_ref: input.sourceRef !== undefined ? (input.sourceRef ?? null) : existing.source_ref,
    icon_url: input.iconUrl !== undefined ? (input.iconUrl ?? null) : existing.icon_url,
    tags_json: input.tags ? JSON.stringify(input.tags) : existing.tags_json,
    updated_at: now,
  };
  await upsertUserMcpServer(updated);
  try { syncMcpToDisk(updated); } catch (err) {
    logger.warn({ err, mcpId: updated.id }, 'user-mcp: disk sync failed after update');
  }
  return recordToView(updated, userId);
}

export async function removeUserMcpServer(userId: string, mcpId: string): Promise<boolean> {
  const existing = await getUserMcpServer(mcpId);
  if (!existing || existing.user_id !== userId) return false;
  await deleteUserMcpServer(mcpId);
  await deleteMarketplaceInstallsByTarget(mcpId);
  removeMcpFromDisk(userId, mcpId);
  return true;
}

export async function adminRemoveMcpServer(mcpId: string): Promise<boolean> {
  const existing = await getUserMcpServer(mcpId);
  if (!existing || existing.visibility !== 'shared') return false;
  await deleteUserMcpServer(mcpId);
  await deleteMarketplaceInstallsByTarget(mcpId);
  removeMcpFromDisk(existing.user_id, mcpId);
  return true;
}

export async function toggleMcpVisibility(
  userId: string,
  mcpId: string,
): Promise<UserMcpServerView | null> {
  const existing = await getUserMcpServer(mcpId);
  if (!existing || existing.user_id !== userId) return null;

  const nextVisibility = existing.visibility === 'shared' ? 'private' : 'shared';
  const now = new Date().toISOString();
  const updated: UserMcpServerRecord = {
    ...existing,
    visibility: nextVisibility,
    updated_at: now,
  };
  await upsertUserMcpServer(updated);
  try { syncMcpToDisk(updated); } catch (err) {
    logger.warn({ err, mcpId: updated.id }, 'user-mcp: disk sync failed after visibility toggle');
  }

  if (nextVisibility === 'private') {
    const sharedDir = path.join(getSharedMcpDir(), mcpId);
    if (fs.existsSync(sharedDir)) fs.rmSync(sharedDir, { recursive: true, force: true });
  }

  return recordToView(updated, userId);
}

export async function listMyMcpServers(userId: string): Promise<UserMcpServerView[]> {
  await ensureUserDiskHydrated(userId);
  const records = await listUserMcpServers({ userId });
  return records.map((r) => recordToView(r, userId));
}

export async function listAllVisibleMcpServers(userId: string): Promise<UserMcpServerView[]> {
  await ensureUserDiskHydrated(userId);
  const records = await listVisibleMcpServers(userId);
  return records.map((r) => recordToView(r, userId));
}

export async function installSharedMcpToUser(
  userId: string,
  sourceMcpId: string,
): Promise<UserMcpServerView | null> {
  await ensureUserDiskHydrated(userId);
  const source = await getUserMcpServer(sourceMcpId);
  if (!source || source.visibility !== 'shared') return null;
  if (source.user_id === userId) return recordToView(source, userId);

  // Do NOT copy env from source — it may contain secrets (API keys etc.).
  // The user must supply their own env after installing.
  return createUserMcpServer(userId, {
    name: source.name,
    description: source.description ?? undefined,
    command: source.command,
    args: safeParse<string[]>(source.args_json, []),
    enabled: true,
    visibility: 'private',
    sourceType: 'import',
    sourceRef: sourceMcpId,
    metadata: parseExtensionMetadata(source.metadata_json),
  });
}

export async function hydrateUserMcpServersToDisk(
  options: { userId: string } | { sharedAndSystemOnly: true },
): Promise<number> {
  let records: UserMcpServerRecord[];
  if ('userId' in options) {
    records = await listAllMcpRecordsForHydration({ userId: options.userId });
  } else {
    const shared = await listAllMcpRecordsForHydration({ visibility: 'shared' });
    const system = await listAllMcpRecordsForHydration({ userId: SYSTEM_USER_ID });
    const byId = new Map<string, UserMcpServerRecord>();
    for (const r of shared) byId.set(r.id, r);
    for (const r of system) byId.set(r.id, r);
    records = [...byId.values()];
  }
  let count = 0;
  for (const record of records) {
    try {
      syncMcpToDisk(record);
      count++;
    } catch (err) {
      logger.warn({ err, mcpId: record.id }, 'user-mcp: hydration failed');
    }
  }
  return count;
}
