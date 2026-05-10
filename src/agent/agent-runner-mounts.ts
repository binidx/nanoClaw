import fs from 'fs';
import path from 'path';

import os from 'os';

import {
  type AccessMode,
  type AccessPolicy,
  resolveRuntimeAccessPolicy,
} from '../auth/access-policy.js';
import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { getConfig, listUserSkills } from '../db.js';
import {
  resolveGroupFolderPath,
  resolveGroupRuntimeIpcPath,
} from '../group-folder.js';
import { logger } from '../logger.js';
import { parseAllowedDirectoriesValue } from '../security/allowed-directories.js';
import { validateAdditionalMounts } from '../security/mount-security.js';
import {
  listManagedSkills,
  parseEnabledSkillsConfig,
  parseSubagentsConfig,
  WEB_ENABLED_SKILLS_CONFIG_KEY,
  WEB_SUBAGENTS_CONFIG_KEY,
} from '../runtime/runtime-customization.js';
import { RegisteredGroup } from '../types.js';
import type { AgentRunInput } from './agent-runner-types.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';

const isWin = os.platform() === 'win32';
const DEV_NULL = isWin ? 'NUL' : '/dev/null';

export interface VolumeMount {
  hostPath: string;
  targetPath: string;
  readonly: boolean;
}

export interface ResolvedRunExecutionContext {
  projectRoot?: string;
  preferredWorkingDirectory?: string;
  workspaceExtraDirectories: Array<{ hostPath: string; label: string }>;
}

export interface MountedRunExecutionContext {
  projectRoot?: string;
  workingRoot: string;
}

function sanitizeRuntimeNamespace(value: string | undefined): string {
  return (value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function normalizeExtraMounts(
  mounts: AgentRunInput['extraMounts'],
): VolumeMount[] {
  if (!Array.isArray(mounts) || mounts.length === 0) return [];
  return mounts
    .map((mount) => ({
      hostPath: String(mount?.hostPath || '').trim(),
      targetPath: String(mount?.targetPath || '').trim(),
      readonly: mount?.readonly !== false,
    }))
    .filter((mount) => mount.hostPath && mount.targetPath);
}

function sanitizeWorkspaceExtraDirLabel(
  hostPath: string,
  index: number,
): string {
  const basename = path.basename(hostPath) || `dir-${index + 2}`;
  const normalized = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `${String(index + 2).padStart(2, '0')}-${normalized || 'dir'}`;
}

function normalizeWorkspaceExtraDirectories(
  value: AgentRunInput['workspaceExtraDirectories'],
  primaryProjectRoot: string | undefined,
): Array<{ hostPath: string; label: string }> {
  if (!Array.isArray(value) || value.length === 0) return [];
  const seen = new Set<string>();
  const normalized: Array<{ hostPath: string; label: string }> = [];
  for (const entry of value) {
    const hostPath = String(entry || '').trim();
    if (!hostPath || !path.isAbsolute(hostPath)) continue;
    if ((primaryProjectRoot && hostPath === primaryProjectRoot) || seen.has(hostPath)) {
      continue;
    }
    seen.add(hostPath);
    normalized.push({
      hostPath,
      label: sanitizeWorkspaceExtraDirLabel(hostPath, normalized.length),
    });
  }
  return normalized;
}

function deriveWorkspaceExtraDirectories(
  input: AgentRunInput,
  accessPolicy: AccessPolicy,
): string[] {
  if (Array.isArray(input.workspaceExtraDirectories)) {
    return input.workspaceExtraDirectories;
  }
  if (
    input.restrictProjectRootInheritance &&
    Array.isArray(input.allowedDirectoriesOverride)
  ) {
    return input.allowedDirectoriesOverride;
  }
  if (accessPolicy.directories.length > 1) {
    return accessPolicy.directories;
  }
  return [];
}

export function resolveRunExecutionContext(
  group: RegisteredGroup,
  input: AgentRunInput,
  accessPolicy: AccessPolicy,
): ResolvedRunExecutionContext {
  const preferredWorkingDirectory =
    (input.workingDirectory && path.isAbsolute(input.workingDirectory)
      ? input.workingDirectory
      : undefined) || group.agentConfig?.workingDirectory;
  const projectRoot = resolveWorkspaceProjectRoot(group, input, accessPolicy);
  return {
    projectRoot,
    preferredWorkingDirectory,
    workspaceExtraDirectories: normalizeWorkspaceExtraDirectories(
      deriveWorkspaceExtraDirectories(input, accessPolicy),
      projectRoot,
    ),
  };
}

export function resolveMountedRunExecutionContext(
  group: RegisteredGroup,
  input: AgentRunInput,
  mountMap: Record<string, string>,
  executionContext: ResolvedRunExecutionContext,
): MountedRunExecutionContext {
  const mountedWorkingDirectory = input.workingDirectory
    ? mountMap[input.workingDirectory]
    : undefined;
  return {
    projectRoot: executionContext.projectRoot,
    workingRoot:
      mountedWorkingDirectory ||
      executionContext.preferredWorkingDirectory ||
      mountMap['/workspace/project'] ||
      mountMap['/workspace/group'] ||
      executionContext.projectRoot ||
      process.cwd(),
  };
}

export async function resolveRunAccessPolicy(
  group: RegisteredGroup,
  input: AgentRunInput,
): Promise<{ mode: AccessMode; directories: string[]; }> {
  let defaultDirectories: string[] = [];
  try {
    defaultDirectories = parseAllowedDirectoriesValue(
      await getConfig('allowed_directories'),
    );
  } catch {
    defaultDirectories = [];
  }

  const hasRepoScope =
    Array.isArray(input.allowedDirectoriesOverride) &&
    input.allowedDirectoriesOverride.length > 0;

  return resolveRuntimeAccessPolicy({
    defaultMode: hasRepoScope ? 'allowlist' : await getConfig('DEFAULT_ACCESS_MODE'),
    defaultDirectories: hasRepoScope ? input.allowedDirectoriesOverride! : defaultDirectories,
    override: {
      mode: hasRepoScope ? 'allowlist' : input.accessModeOverride,
      directories: input.allowedDirectoriesOverride,
    },
    configured: group.agentConfig,
  });
}

function resolveWorkspaceProjectRoot(
  group: RegisteredGroup,
  input: AgentRunInput,
  accessPolicy: { mode: AccessMode; directories: string[] },
): string | undefined {
  const projectRootOverride = input.projectRootOverride?.trim();
  if (projectRootOverride) return projectRootOverride;

  const configuredProjectRoot = group.agentConfig?.projectRoot?.trim();
  if (configuredProjectRoot) return configuredProjectRoot;

  const configuredDirectory = accessPolicy.directories[0]?.trim();
  if (configuredDirectory) return configuredDirectory;

  if (input.workingDirectory && path.isAbsolute(input.workingDirectory)) {
    return input.workingDirectory;
  }

  const groupWorkingDirectory = group.agentConfig?.workingDirectory?.trim();
  if (groupWorkingDirectory && path.isAbsolute(groupWorkingDirectory)) {
    return groupWorkingDirectory;
  }

  return undefined;
}

export async function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  input: AgentRunInput,
  executionContext: ResolvedRunExecutionContext,
): Promise<VolumeMount[]> {
  const mounts: VolumeMount[] = [];
  const groupDir = resolveGroupFolderPath(group.folder);
  const appRoot = process.cwd();
  const { projectRoot, workspaceExtraDirectories } = executionContext;

  if (projectRoot) {
    mounts.push({
      hostPath: projectRoot,
      targetPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Secrets are passed via stdin instead (see readSecrets()).
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: DEV_NULL,
        targetPath: '/workspace/project/.env',
        readonly: true,
      });
    }
  }

  mounts.push({
    hostPath: groupDir,
    targetPath: '/workspace/group',
    readonly: false,
  });

  // Provide a stable global workspace for both main runs and subagents.
  const globalDir = path.resolve(GROUPS_DIR, 'global');
  fs.mkdirSync(globalDir, { recursive: true });
  mounts.push({
    hostPath: globalDir,
    targetPath: '/workspace/global',
    readonly: !isMain,
  });

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const runtimeNamespace = sanitizeRuntimeNamespace(input.runtimeNamespace);
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    ...(runtimeNamespace ? [runtimeNamespace] : []),
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const subagentsConfig = parseSubagentsConfig(
    await getConfig(WEB_SUBAGENTS_CONFIG_KEY),
  );
  // Always regenerate settings.json so subagent config changes take effect
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        env: {
          // NanoClaw owns all sub-agent orchestration via its managed
          // TeamCreate/SendMessage/TeamDelete tools with depth control.
          // Disable Claude Code's native agent-teams to prevent the SDK
          // from spawning unmanaged sub-agents that bypass depth limits.
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0',
          // Load CLAUDE.md from additional mounted directories
          // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          // Enable Claude's memory feature (persists user preferences between sessions)
          // https://code.claude.com/docs/en/memory#manage-auto-memory
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
        },
      },
      null,
      2,
    ) + '\n',
  );

  // Sync enabled managed skills (builtin + custom) into each group's .claude/skills/
  const skillsDst = path.join(groupSessionsDir, 'skills');
  fs.rmSync(skillsDst, { recursive: true, force: true });
  fs.mkdirSync(skillsDst, { recursive: true });

  const enabledSkills = await (async (): Promise<Set<string> | null> => {
    if (Array.isArray(input.managedSkillIds)) {
      return new Set(
        input.managedSkillIds
          .map((entry) => String(entry || '').trim())
          .filter(Boolean),
      );
    }
    try {
      return parseEnabledSkillsConfig(await getConfig(WEB_ENABLED_SKILLS_CONFIG_KEY));
    } catch (err) {
      logger.warn(
        { err },
        'Failed to parse enabled skills config, falling back to all skills',
      );
      return null;
    }
  })();
  const managedSkills = listManagedSkills(appRoot);
  for (const skill of managedSkills) {
    if (enabledSkills && !enabledSkills.has(skill.id)) continue;
    const dstDir = path.join(skillsDst, skill.id);
    try {
      fs.cpSync(skill.dirPath, dstDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { err, skillId: skill.id, source: skill.source },
        'Failed to sync managed skill',
      );
    }
  }

  // Sync user's own enabled skills from DB.
  // When userSkillIds is set (assistant session), only those specific skills
  // are loaded; otherwise all enabled user skills are available.
  try {
    const userId = input.userId || getCurrentUserId();
    const userSkills = await listUserSkills({ userId, enabled: true });
    const seen = new Set(managedSkills.map((s) => s.id));
    const allowedUserSkills = Array.isArray(input.userSkillIds)
      ? new Set(input.userSkillIds.map((id) => String(id).trim()).filter(Boolean))
      : null;
    for (const skill of userSkills) {
      if (seen.has(skill.id)) continue;
      if (allowedUserSkills && !allowedUserSkills.has(skill.id)) continue;
      seen.add(skill.id);
      if (!skill.skill_content) continue;
      const dstDir = path.join(skillsDst, skill.id);
      try {
        fs.mkdirSync(dstDir, { recursive: true });
        fs.writeFileSync(path.join(dstDir, 'SKILL.md'), skill.skill_content, 'utf-8');
      } catch (err) {
        logger.warn(
          { err, skillId: skill.id },
          'Failed to sync user skill',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to sync user skills from DB');
  }
  mounts.push({
    hostPath: groupSessionsDir,
    targetPath: path.join(process.env.HOME || os.homedir(), '.claude'),
    readonly: false,
  });
  mounts.push({
    hostPath: skillsDst,
    targetPath: '/workspace/skills',
    readonly: true,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupRuntimeIpcPath(
    group.folder,
    input.runtimeNamespace,
  );
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    targetPath: '/workspace/ipc',
    readonly: false,
  });

  const uploadsDir = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  mounts.push({
    hostPath: uploadsDir,
    targetPath: '/workspace/uploads',
    readonly: true,
  });

  if (workspaceExtraDirectories.length > 0) {
    const workspaceExtraRoot = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      'workspace-extra',
    );
    fs.rmSync(workspaceExtraRoot, { recursive: true, force: true });
    fs.mkdirSync(workspaceExtraRoot, { recursive: true });
    for (const entry of workspaceExtraDirectories) {
      const linkPath = path.join(workspaceExtraRoot, entry.label);
      fs.symlinkSync(entry.hostPath, linkPath, isWin ? 'junction' : 'dir');
    }
    mounts.push({
      hostPath: workspaceExtraRoot,
      targetPath: '/workspace/extra',
      readonly: true,
    });
  }

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on agent startup.
  const agentRunnerSrc = path.join(appRoot, 'agent', 'runner', 'src');
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    fs.mkdirSync(groupAgentRunnerDir, { recursive: true });
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, {
      recursive: true,
      force: true,
    });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    targetPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from agents)
  if (group.agentConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.agentConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  mounts.push(...normalizeExtraMounts(input.extraMounts));

  return mounts;
}
