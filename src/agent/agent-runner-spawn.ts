import { ChildProcess, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

import os from 'os';

import { type AccessPolicy } from '../auth/access-policy.js';
import { DATA_DIR, TIMEZONE } from '../config.js';
import { readEnvFile } from '../env.js';
import {
  getDefaultProvider,
  getDefaultProviderForUser,
  getConfig,
  getProvider,
  listUserMcpServers,
  isProviderVisibleToUser,
} from '../db.js';
import { resolveUserMcpRuntimeConfig } from '../user/user-mcp-service.js';
import type { UserMcpTransport } from '../user/user-mcp-service.js';
import {
  ensureUserDirectories,
  resolveUserUploadsDir,
} from '../tenant/tenant-paths.js';
import { resolveGroupRuntimeIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { buildAgentEnv } from '../provider/provider-registry.js';
import {
  parseManagedMcpServersConfig,
  parseSubagentsConfig,
  toAgentMcpServerMap,
  WEB_MCP_SERVERS_CONFIG_KEY,
  WEB_SUBAGENTS_CONFIG_KEY,
} from '../runtime/runtime-customization.js';
import { RegisteredGroup } from '../types.js';
import { buildWebSearchRunnerEnv } from '../config/web-search-config.js';
import { resolveLocalCapabilityForUserId } from '../auth/local-capability-policy.js';
import { isFeatureEnabled } from '../auth/web-security.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import {
  getInternalApiBaseUrl,
  getInternalApiToken,
} from '../auth/internal-api-auth.js';
import { getConfigValues } from '../config-store.js';
import { getNodeExecutable } from '../node-executable.js';
import type { AgentRunInput } from './agent-runner-types.js';
import { MEMORY_ENV_KEYS } from './agent-runner-types.js';
import {
  resolveMountedRunExecutionContext,
  type ResolvedRunExecutionContext,
  type VolumeMount,
} from './agent-runner-mounts.js';
import { getProfileForChat } from '../workteam/runner-profile-registry.js';
import { mergeProfileEnv } from '../workteam/runner-profiles.js';
import { t } from '../i18n/index.js';

const isWin = os.platform() === 'win32';

/**
 * Read secrets for the selected AI provider.
 *
 * - AI_PROVIDER=codex  → starts local proxy, SDK connects to localhost
 *   with the real Claude AUTH_TOKEN from system env, proxy rewrites
 *   auth and forwards to CODEX_BASE_URL with CODEX_API_KEY.
 * - AI_PROVIDER=claude → reads ANTHROPIC_* from system environment variables
 *
 * Either way the output uses ANTHROPIC_* keys that the SDK expects.
 */

export class ProviderResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderResolutionError';
  }
}

export async function readSecrets(
  input?: Pick<AgentRunInput, 'providerOverrideId' | 'modelOverride'> & {
    userId?: string;
  },
): Promise<Record<string, string>> {
  const commonKeys = [
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'DISABLE_ERROR_REPORTING',
    'DISABLE_TELEMETRY',
  ];
  const common: Record<string, string> = readEnvFile(commonKeys);

  // CODEX_MAX_TOOL_ITERATIONS: DB-only, ignore .env
  const dbIter = await getConfigValues(['CODEX_MAX_TOOL_ITERATIONS']);
  common.CODEX_MAX_TOOL_ITERATIONS = dbIter.CODEX_MAX_TOOL_ITERATIONS || '120';

  // Priority: user BYOK provider > DB default provider > any visible provider
  // No .env fallback — all provider config must come from the database.
  const preferredProviderId = input?.providerOverrideId?.trim();
  const preferredModel = input?.modelOverride?.trim();
  const userId = input?.userId;

  let dbProvider = preferredProviderId
    ? await getProvider(preferredProviderId)
    : undefined;

  if (preferredProviderId && !dbProvider) {
    throw new ProviderResolutionError(
      t(
        'errors.providerNotFound',
        { providerId: preferredProviderId },
        undefined,
      ),
    );
  }

  // Enforce visibility: reject provider overrides invisible to this user
  if (dbProvider && userId && dbProvider.user_id !== userId) {
    const visible = await isProviderVisibleToUser(dbProvider.id, userId);
    if (!visible) {
      throw new ProviderResolutionError(
        t(
          'errors.providerAccessDenied',
          { providerName: dbProvider.alias },
          undefined,
        ),
      );
    }
  }

  if (!dbProvider) {
    dbProvider = userId
      ? await getDefaultProviderForUser(userId)
      : await getDefaultProvider();
  }

  if (dbProvider) {
    const resolvedModel = preferredModel || dbProvider.model || '';
    logger.info(
      {
        provider: dbProvider.type,
        alias: dbProvider.alias,
        model: resolvedModel || dbProvider.model,
      },
      `AI Provider from DB: ${dbProvider.alias}`,
    );

    const agentEnv = buildAgentEnv(dbProvider, resolvedModel, common);

    // For claude type, also read system env as fallback
    if (dbProvider.type === 'claude') {
      const claudeEnvKeys = [
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_REASONING_MODEL',
      ];
      for (const key of claudeEnvKeys) {
        if (process.env[key] && !agentEnv[key])
          agentEnv[key] = process.env[key]!;
      }
    }

    // Codex-specific: preserve max tool iterations
    if (dbProvider.type === 'codex') {
      agentEnv.CODEX_MAX_TOOL_ITERATIONS =
        common.CODEX_MAX_TOOL_ITERATIONS || '';
    }

    return agentEnv;
  }

  throw new ProviderResolutionError(
    t('errors.auto_cd3371', {}, undefined),
  );
}

/**
 * Ensure the agent-runner is compiled.
 * Compiles from per-group source into a dist directory.
 * Returns the path to the compiled index.js.
 */

// Keys that must be stripped from the inherited env and replaced via stdin
const SECRETS_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_REASONING_MODEL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_TELEMETRY',
];

function needsRecompile(srcDir: string, distEntry: string): boolean {
  if (!fs.existsSync(distEntry)) return true;
  const srcPath = path.join(srcDir, 'src');
  if (!fs.existsSync(srcPath)) return false;
  try {
    const distMtime = fs.statSync(distEntry).mtimeMs;
    const srcFiles = fs.readdirSync(srcPath, {
      recursive: true,
    }) as string[];
    return srcFiles.some((f) => {
      const full = path.join(srcPath, f);
      return (
        fs.statSync(full).isFile() && fs.statSync(full).mtimeMs > distMtime
      );
    });
  } catch {
    return true;
  }
}

function ensureAgentRunnerNodeModulesLink(
  groupDistDir: string,
  nodeModules: string,
): void {
  const distNodeModules = path.join(groupDistDir, 'node_modules');

  const pointsToExpectedTarget = (): boolean => {
    try {
      const stat = fs.lstatSync(distNodeModules);
      if (!stat.isSymbolicLink()) return false;
      const target = fs.readlinkSync(distNodeModules);
      const resolvedTarget = path.resolve(groupDistDir, target);
      return resolvedTarget === nodeModules;
    } catch {
      return false;
    }
  };

  if (pointsToExpectedTarget()) return;

  try {
    const stat = fs.lstatSync(distNodeModules);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(distNodeModules);
    } else {
      fs.rmSync(distNodeModules, { recursive: true, force: true });
    }
  } catch {
    // ignore missing path or transient cleanup errors and retry creating below
  }

  fs.mkdirSync(groupDistDir, { recursive: true });

  try {
    fs.symlinkSync(nodeModules, distNodeModules, isWin ? 'junction' : 'dir');
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code === 'EEXIST' &&
      pointsToExpectedTarget()
    ) {
      return;
    }
    // Symlink not supported (e.g. some K8s volume types) — fall back to copy
    logger.debug({ err }, 'Symlink failed, copying node_modules instead');
    try {
      fs.cpSync(nodeModules, distNodeModules, { recursive: true });
    } catch (copyErr) {
      logger.warn(
        { err: copyErr },
        'Failed to copy node_modules fallback, agent runner may not resolve dependencies',
      );
    }
  }
}

function copyPrebuiltDist(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) {
      copyPrebuiltDist(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

const execFileAsync = promisify(execFile);

async function ensureAgentRunnerCompiled(groupFolder: string): Promise<string> {
  const projectRoot = process.cwd();
  const groupDistDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    'agent-runner-dist',
  );

  const agentRunnerRoot = path.join(projectRoot, 'agent', 'runner');
  const nodeModules = path.join(agentRunnerRoot, 'node_modules');

  if (!fs.existsSync(nodeModules)) {
    logger.info('Installing agent-runner dependencies');
    const npmBin = isWin ? 'npm.cmd' : 'npm';
    await execFileAsync(npmBin, ['install'], { cwd: agentRunnerRoot });
  }

  const entryJs = path.join(groupDistDir, 'index.js');
  ensureAgentRunnerNodeModulesLink(groupDistDir, nodeModules);

  if (!needsRecompile(agentRunnerRoot, entryJs)) {
    logger.debug('Agent-runner already compiled, skipping');
    return entryJs;
  }

  const prebuiltDist = path.join(agentRunnerRoot, 'dist');
  const tscBin = path.join(nodeModules, '.bin', isWin ? 'tsc.cmd' : 'tsc');
  const hasTsc = fs.existsSync(tscBin);
  const hasPrebuilt = fs.existsSync(path.join(prebuiltDist, 'index.js'));

  if (!hasTsc && hasPrebuilt) {
    logger.info('Using pre-built agent-runner dist (tsc unavailable)');
    copyPrebuiltDist(prebuiltDist, groupDistDir);
    ensureAgentRunnerNodeModulesLink(groupDistDir, nodeModules);
    return entryJs;
  }

  if (!hasTsc) {
    throw new Error(
      'Agent runner needs compilation but tsc is not available and no pre-built dist found. ' +
        'Install devDependencies or provide a pre-built agent/runner/dist.',
    );
  }

  const tsconfig = path.join(agentRunnerRoot, 'tsconfig.json');

  logger.info('Compiling agent-runner');
  await execFileAsync(
    tscBin,
    ['--project', tsconfig, '--outDir', groupDistDir],
    {
      cwd: agentRunnerRoot,
      windowsHide: true,
    },
  );

  ensureAgentRunnerNodeModulesLink(groupDistDir, nodeModules);

  return entryJs;
}

/**
 * Spawn the agent process with per-group path mappings.
 */
export async function spawnAgent(
  group: RegisteredGroup,
  mounts: VolumeMount[],
  input: AgentRunInput,
  accessPolicy: AccessPolicy,
  executionContext: ResolvedRunExecutionContext,
): Promise<ChildProcess> {
  const entryJs = await ensureAgentRunnerCompiled(group.folder);
  const mcpServerPath = path.join(path.dirname(entryJs), 'ipc-mcp-stdio.js');
  const agentRunnerRoot = path.join(process.cwd(), 'agent', 'runner');
  const internalApiBaseUrl = await getInternalApiBaseUrl();
  const internalApiToken = getInternalApiToken();

  if (input.userId) ensureUserDirectories(input.userId);

  const mountMap: Record<string, string> = {};
  for (const m of mounts) {
    mountMap[m.targetPath] = m.hostPath;
  }

  const memoryEnv = await getConfigValues([...MEMORY_ENV_KEYS]);
  const browserCliCapability = await resolveLocalCapabilityForUserId(
    'browserControl',
    input.userId,
    {
      // browser_cli fetch uses local browser commands but is not governed by
      // WEB_BROWSER_ENABLED, so only the deployment-mode + permission policy
      // is applied here.
      configEnabled: true,
    },
  );
  const webSearchEnv = await buildWebSearchRunnerEnv({
    allowBrowserCli: browserCliCapability.available,
  });

  const ENV_PASSTHROUGH_KEYS = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TEMP',
    'TMP',
    // Windows essentials
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramFiles',
    'ProgramFiles(x86)',
    // TLS / proxy (needed for corporate environments)
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    // Git
    'GIT_SSH',
    'GIT_SSH_COMMAND',
  ];

  // Workteam SDLC tasks register a Runner Profile per chatJid. If present, its
  // `extraPassthrough` list is appended to the default passthrough whitelist,
  // and its `pathPrepend` + `extra` env are merged at the end of env assembly.
  const runnerProfile = getProfileForChat(input.chatJid);
  const passthroughKeys = runnerProfile?.env.extraPassthrough?.length
    ? [...ENV_PASSTHROUGH_KEYS, ...runnerProfile.env.extraPassthrough]
    : ENV_PASSTHROUGH_KEYS;
  const safeBaseEnv: Record<string, string | undefined> = {};
  for (const key of passthroughKeys) {
    if (process.env[key] !== undefined) safeBaseEnv[key] = process.env[key];
  }

  const env: Record<string, string | undefined> = {
    ...safeBaseEnv,
    NANOCLAW_GROUP_DIR: mountMap['/workspace/group'] || '',
    NANOCLAW_GLOBAL_DIR: mountMap['/workspace/global'] || '',
    NANOCLAW_IPC_DIR: mountMap['/workspace/ipc'] || '',
    NANOCLAW_UPLOADS_DIR:
      mountMap['/workspace/uploads'] ||
      resolveUserUploadsDir(input.userId || ''),
    NANOCLAW_EXTRA_DIR:
      mountMap['/workspace/extra'] || path.join(process.cwd(), 'data', 'extra'),
    NANOCLAW_SKILLS_DIR: mountMap['/workspace/skills'] || '',
    NANOCLAW_SOUL_SYSTEM_PROMPT: input.soulSystemPrompt || '',
    NANOCLAW_ASSISTANT_INSTRUCTIONS_APPEND: input.instructionsAppend || '',
    NANOCLAW_ASSISTANT_RULE_MODE: input.assistantRuleMode || 'append',
    NANOCLAW_USER_ID: input.userId || '',
    NANOCLAW_WORKSPACE_EXTRA_HINT: JSON.stringify(
      executionContext.workspaceExtraDirectories.map((entry) => ({
        label: entry.label,
        hostPath: entry.hostPath,
      })),
    ),
    ...webSearchEnv,
    ...memoryEnv,
    TZ: TIMEZONE,
    NODE_PATH: path.join(agentRunnerRoot, 'node_modules'),
  };
  const inheritedNodeOptions = String(env.NODE_OPTIONS || '').trim();
  const nodeOptionTokens = inheritedNodeOptions
    ? inheritedNodeOptions.split(/\s+/).filter(Boolean)
    : [];
  const nodeOptions = nodeOptionTokens.includes('--use-system-ca')
    ? inheritedNodeOptions
    : [...nodeOptionTokens, '--use-system-ca'].join(' ').trim();
  if (input.disableDefaultWebSearch) {
    env.NANOCLAW_WEB_SEARCH_ENABLED = 'false';
  }
  const subagentsConfig = parseSubagentsConfig(
    await getConfig(WEB_SUBAGENTS_CONFIG_KEY),
  );
  env.NANOCLAW_SUBAGENTS_ENABLED = subagentsConfig.enabled ? '1' : '0';
  env.NANOCLAW_SUBAGENTS_MAX_DEPTH = String(subagentsConfig.maxDepth);
  env.NANOCLAW_SUBAGENTS_MAX_ACTIVE = String(subagentsConfig.maxActive);
  env.NANOCLAW_SUBAGENT_DEPTH = String(
    Math.max(0, Number.parseInt(env.NANOCLAW_SUBAGENT_DEPTH || '0', 10) || 0),
  );
  env.NANOCLAW_SUBAGENT_ROLE =
    String(env.NANOCLAW_SUBAGENT_ROLE || 'main').trim() || 'main';
  env.NANOCLAW_SUBAGENT_CONTROL_SCOPE =
    String(env.NANOCLAW_SUBAGENT_CONTROL_SCOPE || 'children').trim() === 'none'
      ? 'none'
      : 'children';
  for (const key of SECRETS_KEYS) delete env[key];
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;

  // Pass available knowledge base metadata to the agent: assistant-bound + user-enabled KBs.
  try {
    const { listKnowledgeBases, countKnowledgeDocuments } =
      await import('../db.js');
    const { listEnabledKbIdsForUser } =
      await import('../knowledge/user-kb-service.js');
    const allKbs = await listKnowledgeBases();
    const assistantKbIds = new Set(
      (input.managedKbIds ?? []).map((id) => String(id).trim()).filter(Boolean),
    );
    const userKbIds = input.userId
      ? new Set(await listEnabledKbIdsForUser(input.userId))
      : new Set<string>();
    const availableKbs = allKbs.filter(
      (kb) =>
        assistantKbIds.has(kb.id) ||
        userKbIds.has(kb.id) ||
        (kb.enabled && kb.visibility === 'shared'),
    );
    if (availableKbs.length > 0) {
      env.NANOCLAW_AVAILABLE_KB_IDS = JSON.stringify(
        availableKbs.map((kb) => kb.id),
      );
      const kbMeta = await Promise.all(
        availableKbs.map(async (kb) => {
          let docCount = 0;
          try {
            docCount = await countKnowledgeDocuments(kb.id);
          } catch {
            /* ignore */
          }
          return {
            id: kb.id,
            name: kb.name,
            description: kb.description || '',
            docCount,
          };
        }),
      );
      env.NANOCLAW_AVAILABLE_KB_META = JSON.stringify(kbMeta);
    }
  } catch {
    /* non-fatal */
  }

  logger.info({ group: group.name, entryJs, mode: 'direct' }, 'Spawning agent');

  const configuredAllowedDirs = accessPolicy.directories;
  const allowedDirs = JSON.stringify(
    Array.from(
      new Set(
        [
          ...configuredAllowedDirs,
          mountMap['/workspace/project'],
          mountMap['/workspace/group'],
          mountMap['/workspace/global'],
          mountMap['/workspace/uploads'],
          mountMap['/workspace/extra'],
          mountMap['/workspace/skills'],
        ].filter((entry): entry is string => Boolean(entry)),
      ),
    ),
  );

  const allowInsecureTls = isFeatureEnabled(
    (await getConfig('ALLOW_INSECURE_TLS')) ||
      readEnvFile(['ALLOW_INSECURE_TLS']).ALLOW_INSECURE_TLS ||
      process.env.ALLOW_INSECURE_TLS,
  );
  const managedMcpServers = await (async () => {
    let base: Record<
      string,
      {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        transport?: UserMcpTransport;
        url?: string;
        cwd?: string;
      }
    > = {};
    if (Array.isArray(input.resolvedManagedMcpServers)) {
      base = Object.fromEntries(
        input.resolvedManagedMcpServers.map((server) => [
          server.id,
          {
            command: server.command,
            args: server.args,
            ...(Object.keys(server.env || {}).length > 0
              ? { env: server.env }
              : {}),
          },
        ]),
      );
    } else {
      try {
        const parsed = parseManagedMcpServersConfig(
          await getConfig(WEB_MCP_SERVERS_CONFIG_KEY),
        );
        if (Array.isArray(input.managedMcpServerIds)) {
          const allowlist = new Set(
            input.managedMcpServerIds
              .map((entry) => String(entry || '').trim())
              .filter(Boolean),
          );
          base = toAgentMcpServerMap(
            parsed.filter((server) => allowlist.has(server.id)),
          );
        } else {
          base = toAgentMcpServerMap(parsed);
        }
      } catch (err) {
        logger.warn(
          { err },
          'Failed to parse managed MCP servers config, falling back to built-in MCP only',
        );
      }
    }

    // Merge user-level MCP servers from DB.
    // When userMcpServerIds is set (assistant session), only those specific
    // servers are loaded; otherwise all enabled user servers are available.
    try {
      const userId = input.userId || getCurrentUserId();
      const userServers = await listUserMcpServers({ userId, enabled: true });
      const seen = new Set(Object.keys(base));
      const allowedUserMcp = Array.isArray(input.userMcpServerIds)
        ? new Set(
            input.userMcpServerIds
              .map((id) => String(id).trim())
              .filter(Boolean),
          )
        : null;
      for (const srv of userServers) {
        if (seen.has(srv.id)) continue;
        if (allowedUserMcp && !allowedUserMcp.has(srv.id)) continue;
        seen.add(srv.id);
        const resolved = resolveUserMcpRuntimeConfig(srv);
        base[srv.id] = {
          transport: resolved.transport,
          ...(resolved.transport === 'stdio'
            ? {
                command: resolved.command,
                args: resolved.args,
                ...(Object.keys(resolved.env).length > 0 ? { env: resolved.env } : {}),
              }
            : {
                url: resolved.url || undefined,
                ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
                ...(Object.keys(resolved.env).length > 0 ? { env: resolved.env } : {}),
              }),
        };
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to merge user MCP servers');
    }

    return base;
  })();
  const extraMcpServers = {
    ...managedMcpServers,
    nanoclaw: {
      command: getNodeExecutable(),
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: input.chatJid,
        NANOCLAW_GROUP_FOLDER: input.groupFolder,
        NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
        NANOCLAW_INTERNAL_API_BASE: internalApiBaseUrl,
        NANOCLAW_INTERNAL_API_TOKEN: internalApiToken,
        NANOCLAW_IPC_DIR: mountMap['/workspace/ipc'] || '',
        NANOCLAW_GROUP_DIR: mountMap['/workspace/group'] || '',
        NANOCLAW_GLOBAL_DIR: mountMap['/workspace/global'] || '',
        NANOCLAW_USER_ID: input.userId || '',
        NANOCLAW_REVIEW_REPOSITORY_IDS: JSON.stringify(
          group.agentConfig?.reviewRepositoryIds || [],
        ),
        ...(env.NANOCLAW_AVAILABLE_KB_IDS
          ? { NANOCLAW_AVAILABLE_KB_IDS: env.NANOCLAW_AVAILABLE_KB_IDS }
          : {}),
        ...(env.NANOCLAW_AVAILABLE_KB_META
          ? { NANOCLAW_AVAILABLE_KB_META: env.NANOCLAW_AVAILABLE_KB_META }
          : {}),
        ...memoryEnv,
      },
    },
  };
  const mountedExecutionContext = resolveMountedRunExecutionContext(
    group,
    input,
    mountMap,
    executionContext,
  );

  const spawnCwd = mountedExecutionContext.workingRoot;
  if (!fs.existsSync(spawnCwd)) {
    fs.mkdirSync(spawnCwd, { recursive: true });
  }

  const nodeExe = getNodeExecutable();
  logger.debug({ nodeExe, entryJs, cwd: spawnCwd }, 'Spawn details');

  const bashApprovalAllowlist =
    (await getConfig('BASH_APPROVAL_ALLOWLIST')) || '[]';
  const baseSpawnEnv: Record<string, string | undefined> = {
    ...env,
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    ...(allowInsecureTls ? { NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {}),
    NANOCLAW_ALLOWED_DIRS: allowedDirs,
    NANOCLAW_BASH_APPROVAL_ALLOWLIST: bashApprovalAllowlist,
    NANOCLAW_ACCESS_MODE: accessPolicy.mode,
    NANOCLAW_INTERNAL_API_BASE: internalApiBaseUrl,
    NANOCLAW_INTERNAL_API_TOKEN: internalApiToken,
    NANOCLAW_EXTRA_MCP_SERVERS: JSON.stringify(extraMcpServers),
    ...(mountedExecutionContext.projectRoot
      ? { NANOCLAW_PROJECT_ROOT: mountedExecutionContext.projectRoot }
      : {}),
  };
  const spawnEnv = runnerProfile
    ? mergeProfileEnv(baseSpawnEnv, runnerProfile)
    : baseSpawnEnv;
  if (runnerProfile) {
    logger.info(
      { chatJid: input.chatJid, profileId: runnerProfile.id },
      'Applied runner profile env to agent spawn',
    );
  }

  return spawn(nodeExe, [entryJs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: spawnCwd,
    env: spawnEnv,
  });
}
