import type { RunnerProfile } from './runner-profiles.js';

/**
 * Process-local map from workteam task chat JID to its selected Runner Profile.
 *
 * Why a registry instead of threading through `AgentRunInput`?
 *
 * Workteam tasks flow through
 *   orchestrator -> agent-adapter.executeAgentTask -> handleWebInput ->
 *   (web channel) -> runAgentProcess -> spawnAgent
 *
 * Changing that signature chain to carry a Profile would touch every caller of
 * `handleWebInput`. Since each Workteam task uses a deterministic, unique JID
 * (`web:workteam-<teamId>-<agentId>-<taskId>`), a tiny in-memory map keyed by
 * JID gives `spawnAgent` the same data with a single integration point.
 *
 * Contract:
 *   - Orchestrator / agent-adapter `setProfileForChat` *before* calling
 *     `handleWebInput`.
 *   - `spawnAgent` calls `getProfileForChat(input.chatJid)` and merges env
 *     if non-undefined.
 *   - Orchestrator / agent-adapter `clearProfileForChat` when the task
 *     completes, fails, cancels, or times out.
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
