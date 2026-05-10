import fs from 'fs';
import os from 'os';
import path from 'path';

import { getNodeExecutable } from '../node-executable.js';

import { deleteConfig, getConfig, setConfig } from '../db.js';
import { saveDirectoryToFileStore } from '../web/file-store-service.js';
import { logger } from '../logger.js';
import { resolvePromptText } from '../prompt/prompt-service.js';
import { generateTextWithDefaultProvider } from '../provider/provider-api.js';
import {
  CUSTOM_MCP_SERVERS_ROOT,
  CUSTOM_SKILLS_ROOT,
  getManagedSkillDetail,
  listManagedSkills,
  normalizeManagedMcpServers,
  normalizeSkillId,
  parseEnabledSkillsConfig,
  parseManagedMcpServersConfig,
  serializeEnabledSkillsConfig,
  serializeManagedMcpServersConfig,
  WEB_ENABLED_SKILLS_CONFIG_KEY,
  WEB_MCP_SERVERS_CONFIG_KEY,
} from './runtime-customization.js';
import { t } from '../i18n/index.js';

export async function getManagedSkillsForResponse() {
  const skills = listManagedSkills(process.cwd());
  let enabledSet: Set<string> | null = null;
  try {
    enabledSet = parseEnabledSkillsConfig(
      await getConfig(WEB_ENABLED_SKILLS_CONFIG_KEY),
    );
  } catch (err) {
    logger.warn(
      { err },
      'Invalid WEB_ENABLED_SKILLS config, falling back to all enabled',
    );
  }
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    enabled: enabledSet ? enabledSet.has(skill.id) : true,
  }));
}

export async function getManagedSkillDetailForResponse(skillId: string) {
  const skill = getManagedSkillDetail(skillId, process.cwd());
  if (!skill) return null;

  let enabledSet: Set<string> | null = null;
  try {
    enabledSet = parseEnabledSkillsConfig(
      await getConfig(WEB_ENABLED_SKILLS_CONFIG_KEY),
    );
  } catch (err) {
    logger.warn(
      { err },
      'Invalid WEB_ENABLED_SKILLS config, falling back to all enabled',
    );
  }

  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    enabled: enabledSet ? enabledSet.has(skill.id) : true,
    dirPath: skill.dirPath,
    summary: skill.summary,
  };
}

export async function getManagedMcpServersForResponse() {
  try {
    return parseManagedMcpServersConfig(
      await getConfig(WEB_MCP_SERVERS_CONFIG_KEY),
    ).map((server) => ({
      ...server,
      name: server.name?.trim() || server.id,
    }));
  } catch (err) {
    logger.warn({ err }, 'Failed to parse managed MCP config');
    return [];
  }
}

export async function persistManagedMcpServers(
  servers: Awaited<ReturnType<typeof getManagedMcpServersForResponse>>,
) {
  if (servers.length === 0) {
    await deleteConfig(WEB_MCP_SERVERS_CONFIG_KEY);
    return;
  }
  await setConfig(
    WEB_MCP_SERVERS_CONFIG_KEY,
    serializeManagedMcpServersConfig(servers),
  );
}

interface ManagedMcpInstallInput {
  id?: unknown;
  name?: unknown;
  sourcePath?: unknown;
  entryFile?: unknown;
  env?: unknown;
  enabled?: unknown;
  overwrite?: unknown;
}

export async function installManagedMcpServerFromInput(
  input: ManagedMcpInstallInput,
) {
  const sourcePath =
    typeof input.sourcePath === 'string' ? input.sourcePath.trim() : '';
  if (!sourcePath) {
    throw new Error('sourcePath is required');
  }

  const preferredId =
    typeof input.id === 'string' && input.id.trim()
      ? input.id.trim()
      : (() => {
          const sourceBase = path.basename(
            resolveInstallSourcePath(sourcePath),
          );
          const parsed = path.parse(sourceBase).name;
          return parsed || sourceBase;
        })();

  const normalizedId = normalizeManagedMcpServers([
    {
      id: preferredId,
      name:
        typeof input.name === 'string' && input.name.trim()
          ? input.name.trim()
          : preferredId,
      command: getNodeExecutable(),
      args: ['placeholder'],
      env: {},
      enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    },
  ])[0]!.id;

  const sourceAbsolutePath = resolveInstallSourcePath(sourcePath);
  if (!fs.existsSync(sourceAbsolutePath)) {
    throw new Error(t('errors.mcpPathNotFound', { path: sourceAbsolutePath }, undefined));
  }

  fs.mkdirSync(CUSTOM_MCP_SERVERS_ROOT, { recursive: true });
  const installDir = path.join(CUSTOM_MCP_SERVERS_ROOT, normalizedId);
  if (fs.existsSync(installDir)) {
    if (!Boolean(input.overwrite)) {
      throw new Error(t('errors.mcpAlreadyInstalled', { id: normalizedId }, undefined));
    }
    fs.rmSync(installDir, { recursive: true, force: true });
  }
  fs.mkdirSync(installDir, { recursive: true });

  let entryAbsolutePath = '';
  const sourceStat = fs.statSync(sourceAbsolutePath);
  if (sourceStat.isFile()) {
    const fileName = path.basename(sourceAbsolutePath);
    const copiedPath = path.join(installDir, fileName);
    fs.copyFileSync(sourceAbsolutePath, copiedPath);
    entryAbsolutePath = copiedPath;
  } else if (sourceStat.isDirectory()) {
    fs.cpSync(sourceAbsolutePath, installDir, {
      recursive: true,
      force: true,
    });
    entryAbsolutePath = resolveMcpEntryFileFromDirectory(
      installDir,
      typeof input.entryFile === 'string' ? input.entryFile : '',
    );
  } else {
    throw new Error('MCP sourcePath must be a file or directory');
  }

  const env: Record<string, string> = {};
  if (input.env && typeof input.env === 'object' && !Array.isArray(input.env)) {
    for (const [key, value] of Object.entries(
      input.env as Record<string, unknown>,
    )) {
      const trimmedKey = key.trim();
      if (!trimmedKey) continue;
      if (typeof value === 'string') {
        env[trimmedKey] = value;
      } else if (value !== null && value !== undefined) {
        env[trimmedKey] = String(value);
      }
    }
  }

  const [normalizedServer] = normalizeManagedMcpServers([
    {
      id: normalizedId,
      name:
        typeof input.name === 'string' && input.name.trim()
          ? input.name.trim()
          : normalizedId,
      command: getNodeExecutable(),
      args: [entryAbsolutePath],
      env,
      enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    },
  ]);

  const existing = await getManagedMcpServersForResponse();
  const merged = new Map(existing.map((item) => [item.id, item]));
  merged.set(normalizedServer!.id, normalizedServer!);
  const servers = Array.from(merged.values()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  await persistManagedMcpServers(servers);

  void saveDirectoryToFileStore({
    category: 'mcp-server',
    basePathRef: normalizedId,
    diskRoot: installDir,
  }).catch((err) => {
    logger.warn({ err, mcpId: normalizedId }, 'Dual-write MCP server to DB failed');
  });

  return {
    servers,
    installed: {
      id: normalizedServer!.id,
      installDir,
      entryPath: entryAbsolutePath,
    },
  };
}

export function resolveInstallSourcePath(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('sourcePath is required');

  const unwrapped = raw.startsWith('@') ? raw.slice(1) : raw;
  const homeExpanded = unwrapped.startsWith('~/')
    ? path.join(os.homedir(), unwrapped.slice(2))
    : unwrapped;

  if (path.isAbsolute(homeExpanded)) return path.resolve(homeExpanded);
  return path.resolve(process.cwd(), homeExpanded);
}

export function resolveSkillSourceDirectory(sourcePathInput: string): string {
  const absolutePath = resolveInstallSourcePath(sourcePathInput);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(t('errors.skillPathNotFound', { path: absolutePath }, undefined));
  }
  const stat = fs.statSync(absolutePath);
  const dirPath = stat.isDirectory()
    ? absolutePath
    : path.basename(absolutePath).toLowerCase() === 'skill.md'
      ? path.dirname(absolutePath)
      : null;
  if (!dirPath) {
    throw new Error(t('errors.auto_01dd8c', {}, undefined));
  }
  const skillMdPath = path.join(dirPath, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    throw new Error(t('errors.skillMdNotFound', { path: skillMdPath }, undefined));
  }
  return dirPath;
}

export function installCustomSkillFromPath(input: {
  sourcePath: string;
  skillId?: string;
  overwrite?: boolean;
}): string {
  const sourceDir = resolveSkillSourceDirectory(input.sourcePath);
  const normalizedSkillId = normalizeSkillId(
    (input.skillId || '').trim() || path.basename(sourceDir),
  );
  if (!normalizedSkillId) {
    throw new Error('Invalid skill id');
  }

  fs.mkdirSync(CUSTOM_SKILLS_ROOT, { recursive: true });
  const destDir = path.join(CUSTOM_SKILLS_ROOT, normalizedSkillId);
  const sourceResolved = path.resolve(sourceDir);
  const destResolved = path.resolve(destDir);
  if (sourceResolved === destResolved) {
    return normalizedSkillId;
  }

  if (fs.existsSync(destDir)) {
    if (!input.overwrite) {
      throw new Error(t('errors.skillAlreadyExists', { id: normalizedSkillId }, undefined));
    }
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  fs.cpSync(sourceDir, destDir, { recursive: true, force: true });
  if (!fs.existsSync(path.join(destDir, 'SKILL.md'))) {
    throw new Error(t('errors.skillInstallFailedNoMd', { dir: destDir }, undefined));
  }

  void saveDirectoryToFileStore({
    category: 'skill',
    basePathRef: normalizedSkillId,
    diskRoot: destDir,
  }).catch((err) => {
    logger.warn({ err, skillId: normalizedSkillId }, 'Dual-write skill to DB failed');
  });

  return normalizedSkillId;
}

export function resolveMcpEntryFileFromDirectory(
  dirPath: string,
  requestedEntryFile?: string,
): string {
  if (requestedEntryFile && requestedEntryFile.trim()) {
    const segments = requestedEntryFile
      .trim()
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean);
    if (
      segments.length === 0 ||
      segments.includes('.') ||
      segments.includes('..')
    ) {
      throw new Error('entryFile is invalid');
    }
    const candidate = path.resolve(dirPath, ...segments);
    if (!candidate.startsWith(`${path.resolve(dirPath)}${path.sep}`)) {
      throw new Error('entryFile is invalid');
    }
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      throw new Error(`entryFile not found: ${requestedEntryFile}`);
    }
    return candidate;
  }

  const preferredCandidates = [
    'index.mjs',
    'index.js',
    'server.mjs',
    'server.js',
    path.join('dist', 'index.mjs'),
    path.join('dist', 'index.js'),
  ];
  for (const relative of preferredCandidates) {
    const candidate = path.resolve(dirPath, relative);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  const jsFiles = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(mjs|cjs|js)$/i.test(entry.name));
  if (jsFiles.length === 1) {
    return path.resolve(dirPath, jsFiles[0]!.name);
  }

  throw new Error(
    t('errors.auto_987f38', {}, undefined),
  );
}

const SKILL_CREATOR_SKILL_ID = 'skill-creator';
const MAX_AI_SKILL_FILES = 40;
const MAX_AI_SKILL_FILE_BYTES = 220 * 1024;

function readSkillCreatorGuideForPrompt(): string {
  const candidates = [
    path.join(CUSTOM_SKILLS_ROOT, SKILL_CREATOR_SKILL_ID, 'SKILL.md'),
    path.join(
      process.cwd(),
      'agent',
      'skills',
      SKILL_CREATOR_SKILL_ID,
      'SKILL.md',
    ),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const content = fs.readFileSync(candidate, 'utf-8').trim();
      if (content) {
        return content;
      }
    } catch (err) {
      logger.warn({ err, candidate }, 'Failed to read skill-creator guide');
    }
  }
  throw new Error(
    t('errors.auto_90b6f4', {}, undefined),
  );
}

function normalizeRelativeSkillFilePath(input: string): string | null {
  const normalized = input.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return null;
  const segments = normalized.split('/').filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    return null;
  }
  return segments.join('/');
}

interface AiGeneratedSkillDraft {
  skillId: string;
  name: string;
  description: string;
  skillMd: string;
  files: Array<{ path: string; content: string }>;
}

function parseAiGeneratedSkillDraft(
  payload: Record<string, unknown>,
  requestedSkillId: string,
): AiGeneratedSkillDraft {
  const rawSkillId =
    (typeof payload.skillId === 'string' && payload.skillId.trim()) ||
    requestedSkillId;
  const skillId = normalizeSkillId(rawSkillId);
  if (!skillId) {
    throw new Error(t('errors.auto_9a9983', {}, undefined));
  }

  const rawName = typeof payload.name === 'string' ? payload.name.trim() : '';
  const name = rawName || skillId;
  const description =
    typeof payload.description === 'string' ? payload.description.trim() : '';

  const skillMdRaw =
    typeof payload.skillMd === 'string'
      ? payload.skillMd
      : typeof payload.skill_md === 'string'
        ? payload.skill_md
        : '';
  const skillMd = skillMdRaw.trim();
  if (!skillMd) {
    throw new Error(t('errors.auto_5c27ea', {}, undefined));
  }
  if (Buffer.byteLength(skillMd, 'utf-8') > MAX_AI_SKILL_FILE_BYTES) {
    throw new Error(t('errors.auto_d66a3c', {}, undefined));
  }

  const filesRaw = Array.isArray(payload.files) ? payload.files : [];
  const files: Array<{ path: string; content: string }> = [];
  for (const item of filesRaw.slice(0, MAX_AI_SKILL_FILES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const relPath =
      typeof obj.path === 'string'
        ? normalizeRelativeSkillFilePath(obj.path)
        : null;
    if (!relPath || relPath.toLowerCase() === 'skill.md') continue;
    const content = typeof obj.content === 'string' ? obj.content : '';
    if (!content.trim()) continue;
    if (Buffer.byteLength(content, 'utf-8') > MAX_AI_SKILL_FILE_BYTES) continue;
    files.push({ path: relPath, content });
  }

  return { skillId, name, description, skillMd, files };
}

function writeAiGeneratedSkillDraft(
  draft: AiGeneratedSkillDraft,
  overwrite: boolean,
) {
  fs.mkdirSync(CUSTOM_SKILLS_ROOT, { recursive: true });
  const skillDir = path.join(CUSTOM_SKILLS_ROOT, draft.skillId);
  if (fs.existsSync(skillDir)) {
    if (!overwrite) {
      throw new Error(t('errors.skillAlreadyExists', { id: draft.skillId }, undefined));
    }
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
  fs.mkdirSync(skillDir, { recursive: true });

  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    draft.skillMd.trim() + '\n',
    'utf-8',
  );
  for (const file of draft.files) {
    const filePath = path.resolve(skillDir, ...file.path.split('/'));
    if (!filePath.startsWith(`${path.resolve(skillDir)}${path.sep}`)) continue;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content, 'utf-8');
  }

  void saveDirectoryToFileStore({
    category: 'skill',
    basePathRef: draft.skillId,
    diskRoot: skillDir,
  }).catch((err) => {
    logger.debug({ err }, 'Failed to save skill directory to file store');
  });

  return skillDir;
}

interface AiSkillCreateInput {
  request?: unknown;
  skillId?: unknown;
  name?: unknown;
  overwrite?: unknown;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI did not return JSON');
  }
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

export async function createSkillWithAiFromInput(input: AiSkillCreateInput) {
  const userRequest =
    typeof input.request === 'string' ? input.request.trim() : '';
  if (!userRequest) {
    throw new Error('request is required');
  }
  const requestedSkillId =
    typeof input.skillId === 'string' ? input.skillId.trim() : '';
  const requestedName = typeof input.name === 'string' ? input.name.trim() : '';
  const overwrite = Boolean(input.overwrite);

  const creatorGuide = readSkillCreatorGuideForPrompt();
  const creationPrompt = [
    t('errors.auto_aba362', {}, undefined),
    t('errors.auto_3cac08', {}, undefined),
    '',
    t('errors.auto_50dd3e', {}, undefined),
    creatorGuide,
    '',
    t('errors.auto_49827d', {}, undefined),
    userRequest,
    '',
    t('errors.auto_aa8c67', {}, undefined),
    t('errors.skillIdOptional', { id: requestedSkillId || '(auto)' }, undefined),
    t('errors.nameOptional', { name: requestedName || '(auto)' }, undefined),
    '',
    t('errors.auto_706033', {}, undefined),
    'JSON schema:',
    '{',
    t('errors.auto_5a5265', {}, undefined),
    t('errors.auto_91d5b2', {}, undefined),
    t('errors.auto_1390e7', {}, undefined),
    t('errors.auto_86602c', {}, undefined),
    '  "files": [',
    '    {',
    t('errors.auto_97c5e1', {}, undefined),
    t('errors.auto_627358', {}, undefined),
    '    }',
    '  ]',
    '}',
    '',
    t('errors.auto_d0dfe9', {}, undefined),
    t('errors.auto_da44c0', {}, undefined),
    t('errors.auto_a9fc0f', {}, undefined),
  ].join('\n');

  const resolvedPrompt = await resolvePromptText({
    promptKey: 'runtime_customization.skill_create',
    variables: {
      request: userRequest,
      docsText: creatorGuide,
    },
    fallbackText: creationPrompt,
  });
  const raw = await generateTextWithDefaultProvider(resolvedPrompt.text, {
    promptTrace: {
      promptKey: 'runtime_customization.skill_create',
      featureScope: 'runtime_customization',
      metadata: {
        requestedSkillId: requestedSkillId || null,
        requestedName: requestedName || null,
      },
    },
  });
  const parsed = extractJsonObject(raw);
  const draft = parseAiGeneratedSkillDraft(parsed, requestedSkillId);
  if (requestedName) {
    draft.name = requestedName;
  }
  if (requestedSkillId) {
    const forcedId = normalizeSkillId(requestedSkillId);
    if (!forcedId) {
      throw new Error('skillId is invalid');
    }
    draft.skillId = forcedId;
  }

  const skillDir = writeAiGeneratedSkillDraft(draft, overwrite);

  try {
    const currentEnabled = parseEnabledSkillsConfig(
      await getConfig(WEB_ENABLED_SKILLS_CONFIG_KEY),
    );
    if (currentEnabled) {
      currentEnabled.add(draft.skillId);
      await setConfig(
        WEB_ENABLED_SKILLS_CONFIG_KEY,
        serializeEnabledSkillsConfig(currentEnabled),
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      'Failed to update enabled skills after AI skill creation',
    );
  }

  return {
    skills: getManagedSkillsForResponse(),
    created: {
      id: draft.skillId,
      name: draft.name,
      path: skillDir,
      extraFiles: draft.files.map((file) => file.path),
    },
  };
}
