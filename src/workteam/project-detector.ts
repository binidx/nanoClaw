import fs from 'fs';
import path from 'path';
import { BUILTIN_PROFILES, type RunnerProfile } from './runner-profiles.js';

/**
 * Scan the top level of a worktree for marker files listed in each profile's
 * `detect.files`. Returns every matching profile, sorted by descending priority.
 *
 * Only the worktree root is inspected; nested marker files (e.g. a Go module
 * inside a Java monorepo subdir) are ignored to keep the detection rule simple
 * and fast. Callers that need finer control can pass their own profile list.
 */
export function detectProfilesForWorktree(
  worktreePath: string,
  profiles: RunnerProfile[] = BUILTIN_PROFILES,
): RunnerProfile[] {
  if (!worktreePath) return [];
  try {
    const stat = fs.statSync(worktreePath);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  const matched = new Map<string, RunnerProfile>();
  for (const profile of profiles) {
    for (const marker of profile.detect.files) {
      const full = path.join(worktreePath, marker);
      if (fs.existsSync(full)) {
        matched.set(profile.id, profile);
        break;
      }
    }
  }

  return Array.from(matched.values()).sort(
    (a, b) => b.detect.priority - a.detect.priority,
  );
}
