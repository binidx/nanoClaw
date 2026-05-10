import path from 'path';

import { GroupQueue } from '../runtime/group-queue.js';
import type { ChannelOpts } from '../channels/registry.js';
import type { AgentUploadedFile, Channel, RegisteredGroup } from '../types.js';

export let lastTimestamp = '';
export let sessions: Record<string, string> = {};
export let registeredGroups: Record<string, RegisteredGroup> = {};
export let lastAgentTimestamp: Record<string, string> = {};
export let pendingAgentTimestamp: Record<string, string> = {};
export const pendingUploadedFiles = new Map<
  string,
  Map<string, { files: AgentUploadedFile[]; timestamp: string }>
>();
export const interruptedAgentRuns = new Set<string>();
export const activeConversationTurnIds = new Map<string, string>();
export const ipcAcknowledgedChats = new Set<string>();
export let messageLoopRunning = false;
export const PENDING_AGENT_TIMESTAMP_KEY = 'pending_agent_timestamp';

export const channels: Channel[] = [];
export let storedChannelOpts: ChannelOpts | null = null;
export const queue = new GroupQueue();
export const WEB_RELAY_PREFIX = '【Web】';
export const PID_FILE = path.resolve(process.cwd(), 'nanoclaw.pid');
export const PORT_FILE = path.resolve(process.cwd(), 'nanoclaw.port');

export const RELOAD_SAFE_CHANNELS = new Set(['web']);

export function assignLastTimestamp(value: string): void {
  lastTimestamp = value;
}

export function assignSessions(value: Record<string, string>): void {
  sessions = value;
}

export function assignRegisteredGroups(
  value: Record<string, RegisteredGroup>,
): void {
  registeredGroups = value;
}

export function assignLastAgentTimestamp(
  value: Record<string, string>,
): void {
  lastAgentTimestamp = value;
}

export function assignPendingAgentTimestamp(
  value: Record<string, string>,
): void {
  pendingAgentTimestamp = value;
}

export function assignMessageLoopRunning(value: boolean): void {
  messageLoopRunning = value;
}

export function assignStoredChannelOpts(value: ChannelOpts | null): void {
  storedChannelOpts = value;
}
