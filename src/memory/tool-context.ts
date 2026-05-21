import { getContextEntries, storeContextEntries } from '../db.js';
import type { PersistedAssistantTurn, PersistedToolCallTurnItem } from '../db.js';
import type { ContextEntryRecord } from '../types.js';
import { logger } from '../logger.js';

import { getChatContextConfig } from './chat-context-config.js';

const HIDDEN_TOOL_NAMES = new Set(['memory_search', 'memory_get', 'memory_save']);
const MAX_TOOL_ARGUMENT_CHARS = 240;
const MAX_TOOL_RESULT_CHARS = 320;
const MAX_TOOL_LOG_LINES = 12;
const TOOL_ARTIFACT_REGEX =
  /(?:\/[\w./-]+\.[A-Za-z0-9_-]+|[\w.-]+\.(?:png|jpg|jpeg|webp|gif|svg|md|ts|tsx|js|json|txt|pdf))/g;

function estimateTokenCount(text: string): number {
  const normalized = String(text || '').trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function trimCompactText(text: string, maxChars: number): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...[truncated]`;
}

function normalizeToolName(value: string): string {
  return String(value || '').trim();
}

function isOrdinaryConversation(chatJid: string): boolean {
  return !(
    chatJid.startsWith('repo-review:') ||
    chatJid.startsWith('workflow:')
  );
}

function isEligibleToolItem(item: PersistedToolCallTurnItem): boolean {
  const name = normalizeToolName(item.title);
  if (!name || HIDDEN_TOOL_NAMES.has(name)) return false;
  return item.status === 'completed' || item.status === 'failed';
}

function inferToolIntent(item: PersistedToolCallTurnItem): string {
  if (item.subagentInfo?.task?.trim()) {
    return trimCompactText(item.subagentInfo.task, 180);
  }
  const args = trimCompactText(item.argumentsText || '', 180);
  if (args) return args;
  return 'No explicit intent recorded.';
}

function inferToolCapabilityHints(name: string): string[] {
  const normalized = name.toLowerCase();
  const hints: string[] = [`Tool capability: ${name}`];
  if (
    normalized.includes('image') ||
    normalized.includes('img') ||
    normalized.includes('flux') ||
    normalized.includes('photo')
  ) {
    hints.push(`Image generation capability available via ${name}`);
  }
  if (normalized.includes('browser') || normalized.includes('playwright')) {
    hints.push(`Browser automation capability available via ${name}`);
  }
  if (normalized.includes('read_file') || normalized.includes('grep') || normalized.includes('glob')) {
    hints.push(`Codebase inspection capability available via ${name}`);
  }
  return hints;
}

function extractArtifactRefs(values: Array<string | undefined>): string[] {
  const refs = new Set<string>();
  for (const value of values) {
    const matches = String(value || '').match(TOOL_ARTIFACT_REGEX) || [];
    for (const match of matches) {
      refs.add(match);
      if (refs.size >= 8) return [...refs];
    }
  }
  return [...refs];
}

function buildToolRecentContent(input: {
  toolName: string;
  status: PersistedToolCallTurnItem['status'];
  intent: string;
  argumentsSummary: string;
  resultSummary: string;
  errorSummary: string;
  capabilityHints: string[];
  artifactRefs: string[];
}): string {
  const lines = [
    `Tool: ${input.toolName}`,
    `Status: ${input.status}`,
    `Intent: ${input.intent}`,
  ];
  if (input.argumentsSummary) lines.push(`Arguments: ${input.argumentsSummary}`);
  if (input.resultSummary) lines.push(`Result: ${input.resultSummary}`);
  if (input.errorSummary) lines.push(`Error: ${input.errorSummary}`);
  if (input.capabilityHints.length > 0) {
    lines.push(`Capability hints: ${input.capabilityHints.join(' | ')}`);
  }
  if (input.artifactRefs.length > 0) {
    lines.push(`Artifacts: ${input.artifactRefs.join(', ')}`);
  }
  return lines.join('\n');
}

function parseToolContextMetadata(
  entry: ContextEntryRecord,
): {
  toolName: string;
  status: string;
  intent: string;
  argumentsSummary: string;
  resultSummary: string;
  errorSummary: string;
  capabilityHints: string[];
  artifactRefs: string[];
  sourceTurnId: string | null;
  sourceEntryIds: string[];
} {
  try {
    const parsed = entry.content_json ? JSON.parse(entry.content_json) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid metadata');
    }
    const metadata = parsed as Record<string, unknown>;
    return {
      toolName: typeof metadata.toolName === 'string' ? metadata.toolName : '',
      status: typeof metadata.status === 'string' ? metadata.status : '',
      intent: typeof metadata.intent === 'string' ? metadata.intent : '',
      argumentsSummary:
        typeof metadata.argumentsSummary === 'string' ? metadata.argumentsSummary : '',
      resultSummary:
        typeof metadata.resultSummary === 'string' ? metadata.resultSummary : '',
      errorSummary:
        typeof metadata.errorSummary === 'string' ? metadata.errorSummary : '',
      capabilityHints: Array.isArray(metadata.capabilityHints)
        ? metadata.capabilityHints.filter((value): value is string => typeof value === 'string')
        : [],
      artifactRefs: Array.isArray(metadata.artifactRefs)
        ? metadata.artifactRefs.filter((value): value is string => typeof value === 'string')
        : [],
      sourceTurnId:
        typeof metadata.sourceTurnId === 'string' ? metadata.sourceTurnId : null,
      sourceEntryIds: Array.isArray(metadata.sourceEntryIds)
        ? metadata.sourceEntryIds.filter((value): value is string => typeof value === 'string')
        : [],
    };
  } catch {
    return {
      toolName: '',
      status: '',
      intent: '',
      argumentsSummary: '',
      resultSummary: '',
      errorSummary: '',
      capabilityHints: [],
      artifactRefs: [],
      sourceTurnId: null,
      sourceEntryIds: [],
    };
  }
}

function buildDeterministicToolSummary(entries: ContextEntryRecord[]): string {
  const capabilities = new Set<string>();
  const artifacts = new Set<string>();
  const failures: string[] = [];
  const toolCounts = new Map<string, number>();
  const logLines: string[] = [];

  for (const entry of entries) {
    const meta = parseToolContextMetadata(entry);
    const toolName = meta.toolName || entry.source_ref || 'tool';
    toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
    for (const hint of meta.capabilityHints) capabilities.add(hint);
    for (const ref of meta.artifactRefs) artifacts.add(ref);
    if (meta.status === 'failed' || meta.errorSummary) {
      failures.push(`${toolName}: ${meta.errorSummary || 'failed'}`);
    }
    logLines.push(
      `${logLines.length + 1}. [${meta.status || 'completed'}] ${toolName} | intent: ${
        meta.intent || 'n/a'
      } | result: ${meta.resultSummary || meta.errorSummary || 'n/a'}`,
    );
  }

  const repeatedTools = [...toolCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  const compactedUntil = entries[entries.length - 1]?.created_at || '';
  return [
    `Earlier tool activity summary (${entries.length} calls through ${compactedUntil}):`,
    '',
    'Capabilities demonstrated:',
    ...(capabilities.size > 0 ? [...capabilities].map((hint) => `- ${hint}`) : ['- none']),
    '',
    'Important artifacts/files:',
    ...(artifacts.size > 0 ? [...artifacts].map((ref) => `- ${ref}`) : ['- none']),
    '',
    'Stable tool usage patterns:',
    ...(repeatedTools.length > 0
      ? repeatedTools.map(([toolName, count]) => `- ${toolName} reused ${count} times`)
      : ['- none']),
    '',
    'Unresolved failures or retries:',
    ...(failures.length > 0 ? failures.map((failure) => `- ${failure}`) : ['- none']),
    '',
    'Compressed tool log:',
    ...logLines.slice(0, MAX_TOOL_LOG_LINES),
  ].join('\n');
}

function buildToolRecentEntry(input: {
  groupFolder: string;
  chatJid: string;
  turnId: string;
  item: PersistedToolCallTurnItem;
}): ContextEntryRecord {
  const toolName = normalizeToolName(input.item.title);
  const argumentsSummary = trimCompactText(input.item.argumentsText || '', MAX_TOOL_ARGUMENT_CHARS);
  const resultSummary = trimCompactText(input.item.resultText || '', MAX_TOOL_RESULT_CHARS);
  const errorSummary = trimCompactText(input.item.errorText || '', MAX_TOOL_RESULT_CHARS);
  const intent = inferToolIntent(input.item);
  const capabilityHints = inferToolCapabilityHints(toolName);
  const artifactRefs = extractArtifactRefs([
    input.item.argumentsText,
    input.item.resultText,
    input.item.errorText,
  ]);
  const createdAt =
    input.item.completedAt || input.item.timestamp || new Date().toISOString();

  return {
    id: `tool_context:${input.chatJid}:${input.turnId}:${input.item.id}`,
    group_folder: input.groupFolder,
    chat_jid: input.chatJid,
    run_id: input.turnId,
    provider: 'system',
    role: 'tool',
    source_type: 'tool_call_recent',
    source_ref: input.item.id,
    content_text: buildToolRecentContent({
      toolName,
      status: input.item.status,
      intent,
      argumentsSummary,
      resultSummary,
      errorSummary,
      capabilityHints,
      artifactRefs,
    }),
    content_json: JSON.stringify({
      toolName,
      status: input.item.status,
      intent,
      argumentsSummary,
      resultSummary,
      errorSummary,
      capabilityHints,
      artifactRefs,
      sourceTurnId: input.turnId,
      completedAt: createdAt,
      sourceEntryIds: [input.item.id],
    }),
    token_estimate: estimateTokenCount(
      buildToolRecentContent({
        toolName,
        status: input.item.status,
        intent,
        argumentsSummary,
        resultSummary,
        errorSummary,
        capabilityHints,
        artifactRefs,
      }),
    ),
    created_at: createdAt,
  };
}

function buildToolSummaryEntry(input: {
  groupFolder: string;
  chatJid: string;
  sourceEntries: ContextEntryRecord[];
}): ContextEntryRecord {
  const createdAt = new Date().toISOString();
  const summaryText = buildDeterministicToolSummary(input.sourceEntries);
  const sourceEntryIds = input.sourceEntries.map((entry) => entry.id);
  return {
    id: `tool_summary:${input.chatJid}:${createdAt}:${Math.random().toString(36).slice(2, 8)}`,
    group_folder: input.groupFolder,
    chat_jid: input.chatJid,
    run_id: null,
    provider: 'system',
    role: 'summary',
    source_type: 'tool_call_summary',
    source_ref: input.sourceEntries[input.sourceEntries.length - 1]?.id || null,
    content_text: summaryText,
    content_json: JSON.stringify({
      sourceEntryIds,
      callCount: input.sourceEntries.length,
      compactedUntil: input.sourceEntries[input.sourceEntries.length - 1]?.created_at || null,
    }),
    token_estimate: estimateTokenCount(summaryText),
    created_at: createdAt,
  };
}

async function recomputeRollingToolSummary(
  groupFolder: string,
  chatJid: string,
): Promise<void> {
  const config = await getChatContextConfig();
  const entries = (await getContextEntries(chatJid, 500))
    .filter((entry) => entry.source_type === 'tool_call_recent')
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
  if (entries.length <= config.rawToolKeepCalls) {
    return;
  }

  const sourceEntries = entries.slice(0, -config.rawToolKeepCalls);
  const sourceEntryIds = JSON.stringify(sourceEntries.map((entry) => entry.id));
  const latestSummary = (await getContextEntries(chatJid, 500))
    .filter((entry) => entry.source_type === 'tool_call_summary')
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
  if (latestSummary) {
    const latestMeta = parseToolContextMetadata(latestSummary);
    if (JSON.stringify(latestMeta.sourceEntryIds) === sourceEntryIds) {
      return;
    }
  }

  await storeContextEntries([
    buildToolSummaryEntry({
      groupFolder,
      chatJid,
      sourceEntries,
    }),
  ]);
}

export async function persistToolContextFromTurn(input: {
  groupFolder: string;
  chatJid: string;
  turn: PersistedAssistantTurn;
}): Promise<void> {
  if (!isOrdinaryConversation(input.chatJid)) return;

  const toolItems = input.turn.items.filter(
    (item): item is PersistedToolCallTurnItem =>
      item.type === 'tool_call' && isEligibleToolItem(item),
  );
  if (toolItems.length === 0) return;

  const entries = toolItems.map((item) =>
    buildToolRecentEntry({
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      turnId: input.turn.id,
      item,
    }),
  );
  await storeContextEntries(entries);

  try {
    await recomputeRollingToolSummary(input.groupFolder, input.chatJid);
  } catch (err) {
    logger.warn({ err, chatJid: input.chatJid }, 'Failed to recompute rolling tool summary');
  }
}
