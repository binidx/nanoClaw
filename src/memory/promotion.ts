import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import {
  bindConversationIdentity,
  createPersonProfile,
  getConversationIdentityBinding,
  getPersonProfile,
  listIdentityAliases,
  recordMemoryEvent,
  updatePersonProfile,
  upsertMemoryDocuments,
} from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { syncIndexedMemoryFile } from './document-indexing.js';
import { normalizeMemoryIdentityId } from './identity-service.js';
import type {
  ContextEntryRecord,
  MemoryDocumentRecord,
  MemoryPromotionCandidate,
  MemoryPromotionCandidateKind,
} from '../types.js';

const MAX_COMPACTION_CANDIDATES = 6;
const TEMPORARY_MARKER_REGEX =
  /(今天|这次|暂时|先|目前|本次|试一下|试试|稍后|等会|刚刚)/;

export type MemoryDecision =
  | 'none'
  | 'session'
  | 'group_durable'
  | 'global_durable'
  | 'identity'
  | 'ttl_task';

export interface DurableMemoryPromotionResult {
  candidate: MemoryPromotionCandidate;
  pathRef: string;
  lineStart: number;
  lineEnd: number;
  status: 'written' | 'deduped';
  appendedText: string;
  sourceType: MemoryDocumentRecord['source_type'];
  memoryClass: Extract<MemoryDecision, 'group_durable' | 'global_durable' | 'identity'>;
}

function normalizeWhitespace(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMemoryNote(value: string): string {
  return normalizeWhitespace(value)
    .replace(/[。.!！]+$/u, '')
    .replace(/[\u3000]/g, ' ');
}

function parseNotesJson(value: string | null | undefined): string[] {
  try {
    const parsed = value ? (JSON.parse(value) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function classifyCandidateKind(text: string): MemoryPromotionCandidateKind | null {
  if (
    /(叫我|称呼我|我喜欢|我更喜欢|我偏好|默认用|默认按|回复尽量|请尽量|请优先)/.test(
      text,
    )
  ) {
    return 'preference';
  }
  if (/(我是|我的名字是|我的职位是|我在.*工作|我来自|我叫|你可以叫我)/.test(text)) {
    return 'identity';
  }
  if (/(必须|务必|不要|别|一律|只能|统一用|以后都|默认不要)/.test(text)) {
    return 'constraint';
  }
  if (/(记住|提醒我|后续继续|每次都|长期|一直|后面都)/.test(text)) {
    return 'commitment';
  }
  return null;
}

function classifyConfidence(text: string): 'high' | 'medium' {
  return /(记住|以后|默认|叫我|我喜欢|我是|必须|务必|不要|一律)/.test(text)
    ? 'high'
    : 'medium';
}

export function classifyMemoryDecision(text: string): MemoryDecision {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return 'none';

  if (
    /(我叫|我的名字是|你可以叫我|叫我|称呼我(?:为)?|我是|我的职位是|我来自|我在.*工作)/.test(
      normalized,
    )
  ) {
    return 'identity';
  }

  if (
    /(这个项目里|在这个项目里|这个仓库里|在这个仓库里|这个群里|这个客户沟通里|这个会话里|在这个仓库)/.test(
      normalized,
    )
  ) {
    return 'group_durable';
  }

  if (/(这次先|本次会话|当前这轮|当前这次|先别|先不要|先用|本轮|暂时|当前先)/.test(normalized)) {
    return 'ttl_task';
  }

  if (
    /(默认|以后默认|记住|长期|一直|偏好|喜欢|更喜欢|简洁回复|中文回复|英文回复|请尽量|请优先|回复尽量)/.test(
      normalized,
    )
  ) {
    return 'global_durable';
  }

  if (TEMPORARY_MARKER_REGEX.test(normalized)) {
    return 'session';
  }

  return 'none';
}

export function buildPromotionCandidateFromText(input: {
  text: string;
  sourceEntryIds: string[];
  origin?: 'explicit_user' | 'compaction_candidate';
}): MemoryPromotionCandidate | null {
  const normalized = normalizeMemoryNote(input.text);
  if (!normalized) return null;
  const kind = classifyCandidateKind(normalized);
  const decision = classifyMemoryDecision(normalized);
  if (!kind && !['identity', 'group_durable', 'global_durable'].includes(decision)) {
    return null;
  }
  return {
    kind:
      kind ||
      (decision === 'identity'
        ? 'identity'
        : decision === 'group_durable'
          ? 'constraint'
          : 'preference'),
    text: normalized,
    confidence: classifyConfidence(normalized),
    sourceEntryIds: input.sourceEntryIds,
    origin: input.origin || 'explicit_user',
  };
}

export async function extractDurableMemoryCandidates(
  entries: ContextEntryRecord[],
): Promise<MemoryPromotionCandidate[]> {
  const candidates: MemoryPromotionCandidate[] = [];
  const seen = new Set<string>();
  const pendingEvents: Array<Parameters<typeof recordMemoryEvent>[0]> = [];

  for (const entry of entries) {
    if (entry.role !== 'user') continue;
    const text = normalizeWhitespace(entry.content_text);
    if (!text) continue;
    const decision = classifyMemoryDecision(text);
    if (decision === 'none' || decision === 'session' || decision === 'ttl_task') {
      pendingEvents.push({
        user_id: null,
        scope: entry.group_folder || 'global',
        action_type: 'SKIP',
        target_type: 'memory_document',
        target_id: null,
        conversation_id: entry.chat_jid,
        source_message_id: entry.source_ref ?? null,
        before_snapshot: null,
        after_snapshot: null,
        decision_reason: `classifyMemoryDecision=${decision}`,
        metadata_json: JSON.stringify({ text: text.slice(0, 200) }),
      });
      continue;
    }
    if (TEMPORARY_MARKER_REGEX.test(text) && !/(以后|默认|记住|长期)/.test(text)) {
      pendingEvents.push({
        user_id: null,
        scope: entry.group_folder || 'global',
        action_type: 'SKIP',
        target_type: 'memory_document',
        target_id: null,
        conversation_id: entry.chat_jid,
        source_message_id: entry.source_ref ?? null,
        before_snapshot: null,
        after_snapshot: null,
        decision_reason: 'temporary_marker_matched',
        metadata_json: JSON.stringify({ text: text.slice(0, 200) }),
      });
      continue;
    }
    const candidate = buildPromotionCandidateFromText({
      text,
      sourceEntryIds: [entry.id],
      origin: 'explicit_user',
    });
    if (!candidate) continue;
    const key = normalizeMemoryNote(candidate.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }

  if (pendingEvents.length > 0) {
    Promise.all(pendingEvents.map((e) => recordMemoryEvent(e).catch((err) => {
      logger.debug({ err }, 'Failed to record memory event');
    }))).catch((err) => {
      logger.debug({ err }, 'Failed to record memory events batch');
    });
  }

  return candidates;
}

export async function buildDurableCandidateSummaryLines(
  entries: ContextEntryRecord[],
): Promise<string[]> {
  const candidates = (await extractDurableMemoryCandidates(entries)).slice(
    0,
    MAX_COMPACTION_CANDIDATES,
  );
  if (candidates.length === 0) {
    return ['- none'];
  }
  return candidates.map((candidate) => `- [${candidate.kind}] ${candidate.text}`);
}

function resolveLocalDateParts(date = new Date()): {
  dateStamp: string;
  timeStamp: string;
} {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return {
    dateStamp: `${year}-${month}-${day}`,
    timeStamp: `${hours}:${minutes}`,
  };
}

function listExistingNormalizedNotes(absolutePath: string): Set<string> {
  if (!fs.existsSync(absolutePath)) return new Set<string>();
  const content = fs.readFileSync(absolutePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const notes = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^- \d{2}:\d{2} (?:\[[^\]]+\] )?(.+)$/);
    if (!match?.[1]) continue;
    const normalized = normalizeMemoryNote(match[1]);
    if (normalized) notes.add(normalized);
  }
  return notes;
}

function getConfiguredGlobalDir(): string {
  return process.env.NANOCLAW_GLOBAL_DIR || path.join(GROUPS_DIR, 'global');
}

function getScopedRootDir(scope: 'group' | 'global', groupFolder: string): string {
  return scope === 'group'
    ? resolveGroupFolderPath(groupFolder)
    : getConfiguredGlobalDir();
}

function buildDailyMemoryPathRef(scope: 'group' | 'global', dateStamp: string): string {
  return `${scope}:memory/${dateStamp}.md`;
}

function writeCandidateToDailyMemory(input: {
  scope: 'group' | 'global';
  groupFolder: string;
  candidate: MemoryPromotionCandidate;
  now?: Date;
}): DurableMemoryPromotionResult {
  const rootDir = getScopedRootDir(input.scope, input.groupFolder);
  const { dateStamp, timeStamp } = resolveLocalDateParts(input.now);
  const absolutePath = path.join(rootDir, 'memory', `${dateStamp}.md`);
  const pathRef = buildDailyMemoryPathRef(input.scope, dateStamp);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  const existingNormalized = listExistingNormalizedNotes(absolutePath);
  const existed = fs.existsSync(absolutePath);
  const previousContent = existed ? fs.readFileSync(absolutePath, 'utf8') : '';
  let currentLines = previousContent ? previousContent.split(/\r?\n/) : [];
  const normalized = normalizeMemoryNote(input.candidate.text);
  const lineStart = currentLines.length > 0 ? currentLines.length + 1 : 1;

  if (!normalized || existingNormalized.has(normalized)) {
    return {
      candidate: input.candidate,
      pathRef,
      lineStart,
      lineEnd: lineStart,
      status: 'deduped',
      appendedText: '',
      sourceType: 'memory_file',
      memoryClass: input.scope === 'global' ? 'global_durable' : 'group_durable',
    };
  }

  const header = `# Daily Memory ${dateStamp}`;
  const block = `- ${timeStamp} [${input.candidate.kind}] ${input.candidate.text}`;
  const appendedText =
    existed || currentLines.length > 0 ? `\n${block}\n` : `${header}\n\n${block}\n`;
  fs.appendFileSync(absolutePath, appendedText, 'utf8');
  currentLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);

  void syncIndexedMemoryFile({
    pathRef,
    groupFolder: input.groupFolder,
  }).catch((err) => {
    logger.warn(
      { err, groupFolder: input.groupFolder, pathRef },
      'Failed to index promoted memory file',
    );
  });

  const lineCount =
    appendedText
      .replace(/\r/g, '')
      .split('\n')
      .filter(
        (_, index, array) => !(index === array.length - 1 && array[index] === ''),
      ).length || 1;

  return {
    candidate: input.candidate,
    pathRef,
    lineStart,
    lineEnd: lineStart + Math.max(0, lineCount - 1),
    status: 'written',
    appendedText: block,
    sourceType: 'memory_file',
    memoryClass: input.scope === 'global' ? 'global_durable' : 'group_durable',
  };
}

function extractIdentityDisplayName(text: string): string | null {
  const patterns = [
    /(?:我叫|我的名字是|你可以叫我|叫我|称呼我(?:为)?)([^，。！？,\n]+)/u,
  ];
  for (const pattern of patterns) {
    const match = normalizeWhitespace(text).match(pattern);
    const candidate = normalizeWhitespace(match?.[1] || '')
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
      .replace(/^(一下|一声)/, '')
      .trim();
    if (candidate) return candidate;
  }
  return null;
}

function buildIdentityMemoryBody(input: {
  displayName: string;
  notes: string[];
  aliases: Array<{
    channel: string | null;
    external_user_id: string | null;
    display_name: string | null;
  }>;
}): string {
  const lines = [`# Identity Memory: ${input.displayName}`, '', `- display_name: ${input.displayName}`];
  if (input.notes.length > 0) {
    lines.push('- notes:');
    for (const note of input.notes) {
      lines.push(`  - ${note}`);
    }
  }
  if (input.aliases.length > 0) {
    lines.push('- aliases:');
    for (const alias of input.aliases) {
      const fields = [
        alias.display_name ? `display_name=${alias.display_name}` : '',
        alias.external_user_id ? `external_user_id=${alias.external_user_id}` : '',
        alias.channel ? `channel=${alias.channel}` : '',
      ].filter(Boolean);
      lines.push(`  - ${fields.join(' | ')}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function upsertIdentityMemoryProjection(input: {
  groupFolder: string;
  personId: string;
  displayName: string;
  notes: string[];
  aliases: Array<{
    channel: string | null;
    external_user_id: string | null;
    display_name: string | null;
  }>;
  candidate: MemoryPromotionCandidate;
}): Promise<DurableMemoryPromotionResult> {
  const rootDir = getConfiguredGlobalDir();
  const relPath = `memory/identity/${input.personId}.md`;
  const absolutePath = path.join(rootDir, ...relPath.split('/'));
  const pathRef = `global:${relPath}`;
  const body = buildIdentityMemoryBody({
    displayName: input.displayName,
    notes: input.notes,
    aliases: input.aliases,
  });
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const previousContent = fs.existsSync(absolutePath)
    ? fs.readFileSync(absolutePath, 'utf8')
    : '';
  const status: 'written' | 'deduped' =
    previousContent === body ? 'deduped' : 'written';
  if (status === 'written') {
    fs.writeFileSync(absolutePath, body, 'utf8');
  }

  await upsertMemoryDocuments([
    {
      doc_id: `identity-profile:${input.personId}`,
      scope: 'global',
      owner_type: 'person',
      owner_id: input.personId,
      path_ref: pathRef,
      source_type: 'identity_memory',
      title: `${input.displayName} profile`,
      body,
      metadata_json: JSON.stringify({
        personId: input.personId,
        memoryClass: 'identity',
      }),
      updated_at: new Date().toISOString(),
    },
  ]);

  return {
    candidate: input.candidate,
    pathRef,
    lineStart: 1,
    lineEnd: body.split(/\r?\n/).length,
    status,
    appendedText: status === 'written' ? body : '',
    sourceType: 'identity_memory',
    memoryClass: 'identity',
  };
}

async function upsertIdentityMemoryFromCandidate(input: {
  groupFolder: string;
  chatJid: string;
  candidate: MemoryPromotionCandidate;
  sender?: string;
  senderName?: string;
}): Promise<DurableMemoryPromotionResult | null> {
  const existingBinding = await getConversationIdentityBinding(input.chatJid);
  const extractedDisplayName = extractIdentityDisplayName(input.candidate.text);
  const fallbackDisplayName =
    extractedDisplayName ||
    normalizeWhitespace(input.senderName || '') ||
    normalizeWhitespace(input.sender || '');
  const personId = existingBinding?.person_id
    ? normalizeMemoryIdentityId(existingBinding.person_id)
    : normalizeMemoryIdentityId(
        extractedDisplayName || input.senderName || input.sender || input.chatJid,
        fallbackDisplayName,
      );
  if (!personId) {
    return null;
  }

  const existingProfile = await getPersonProfile(personId);
  const existingAliases = await listIdentityAliases(personId);
  const nextNotes = [...parseNotesJson(existingProfile?.notes_json), input.candidate.text];
  const aliasSeed = [
    ...existingAliases.map((alias) => ({
      channel: alias.channel,
      externalUserId: alias.external_user_id,
      displayName: alias.display_name,
    })),
  ];
  if (input.sender || input.senderName) {
    aliasSeed.push({
      channel: null,
      externalUserId: normalizeWhitespace(input.sender || '') || null,
      displayName: normalizeWhitespace(input.senderName || '') || null,
    });
  }

  const profile = existingProfile
    ? await updatePersonProfile({
        id: personId,
        displayName:
          extractedDisplayName || existingProfile.display_name || fallbackDisplayName,
        notes: nextNotes,
        aliases: aliasSeed,
      })
    : await createPersonProfile({
        id: personId,
        displayName: fallbackDisplayName || personId,
        notes: nextNotes,
        aliases: aliasSeed,
      });

  await bindConversationIdentity({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    personId: profile.id,
  });

  return upsertIdentityMemoryProjection({
    groupFolder: input.groupFolder,
    personId: profile.id,
    displayName: profile.display_name,
    notes: parseNotesJson(profile.notes_json),
    aliases: await listIdentityAliases(profile.id),
    candidate: input.candidate,
  });
}

export async function promoteDurableMemoryCandidate(input: {
  groupFolder: string;
  chatJid: string;
  candidate: MemoryPromotionCandidate;
  sender?: string;
  senderName?: string;
  allowGlobalWrite?: boolean;
  now?: Date;
}): Promise<DurableMemoryPromotionResult | null> {
  const decision = classifyMemoryDecision(input.candidate.text);
  if (
    decision === 'none' ||
    decision === 'session' ||
    decision === 'ttl_task'
  ) {
    recordMemoryEvent({
      user_id: null,
      scope: input.groupFolder || 'global',
      action_type: 'SKIP',
      target_type: 'memory_document',
      target_id: null,
      conversation_id: input.chatJid,
      source_message_id: input.candidate.sourceEntryIds?.[0] ?? null,
      before_snapshot: null,
      after_snapshot: null,
      decision_reason: `promoteDurableMemoryCandidate: decision=${decision}`,
      metadata_json: JSON.stringify({ text: input.candidate.text.slice(0, 200) }),
    }).catch((err) => {
      logger.debug({ err }, 'Failed to record memory event for skipped candidate');
    });
    return null;
  }

  let result: DurableMemoryPromotionResult | null = null;

  if (decision === 'identity') {
    result = await upsertIdentityMemoryFromCandidate(input);
  } else if (decision === 'global_durable' && input.allowGlobalWrite) {
    result = writeCandidateToDailyMemory({
      scope: 'global',
      groupFolder: input.groupFolder,
      candidate: input.candidate,
      now: input.now,
    });
  } else {
    result = writeCandidateToDailyMemory({
      scope: 'group',
      groupFolder: input.groupFolder,
      candidate: input.candidate,
      now: input.now,
    });
  }

  if (result) {
    recordMemoryEvent({
      user_id: null,
      scope: input.groupFolder || 'global',
      action_type: 'PROMOTE',
      target_type: 'memory_document',
      target_id: result.pathRef,
      conversation_id: input.chatJid,
      source_message_id: input.candidate.sourceEntryIds?.[0] ?? null,
      before_snapshot: null,
      after_snapshot: JSON.stringify({ text: input.candidate.text.slice(0, 500), status: result.status }),
      decision_reason: `decision=${decision}, kind=${input.candidate.kind}`,
      metadata_json: JSON.stringify({ decision, kind: input.candidate.kind, confidence: input.candidate.confidence }),
    }).catch((err) => {
      logger.debug({ err }, 'Failed to record memory promotion event');
    });
  }

  return result;
}

export async function promoteIncomingMemoryText(input: {
  groupFolder: string;
  chatJid: string;
  text: string;
  sourceEntryId: string;
  sender?: string;
  senderName?: string;
  allowGlobalWrite?: boolean;
  now?: Date;
}): Promise<DurableMemoryPromotionResult | null> {
  const candidate = buildPromotionCandidateFromText({
    text: input.text,
    sourceEntryIds: [input.sourceEntryId],
    origin: 'explicit_user',
  });
  if (!candidate) return null;
  return await promoteDurableMemoryCandidate({
    groupFolder: input.groupFolder,
    chatJid: input.chatJid,
    candidate,
    sender: input.sender,
    senderName: input.senderName,
    allowGlobalWrite: input.allowGlobalWrite,
    now: input.now,
  });
}

export async function promoteRememberedMemoryText(input: {
  groupFolder: string;
  chatJid: string;
  text: string;
  sourceEntryId: string;
  sender?: string;
  senderName?: string;
  allowGlobalWrite?: boolean;
  now?: Date;
}): Promise<DurableMemoryPromotionResult | null> {
  const normalized = normalizeMemoryNote(input.text);
  if (!normalized) return null;

  const candidate =
    buildPromotionCandidateFromText({
      text: normalized,
      sourceEntryIds: [input.sourceEntryId],
      origin: 'explicit_user',
    }) || {
      kind: 'commitment' as const,
      text: normalized,
      confidence: 'high' as const,
      sourceEntryIds: [input.sourceEntryId],
      origin: 'explicit_user' as const,
    };
  const decision = classifyMemoryDecision(normalized);

  if (decision === 'identity' || decision === 'global_durable') {
    return await promoteDurableMemoryCandidate({
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      candidate,
      sender: input.sender,
      senderName: input.senderName,
      allowGlobalWrite: input.allowGlobalWrite,
      now: input.now,
    });
  }

  return writeCandidateToDailyMemory({
    scope: 'group',
    groupFolder: input.groupFolder,
    candidate,
    now: input.now,
  });
}

export function promoteCandidatesToGroupMemory(
  groupFolder: string,
  candidates: MemoryPromotionCandidate[],
  options?: { now?: Date },
): DurableMemoryPromotionResult[] {
  return promoteCandidatesToScopedMemory('group', groupFolder, candidates, options);
}

export function promoteCandidatesToScopedMemory(
  scope: 'group' | 'global',
  groupFolder: string,
  candidates: MemoryPromotionCandidate[],
  options?: { now?: Date },
): DurableMemoryPromotionResult[] {
  return candidates.map((candidate) =>
    writeCandidateToDailyMemory({
      scope,
      groupFolder,
      candidate,
      now: options?.now,
    }),
  );
}
