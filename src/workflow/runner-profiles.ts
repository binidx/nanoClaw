import fs from 'fs';
import path from 'path';
import {
  createBinding,
  deleteBinding,
  listBindingsByResource,
  type ResourceBindingRecord,
} from '../db/resource-bindings.js';
import { createModuleLogger } from '../logger.js';
import { detectProfilesForWorktree } from './project-detector.js';

const logger = createModuleLogger('workflow');

/**
 * Declarative description of a language/runtime "Runner Profile" used by
 * Workflow repository-bound nodes to:
 *   1. detect the language of a target repo (via `detect.files`),
 *   2. inject appropriate env into the spawned Agent process (so its Bash tool
 *      finds the right toolchain), and
 *   3. produce a sensible default test command for verification nodes.
 *
 * Phase 1 ships four built-in profiles (nodejs / java8 / go / python) as
 * constants. Custom / DB-configured profiles land in Phase 2.
 */
export interface RunnerProfile {
  id: string;
  name: string;
  description: string;
  detect: {
    /** Marker files at the worktree root that identify this language. */
    files: string[];
    /** Higher wins when multiple profiles match. */
    priority: number;
  };
  env: {
    /** Directories prepended to `PATH` before the host PATH. */
    pathPrepend?: string[];
    /** Extra env vars to set / override (e.g. `JAVA_HOME`). */
    extra?: Record<string, string>;
    /** Additional host env keys that should be passed through (beyond the
     *  default `ENV_PASSTHROUGH_KEYS` in `agent-runner-spawn.ts`). */
    extraPassthrough?: string[];
  };
  /** CLIs that must resolve in the host PATH before a run can start. */
  requiredTools: string[];
  /** Default unit test command shown to the Agent in the test task prompt. */
  testCommand: string;
  /** Substrings that indicate a successful test run; fed into `required_patterns`. */
  testSuccessPatterns: string[];
  /** Human hint printed when `validateProfileTools` fails. */
  toolHint?: string;
}

export const BUILTIN_PROFILES: RunnerProfile[] = [
  {
    id: 'nodejs',
    name: 'Node.js',
    description: 'Node.js / TypeScript projects with package.json',
    detect: { files: ['package.json'], priority: 5 },
    env: {
      extraPassthrough: ['NPM_CONFIG_REGISTRY', 'NPM_TOKEN', 'NODE_ENV'],
    },
    requiredTools: ['node', 'npm'],
    testCommand: 'npm test',
    testSuccessPatterns: ['passing', 'PASS', 'tests passed'],
    toolHint: 'Install Node.js (>=20) and npm; ensure both are on PATH.',
  },
  {
    id: 'java8',
    name: 'Java 8',
    description: 'Java 8 projects built with Maven or Gradle',
    detect: {
      files: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
      priority: 10,
    },
    env: {
      extraPassthrough: [
        'JAVA_HOME',
        'MAVEN_HOME',
        'M2_HOME',
        'GRADLE_HOME',
        'GRADLE_USER_HOME',
      ],
    },
    requiredTools: ['java'],
    testCommand: 'mvn test',
    testSuccessPatterns: ['BUILD SUCCESS', 'Tests run:'],
    toolHint:
      'Install OpenJDK 8 and Maven (or Gradle). Set JAVA_HOME to the JDK root and ensure `java` and `mvn` / `./gradlew` are on PATH.',
  },
  {
    id: 'go',
    name: 'Go',
    description: 'Go projects with go.mod',
    detect: { files: ['go.mod'], priority: 8 },
    env: {
      extraPassthrough: [
        'GOPATH',
        'GOROOT',
        'GOPROXY',
        'GO111MODULE',
        'GOCACHE',
      ],
    },
    requiredTools: ['go'],
    testCommand: 'go test ./...',
    testSuccessPatterns: ['ok  \t', 'PASS'],
    toolHint: 'Install Go (>=1.21) and ensure `go` is on PATH.',
  },
  {
    id: 'python',
    name: 'Python',
    description: 'Python projects with pyproject.toml or requirements.txt',
    detect: {
      files: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'],
      priority: 7,
    },
    env: {
      extraPassthrough: [
        'PYTHONPATH',
        'VIRTUAL_ENV',
        'PIP_INDEX_URL',
        'POETRY_HOME',
      ],
    },
    requiredTools: ['python3'],
    testCommand: 'pytest || python3 -m unittest discover',
    testSuccessPatterns: ['passed', 'OK'],
    toolHint:
      'Install Python 3 (>=3.9) and ensure `python3` (and ideally `pytest`) are on PATH.',
  },
];

export function findProfileById(
  id: string | null | undefined,
): RunnerProfile | undefined {
  const trimmed = (id || '').trim();
  if (!trimmed) return undefined;
  return BUILTIN_PROFILES.find((p) => p.id === trimmed);
}

/**
 * Produce a new env map that merges the base env with the profile's overrides.
 * - `pathPrepend` entries are joined in order and placed before the existing PATH.
 * - `extra` keys override / add entries in the returned map.
 * - The input `base` object is never mutated.
 */
export function mergeProfileEnv(
  base: Record<string, string | undefined>,
  profile: RunnerProfile,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...base };
  const sep = path.delimiter;

  const cleanedPrepend = (profile.env.pathPrepend ?? [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (cleanedPrepend.length > 0) {
    const existing = (merged.PATH ?? '').trim();
    merged.PATH = existing
      ? `${cleanedPrepend.join(sep)}${sep}${existing}`
      : cleanedPrepend.join(sep);
  }

  if (profile.env.extra) {
    for (const [k, v] of Object.entries(profile.env.extra)) {
      merged[k] = v;
    }
  }
  return merged;
}

/**
 * Default `isToolAvailable` implementation: search PATH for an executable.
 * Windows honours PATHEXT; POSIX requires the exec bit.
 */
export function defaultIsToolAvailable(tool: string): boolean {
  const name = tool.trim();
  if (!name) return false;
  const pathEnv = process.env.PATH || '';
  if (!pathEnv) return false;
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.EXE;.BAT;.CMD')
        .split(';')
        .map((e) => e.trim())
        .filter(Boolean)
    : [''];

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (isWin) {
          if (fs.existsSync(full)) return true;
        } else {
          fs.accessSync(full, fs.constants.X_OK);
          return true;
        }
      } catch {
        // Keep looking.
      }
    }
  }
  return false;
}

/**
 * Check that all required tools resolve on the current host. `isToolAvailable`
 * is injected for unit tests; production callers pass nothing to use the
 * default PATH-scan implementation.
 */
export function validateProfileTools(
  profile: RunnerProfile,
  isToolAvailable: (tool: string) => boolean = defaultIsToolAvailable,
): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const tool of profile.requiredTools) {
    if (!isToolAvailable(tool)) missing.push(tool);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Produce a user-facing error message when tools are missing. Used by the
 * Orchestrator so the failure surfaces in run status.
 */
export function formatMissingToolsError(
  profile: RunnerProfile,
  missing: string[],
): string {
  const toolList = missing.map((t) => `\`${t}\``).join(', ');
  const hint = profile.toolHint ? ` ${profile.toolHint}` : '';
  return `Runner profile "${profile.id}" requires ${toolList}, but ${missing.length > 1 ? 'they are' : 'it is'} not available on PATH.${hint}`;
}

export const RUNNER_PROFILE_BINDING_KEY = 'runner_profile';
export const RUNNER_PROFILE_OWNER_TYPE = 'repository';
export const AUTO_PROFILE_ID = 'auto';

interface RunnerProfileBindingConfig {
  profile_id: string;
}

function parseBindingConfig(
  raw: string | null,
): RunnerProfileBindingConfig | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    const profileId =
      typeof obj.profile_id === 'string' ? obj.profile_id.trim() : '';
    if (!profileId) return null;
    return { profile_id: profileId };
  } catch {
    return null;
  }
}

function findRunnerProfileBinding(
  bindings: ResourceBindingRecord[],
): ResourceBindingRecord | undefined {
  return bindings.find(
    (binding) =>
      binding.binding_key === RUNNER_PROFILE_BINDING_KEY &&
      binding.owner_type === RUNNER_PROFILE_OWNER_TYPE,
  );
}

export async function getRepositoryRunnerProfileId(
  repositoryId: string,
): Promise<string | undefined> {
  if (!repositoryId) return undefined;
  const bindings = await listBindingsByResource('repository', repositoryId);
  const binding = findRunnerProfileBinding(bindings);
  if (!binding) return undefined;
  const config = parseBindingConfig(binding.config_json);
  return config?.profile_id;
}

export async function setRepositoryRunnerProfile(
  repositoryId: string,
  profileId: string,
  userId: string,
): Promise<void> {
  const existing = await listBindingsByResource('repository', repositoryId);
  for (const binding of existing) {
    if (
      binding.binding_key === RUNNER_PROFILE_BINDING_KEY &&
      binding.owner_type === RUNNER_PROFILE_OWNER_TYPE
    ) {
      await deleteBinding(binding.id);
    }
  }
  await createBinding(
    {
      resourceType: 'repository',
      resourceId: repositoryId,
      ownerType: RUNNER_PROFILE_OWNER_TYPE,
      ownerId: repositoryId,
      bindingKey: RUNNER_PROFILE_BINDING_KEY,
      configJson: JSON.stringify({ profile_id: profileId }),
    },
    userId,
  );
}

export async function clearRepositoryRunnerProfile(
  repositoryId: string,
): Promise<void> {
  const existing = await listBindingsByResource('repository', repositoryId);
  for (const binding of existing) {
    if (
      binding.binding_key === RUNNER_PROFILE_BINDING_KEY &&
      binding.owner_type === RUNNER_PROFILE_OWNER_TYPE
    ) {
      await deleteBinding(binding.id);
    }
  }
}

export async function resolveRunnerProfile(
  repositoryId: string | undefined,
  options: { worktreePath?: string } = {},
): Promise<RunnerProfile | undefined> {
  if (!repositoryId) return undefined;
  const id = await getRepositoryRunnerProfileId(repositoryId);
  if (!id) return undefined;

  if (id === AUTO_PROFILE_ID) {
    if (!options.worktreePath) {
      logger.debug(
        { repositoryId },
        'runner-profile: auto binding without worktree path, skipping detection',
      );
      return undefined;
    }
    const detected = detectProfilesForWorktree(options.worktreePath);
    if (detected.length === 0) {
      logger.info({ repositoryId }, 'runner-profile: auto detected nothing');
      return undefined;
    }
    return detected[0];
  }

  const profile = findProfileById(id);
  if (!profile) {
    logger.warn(
      { repositoryId, profileId: id },
      'runner-profile: bound profile id is not in BUILTIN_PROFILES',
    );
  }
  return profile;
}
