import type { RunnerProfile } from './runner-profiles.js';

/**
 * Process-local map from workflow runtime chat JID to its selected Runner Profile.
 *
 * Contract:
 *   - Workflow agent adapter `setProfileForChat` before `runAgentProcess`.
 *   - `spawnAgent` calls `getProfileForChat(input.chatJid)` and merges env
 *     if non-undefined.
 *   - Workflow agent adapter `clearProfileForChat` when the node completes,
 *     fails, cancels, or times out.
 *
 * Empty JIDs are silently ignored to avoid accidental global state.
 */
const registry = new Map<string, RunnerProfile>();

export function setProfileForChat(
  chatJid: string,
  profile: RunnerProfile,
): void {
  if (!chatJid) return;
  registry.set(chatJid, profile);
}

export function getProfileForChat(chatJid: string): RunnerProfile | undefined {
  if (!chatJid) return undefined;
  return registry.get(chatJid);
}

export function clearProfileForChat(chatJid: string): void {
  if (!chatJid) return;
  registry.delete(chatJid);
}

/** Test-only helper; not meant for runtime use. */
export function resetRegistry(): void {
  registry.clear();
}
