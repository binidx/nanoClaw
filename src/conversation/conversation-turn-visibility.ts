import type {
  AgentEventPayload,
  AgentTurnEventPayload,
  AgentTurnItemPayload,
} from '../agent/agent-runner.js';
import type { PersistedAssistantTurn, PersistedTurnItem } from '../db.js';

const HIDDEN_MEMORY_TOOL_NAMES = new Set([
  'memory_search',
  'memory_get',
  'memory_save',
]);
const HIDDEN_PROVIDER_PHASE_TITLES = new Set([
  'Waiting for Codex provider availability',
  'Waiting for Codex provider response',
  'Receiving Codex provider response',
  'Codex provider phase completed',
  'Codex provider phase failed',
]);

export function isHiddenMemoryToolCallTitle(title: string | undefined): boolean {
  const normalized = String(title || '').trim();
  return HIDDEN_MEMORY_TOOL_NAMES.has(normalized);
}

export function isHiddenWebToolCallItem(
  item: AgentTurnItemPayload | PersistedTurnItem,
): boolean {
  return item.type === 'tool_call' && isHiddenMemoryToolCallTitle(item.title);
}

export function isHiddenWebAgentEvent(event: AgentEventPayload): boolean {
  return (
    event.kind === 'status' &&
    HIDDEN_PROVIDER_PHASE_TITLES.has(String(event.title || '').trim())
  );
}

function shouldKeepPersistedTurn(turn: PersistedAssistantTurn): boolean {
  return turn.isLive || Boolean(turn.error) || turn.items.length > 0;
}

export function sanitizePersistedTurnForWeb(
  turn: PersistedAssistantTurn,
): PersistedAssistantTurn | null {
  const items = turn.items.filter((item) => !isHiddenWebToolCallItem(item));
  const sanitized =
    items.length === turn.items.length ? turn : { ...turn, items };
  return shouldKeepPersistedTurn(sanitized) ? sanitized : null;
}

export function sanitizePersistedTurnsForWeb(
  turns: PersistedAssistantTurn[],
): PersistedAssistantTurn[] {
  return turns
    .map((turn) => sanitizePersistedTurnForWeb(turn))
    .filter((turn): turn is PersistedAssistantTurn => turn !== null);
}

export function sanitizeAgentEventForWeb(
  event: AgentEventPayload,
): AgentEventPayload | null {
  return isHiddenWebAgentEvent(event) ? null : event;
}

export function sanitizeTurnEventForWeb(
  event: AgentTurnEventPayload,
): AgentTurnEventPayload | null {
  if (
    event.type !== 'item.started' &&
    event.type !== 'item.updated' &&
    event.type !== 'item.completed'
  ) {
    return event;
  }

  return isHiddenWebToolCallItem(event.item) ? null : event;
}
