import {
  bindConversationIdentity,
  createPersonProfile,
  getConversationIdentityBinding,
  getPersonProfile,
  listIdentityAliases,
  storeMemoryPromotionEntry,
} from '../db.js';
import { logger } from '../logger.js';
import { normalizeMemoryIdentityId } from './identity-service.js';
import {
  buildIdentityMemoryPathRef,
} from './identity-documents.js';
import { getMemoryContextConfig } from './context-config.js';
import {
  extractDurableMemoryCandidates,
  promoteCandidatesToScopedMemory,
} from './promotion.js';
import type {
  ContextEntryRecord,
  IdentityAliasRecord,
  MemoryPromotionCandidate,
} from '../types.js';

type DurableMemoryClass =
  | 'identity'
  | 'global_durable'
  | 'group_durable'
  | 'session'
  | 'ttl_task'
  | 'none';

function normalizeWhitespace(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function parseEntryMetadata(entry: ContextEntryRecord): {
  sender?: string;
  senderName?: string;
} {
  try {
    const parsed = entry.content_json
      ? (JSON.parse(entry.content_json) as {
          sender?: string;
          sender_name?: string;
        })
      : null;
    return {
      sender: normalizeWhitespace(parsed?.sender || ''),
      senderName: normalizeWhitespace(parsed?.sender_name || ''),
    };
  } catch {
    return {};
  }
}

function classifyImmediateMemoryClass(text: string): DurableMemoryClass {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return 'none';

  if (/(这次先|本次会话先|当前这轮|这一轮先|先别|暂时先|这轮先)/.test(normalized)) {
    return 'ttl_task';
  }
  if (/(这个项目里|在这个仓库里|这个仓库里|这个群里|这个客户沟通里|这个会话里)/.test(normalized)) {
    return 'group_durable';
  }
  if (
    /(我叫|我的名字是|叫我|你可以叫我|称呼我|以后都这么称呼我|我是|我来自|我的职位是)/.test(
      normalized,
    )
  ) {
    return 'identity';
  }
  if (
    /(默认用中文|默认用英文|默认中文回复|默认英文回复|以后默认|我喜欢|我更喜欢|我偏好|回复尽量|请尽量|请优先|默认不要)/.test(
      normalized,
    )
  ) {
    return 'global_durable';
  }
  return 'none';
}

function extractPreferredDisplayName(text: string): string {
  const patterns = [
    /(?:我叫|我的名字是|你可以叫我|叫我|称呼我(?:为)?)(?:\s|["'“”‘’])*\s*([^，。！？!?、,\s"'“”‘’]+)/u,
    /以后都这么称呼我(?:为)?(?:\s|["'“”‘’])*\s*([^，。！？!?、,\s"'“”‘’]+)/u,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = normalizeWhitespace(match?.[1] || '');
    if (candidate) return candidate;
  }
  return '';
}

function mergeIdentityAliases(
  existing: IdentityAliasRecord[],
  entry: ContextEntryRecord,
): Array<{
  channel?: string | null;
  externalUserId?: string | null;
  displayName?: string | null;
}> {
  const seen = new Set<string>();
  const aliases: Array<{
    channel?: string | null;
    externalUserId?: string | null;
    displayName?: string | null;
  }> = [];
  const pushAlias = (alias: {
    channel?: string | null;
    externalUserId?: string | null;
    displayName?: string | null;
  }) => {
    const normalized = {
      channel: normalizeWhitespace(alias.channel || '').toLowerCase() || null,
      externalUserId: normalizeWhitespace(alias.externalUserId || '') || null,
      displayName: normalizeWhitespace(alias.displayName || '') || null,
    };
    if (
      !normalized.channel &&
      !normalized.externalUserId &&
      !normalized.displayName
    ) {
      return;
    }
    const key = JSON.stringify(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    aliases.push(normalized);
  };

  for (const alias of existing) {
    pushAlias({
      channel: alias.channel,
      externalUserId: alias.external_user_id,
      displayName: alias.display_name,
    });
  }

  const metadata = parseEntryMetadata(entry);
  if (metadata.sender || metadata.senderName) {
    pushAlias({
      externalUserId: metadata.sender || null,
      displayName: metadata.senderName || null,
    });
  }

  return aliases;
}

async function upsertIdentityCandidate(input: {
  entry: ContextEntryRecord;
  groupFolder: string;
  chatJid: string;
  candidate: MemoryPromotionCandidate;
}): Promise<{ pathRef: string; status: "written" | "deduped"; }> {
  const binding = await getConversationIdentityBinding(input.chatJid);
  const existingProfile = binding?.person_id
    ? await getPersonProfile(binding.person_id)
    : undefined;
  const existingNotes = existingProfile
    ? uniqueStrings(
        (() => {
          try {
            const parsed = JSON.parse(existingProfile.notes_json || '[]') as unknown;
            return Array.isArray(parsed)
              ? parsed.filter((value): value is string => typeof value === 'string')
              : [];
          } catch {
            return [];
          }
        })(),
      )
    : [];
  const preferredDisplayName = extractPreferredDisplayName(input.candidate.text);
  const entryMetadata = parseEntryMetadata(input.entry);
  const displayName =
    preferredDisplayName ||
    existingProfile?.display_name ||
    entryMetadata.senderName ||
    'User';
  const personId =
    existingProfile?.id ||
    normalizeMemoryIdentityId(displayName, displayName) ||
    normalizeMemoryIdentityId(entryMetadata.sender || '', 'user');
  const nextNotes = uniqueStrings([...existingNotes, input.candidate.text]);
  const aliases = mergeIdentityAliases(
    existingProfile ? await listIdentityAliases(existingProfile.id) : [],
    input.entry,
  );
  const status =
    existingProfile &&
    existingProfile.display_name === displayName &&
    existingNotes.includes(input.candidate.text)
      ? 'deduped'
      : 'written';

  await createPersonProfile({
    id: personId,
    displayName,
    notes: nextNotes,
    aliases,
  });
  await bindConversationIdentity({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    personId,
  });
  return {
    pathRef: buildIdentityMemoryPathRef(personId),
    status,
  };
}

export async function autoPromoteMemoryFromEntries(input: {
  groupFolder: string;
  chatJid: string;
  entries: ContextEntryRecord[];
}): Promise<void> {
  const memoryConfig = await getMemoryContextConfig();
  if (!memoryConfig.memoryEnabled) {
    return;
  }

  for (const entry of input.entries) {
    if (entry.role !== 'user' || entry.source_type !== 'chat_message') continue;
    const candidate = (await extractDurableMemoryCandidates([entry]))[0];
    if (!candidate) continue;

    const memoryClass = classifyImmediateMemoryClass(candidate.text);
    if (
      memoryClass === 'none' ||
      memoryClass === 'session' ||
      memoryClass === 'ttl_task'
    ) {
      continue;
    }

    await storeMemoryPromotionEntry({
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      candidate,
      status: 'candidate',
      action: 'auto',
      memoryClass,
      origin: candidate.origin,
    });

    if (!memoryConfig.memoryWriteEnabled || !memoryConfig.autoSaveEnabled) {
      continue;
    }

    try {
      if (memoryClass === 'identity') {
        const result = await upsertIdentityCandidate({
          entry,
          groupFolder: input.groupFolder,
          chatJid: input.chatJid,
          candidate,
        });
        await storeMemoryPromotionEntry({
          groupFolder: input.groupFolder,
          chatJid: input.chatJid,
          candidate,
          status: result.status,
          pathRef: result.pathRef,
          action: 'auto',
          memoryClass: 'identity',
          origin: candidate.origin,
        });
        continue;
      }

      const scope =
        memoryClass === 'global_durable' && memoryConfig.globalWriteEnabled
          ? 'global'
          : 'group';
      const result = promoteCandidatesToScopedMemory(
        scope,
        input.groupFolder,
        [candidate],
      )[0];
      if (!result) continue;
      await storeMemoryPromotionEntry({
        groupFolder: input.groupFolder,
        chatJid: input.chatJid,
        candidate,
        status: result.status,
        pathRef: result.pathRef,
        action: 'auto',
        memoryClass: result.memoryClass,
        origin: candidate.origin,
      });
    } catch (err) {
      logger.warn(
        { err, chatJid: input.chatJid, groupFolder: input.groupFolder },
        'Failed to auto-promote memory candidate from user message',
      );
    }
  }
}
