import {
  createBinding,
  deleteBinding,
  listBindingsByResource,
  type ResourceBindingRecord,
} from '../db/resource-bindings.js';
import { createModuleLogger } from '../logger.js';
import { detectProfilesForWorktree } from './project-detector.js';
import { findProfileById, type RunnerProfile } from './runner-profiles.js';

const logger = createModuleLogger('workteam');

export const RUNNER_PROFILE_BINDING_KEY = 'runner_profile';
export const RUNNER_PROFILE_OWNER_TYPE = 'repository';

/**
 * Special profile id that defers to `detectProfilesForWorktree`. Persisted in
 * `resource_bindings.config_json` as `{ "profile_id": "auto" }`.
 */
export const AUTO_PROFILE_ID = 'auto';

interface RunnerProfileBindingConfig {
  profile_id: string;
}

function parseBindingConfig(
  raw: string | null,
): RunnerProfileBindingConfig | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const obj = v as Record<string, unknown>;
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
    (b) =>
      b.binding_key === RUNNER_PROFILE_BINDING_KEY &&
      b.owner_type === RUNNER_PROFILE_OWNER_TYPE,
  );
}

/**
 * Read the persisted `profile_id` for a repository (or `undefined` if none).
 * Returns the raw id string; callers use `resolveRunnerProfile` to get the
 * actual `RunnerProfile` object.
 */
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

/**
 * Upsert the repository's runner profile binding. Replaces any existing entry.
 */
export async function setRepositoryRunnerProfile(
  repositoryId: string,
  profileId: string,
  userId: string,
): Promise<void> {
  const existing = await listBindingsByResource('repository', repositoryId);
  for (const b of existing) {
    if (
      b.binding_key === RUNNER_PROFILE_BINDING_KEY &&
      b.owner_type === RUNNER_PROFILE_OWNER_TYPE
    ) {
      await deleteBinding(b.id);
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
  for (const b of existing) {
    if (
      b.binding_key === RUNNER_PROFILE_BINDING_KEY &&
      b.owner_type === RUNNER_PROFILE_OWNER_TYPE
    ) {
      await deleteBinding(b.id);
    }
  }
}

/**
 * Turn a stored `profile_id` (plus an optional worktree path for `auto`) into
 * a concrete `RunnerProfile`. Returns `undefined` when:
 *   - nothing is bound,
 *   - binding is `auto` but detection finds nothing,
 *   - binding points to an unknown profile id (logged as warning).
 *
 * Callers interpret `undefined` as "no env injection, run as before".
 */
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
