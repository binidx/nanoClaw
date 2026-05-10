import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import {
  type ExtensionMetadata,
  normalizeExtensionMetadata,
} from '../extension/extension-metadata.js';
import { saveToFileStore, removeFileStoreByPrefix } from '../web/file-store-service.js';
import { logger } from '../logger.js';

export const WEB_MCP_SERVERS_CONFIG_KEY = 'WEB_MCP_SERVERS';
export const WEB_ENABLED_SKILLS_CONFIG_KEY = 'WEB_ENABLED_SKILLS';
export const WEB_SUBAGENTS_CONFIG_KEY = 'WEB_SUBAGENTS';
export const CUSTOM_SKILLS_ROOT = path.join(DATA_DIR, 'custom-skills');
export const CUSTOM_MCP_SERVERS_ROOT = path.join(DATA_DIR, 'mcp-servers');
const BUILTIN_SKILLS_ROOT_RELATIVE = path.join('agent', 'skills');

export interface ManagedMcpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  metadata?: ExtensionMetadata;
}

export interface ManagedSkillDefinition {
  id: string;
  name: string;
  description?: string;
  source: 'builtin' | 'custom';
  dirPath: string;
}

export interface ManagedSkillDetail extends ManagedSkillDefinition {
  summary?: string;
}

interface ManagedSkillCacheEntry {
  mtimeMs: number;
  size: number;
  value: ManagedSkillDefinition | null;
}

const managedSkillDefinitionCache = new Map<string, ManagedSkillCacheEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseStringArray(
  value: unknown,
  fieldName: string,
  serverId: string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `MCP server "${serverId}" field "${fieldName}" must be an array of strings`,
    );
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error(
        `MCP server "${serverId}" field "${fieldName}" must only contain strings`,
      );
    }
    result.push(entry);
  }
  return result;
}

function parseStringMap(
  value: unknown,
  fieldName: string,
  serverId: string,
): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error(
      `MCP server "${serverId}" field "${fieldName}" must be an object of key/value strings`,
    );
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') {
      throw new Error(`MCP server "${serverId}" env "${key}" must be a string`);
    }
    result[key] = raw;
  }
  return result;
}

function parseMetadata(
  value: unknown,
): ExtensionMetadata | undefined {
  const metadata = normalizeExtensionMetadata(value);
  return metadata.capabilities.length > 0 ||
    metadata.runtime ||
    metadata.requirements ||
    metadata.artifacts ||
    metadata.generator ||
    metadata.ui ||
    metadata.notes
    ? metadata
    : undefined;
}

function normalizeServerId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!normalized) return '';
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(
      `MCP server id "${id}" is invalid; only letters, numbers, "_" and "-" are allowed`,
    );
  }
  if (normalized === 'nanoclaw') {
    throw new Error('MCP server id "nanoclaw" is reserved');
  }
  return normalized;
}

function normalizeMcpServerEntry(
  id: string,
  raw: unknown,
): ManagedMcpServerConfig {
  const normalizedId = normalizeServerId(id);
  if (!normalizedId) {
    throw new Error('MCP server id cannot be empty');
  }
  if (!isRecord(raw)) {
    throw new Error(`MCP server "${normalizedId}" must be an object`);
  }

  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!command) {
    throw new Error(`MCP server "${normalizedId}" command is required`);
  }

  const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);

  return {
    id: normalizedId,
    name:
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim()
        : normalizedId,
    command,
    args: parseStringArray(raw.args, 'args', normalizedId),
    env: parseStringMap(raw.env, 'env', normalizedId),
    enabled,
    ...(parseMetadata(raw.metadata)
      ? { metadata: parseMetadata(raw.metadata) }
      : {}),
  };
}

export function normalizeManagedMcpServers(
  payload: unknown,
): ManagedMcpServerConfig[] {
  if (payload === null || payload === undefined) return [];

  const result: ManagedMcpServerConfig[] = [];
  const dedup = new Set<string>();

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (!isRecord(entry)) {
        throw new Error('MCP servers array must contain objects');
      }
      const id = typeof entry.id === 'string' ? entry.id : '';
      const server = normalizeMcpServerEntry(id, entry);
      if (dedup.has(server.id)) {
        throw new Error(`Duplicate MCP server id: "${server.id}"`);
      }
      dedup.add(server.id);
      result.push(server);
    }
    return result;
  }

  if (isRecord(payload)) {
    for (const [id, value] of Object.entries(payload)) {
      const server = normalizeMcpServerEntry(id, value);
      if (dedup.has(server.id)) {
        throw new Error(`Duplicate MCP server id: "${server.id}"`);
      }
      dedup.add(server.id);
      result.push(server);
    }
    return result;
  }

  throw new Error('MCP servers payload must be an object map or array');
}

export function parseManagedMcpServersConfig(
  raw: string | undefined,
): ManagedMcpServerConfig[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Stored MCP config is not valid JSON');
  }
  return normalizeManagedMcpServers(parsed);
}

export function serializeManagedMcpServersConfig(
  servers: ManagedMcpServerConfig[],
): string {
  const output: Record<string, Omit<ManagedMcpServerConfig, 'id'>> = {};
  for (const server of servers) {
    output[server.id] = {
      name: server.name,
      command: server.command,
      args: server.args,
      env: server.env,
      enabled: server.enabled,
      ...(server.metadata ? { metadata: server.metadata } : {}),
    };
  }
  return JSON.stringify(output);
}

export function toAgentMcpServerMap(servers: ManagedMcpServerConfig[]): Record<
  string,
  {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }
> {
  const output: Record<
    string,
    {
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  > = {};
  for (const server of servers) {
    if (!server.enabled) continue;
    output[server.id] = {
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    };
  }
  return output;
}

function parseSkillSummaryFromMarkdown(content: string): {
  title?: string;
  description?: string;
  summary?: string;
} {
  const lines = content.split(/\r?\n/);
  const contentStartIndex =
    lines[0]?.trim() === '---'
      ? lines.findIndex((line, index) => index > 0 && line.trim() === '---') + 1
      : 0;
  const bodyLines =
    contentStartIndex > 0 ? lines.slice(contentStartIndex) : lines.slice();
  let title = '';
  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];

  const flushParagraph = () => {
    if (currentParagraph.length === 0) return;
    paragraphs.push(currentParagraph.join(' ').trim());
    currentParagraph = [];
  };

  for (const line of bodyLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }
    if (!title && trimmed.startsWith('#')) {
      title = trimmed.replace(/^#+\s*/, '').trim();
      continue;
    }
    currentParagraph.push(trimmed);
  }
  flushParagraph();

  const description = paragraphs[0] || undefined;
  const summary = paragraphs.slice(0, 3).join('\n\n').trim() || undefined;

  return {
    title: title || undefined,
    description,
    summary,
  };
}

function readSkillDefinition(
  source: 'builtin' | 'custom',
  dirPath: string,
): ManagedSkillDefinition | null {
  const id = path.basename(dirPath).trim();
  if (!id) return null;

  const skillPath = path.join(dirPath, 'SKILL.md');
  let stats: fs.Stats;
  try {
    stats = fs.statSync(skillPath);
  } catch {
    managedSkillDefinitionCache.delete(skillPath);
    return null;
  }

  const cached = managedSkillDefinitionCache.get(skillPath);
  if (
    cached &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.size === stats.size
  ) {
    return cached.value;
  }

  let name = id;
  let description: string | undefined;
  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    const parsed = parseSkillSummaryFromMarkdown(content);
    if (parsed.title) name = parsed.title;
    description = parsed.description;
  } catch {
    // Fallback to directory name
  }

  const value = { id, name, description, source, dirPath };
  managedSkillDefinitionCache.set(skillPath, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    value,
  });
  return value;
}

function listSkillDirectories(
  source: 'builtin' | 'custom',
  rootDir: string,
): ManagedSkillDefinition[] {
  if (!fs.existsSync(rootDir)) return [];

  const output: ManagedSkillDefinition[] = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(rootDir, entry.name);
    const parsed = readSkillDefinition(source, dirPath);
    if (parsed) output.push(parsed);
  }
  return output;
}

export function listManagedSkills(
  projectRoot = process.cwd(),
): ManagedSkillDefinition[] {
  const builtinRoot = path.join(projectRoot, BUILTIN_SKILLS_ROOT_RELATIVE);
  const builtins = listSkillDirectories('builtin', builtinRoot);
  const customs = listSkillDirectories('custom', CUSTOM_SKILLS_ROOT);

  // Custom skills override builtin ids with the same folder name.
  const merged = new Map<string, ManagedSkillDefinition>();
  for (const skill of builtins) merged.set(skill.id, skill);
  for (const skill of customs) merged.set(skill.id, skill);
  return Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function getManagedSkillDetail(
  skillId: string,
  projectRoot = process.cwd(),
): ManagedSkillDetail | null {
  const normalizedSkillId = skillId.trim();
  if (!normalizedSkillId) return null;

  const skill = listManagedSkills(projectRoot).find(
    (entry) => entry.id === normalizedSkillId,
  );
  if (!skill) return null;

  let summary: string | undefined;
  try {
    const content = fs.readFileSync(
      path.join(skill.dirPath, 'SKILL.md'),
      'utf8',
    );
    summary = parseSkillSummaryFromMarkdown(content).summary;
  } catch {
    // Ignore summary read failure and still return metadata.
  }

  return {
    ...skill,
    summary,
  };
}

export function parseEnabledSkillsConfig(
  raw: string | undefined,
): Set<string> | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Stored enabled skills config is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Enabled skills config must be a JSON array of skill ids');
  }
  const output = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(
        'Enabled skills config must only contain non-empty strings',
      );
    }
    output.add(entry.trim());
  }
  return output;
}

export function serializeEnabledSkillsConfig(ids: Iterable<string>): string {
  return JSON.stringify(
    Array.from(ids)
      .map((id) => id.trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b)),
  );
}

export function normalizeSkillId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized;
}

export function writeCustomSkill(
  skillId: string,
  name: string,
  description: string,
  content: string,
): ManagedSkillDefinition {
  const normalizedId = normalizeSkillId(skillId);
  if (!normalizedId) {
    throw new Error('Invalid skill id');
  }
  const normalizedName = name.trim() || normalizedId;
  const body = content.trim();
  if (!body) {
    throw new Error('Skill content is required');
  }

  const dirPath = path.join(CUSTOM_SKILLS_ROOT, normalizedId);
  fs.mkdirSync(dirPath, { recursive: true });
  const skillMdPath = path.join(dirPath, 'SKILL.md');

  const fullContent = [
    `# ${normalizedName}`,
    description.trim() ? `\n${description.trim()}` : '',
    '\n',
    body,
    '\n',
  ].join('\n');

  fs.writeFileSync(skillMdPath, fullContent, 'utf-8');
  managedSkillDefinitionCache.delete(skillMdPath);

  void saveToFileStore({
    category: 'skill',
    pathRef: `${normalizedId}/SKILL.md`,
    content: fullContent,
    diskPath: skillMdPath,
    metadata: { name: normalizedName, description: description.trim() || '' },
  }).catch((err) => {
    logger.debug({ err, skillId: normalizedId }, 'Failed to save skill to file store');
  });

  return {
    id: normalizedId,
    name: normalizedName,
    description: description.trim() || undefined,
    source: 'custom',
    dirPath,
  };
}

export function deleteCustomSkill(skillId: string): void {
  const normalizedId = normalizeSkillId(skillId);
  if (!normalizedId) {
    throw new Error('Invalid skill id');
  }
  const dirPath = path.join(CUSTOM_SKILLS_ROOT, normalizedId);
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Custom skill "${normalizedId}" does not exist`);
  }
  managedSkillDefinitionCache.delete(path.join(dirPath, 'SKILL.md'));
  fs.rmSync(dirPath, { recursive: true, force: true });
  void removeFileStoreByPrefix('skill', `${normalizedId}/`).catch((err) => {
    logger.debug({ err, skillId: normalizedId }, 'Failed to remove skill file store entries');
  });
}

/** @internal - for tests only. */
export function _resetManagedSkillDefinitionCacheForTests(): void {
  managedSkillDefinitionCache.clear();
}

// ──────────────────────────────────────────────────────────
// Sub-agents configuration
// ──────────────────────────────────────────────────────────

export interface SubagentsConfig {
  enabled: boolean;
  maxDepth: number;
  maxActive: number;
}

const SUBAGENTS_MAX_ACTIVE_DEFAULT = 4;
const SUBAGENTS_MAX_ACTIVE_LIMIT = 16;

function getDefaultSubagentsConfig(): SubagentsConfig {
  return {
    enabled: true,
    maxDepth: 2,
    maxActive: Math.max(
      1,
      Math.min(
        SUBAGENTS_MAX_ACTIVE_LIMIT,
        Number.parseInt(
          process.env.NANOCLAW_SUBAGENTS_MAX_ACTIVE ||
            String(SUBAGENTS_MAX_ACTIVE_DEFAULT),
          10,
        ) || SUBAGENTS_MAX_ACTIVE_DEFAULT,
      ),
    ),
  };
}

export function parseSubagentsConfig(
  raw: string | undefined,
): SubagentsConfig {
  const defaults = getDefaultSubagentsConfig();
  if (!raw || !raw.trim()) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return defaults;
  }
  const obj = parsed as Record<string, unknown>;
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : defaults.enabled;
  const maxDepth =
    typeof obj.maxDepth === 'number' &&
    Number.isFinite(obj.maxDepth) &&
    obj.maxDepth >= 1 &&
    obj.maxDepth <= 5
      ? Math.floor(obj.maxDepth)
      : defaults.maxDepth;
  const maxActive =
    typeof obj.maxActive === 'number' &&
    Number.isFinite(obj.maxActive) &&
    obj.maxActive >= 1 &&
    obj.maxActive <= SUBAGENTS_MAX_ACTIVE_LIMIT
      ? Math.floor(obj.maxActive)
      : defaults.maxActive;
  return { enabled, maxDepth, maxActive };
}

export function serializeSubagentsConfig(config: SubagentsConfig): string {
  return JSON.stringify({
    enabled: config.enabled,
    maxDepth: config.maxDepth,
    maxActive: config.maxActive,
  });
}
