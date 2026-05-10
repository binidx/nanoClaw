import { listConversationParticipants } from '../db.js';
import type {
  FeishuDocAuthorizationTargetResult,
  FeishuDocChatGrantResult,
  FeishuDocPermissionBatchResult,
  FeishuDocSection,
  FeishuDocUserGrantResult,
} from './feishu-types.js';
import { getFeishuApiCode, parseFeishuJid } from './feishu-jid.js';
import { feishuChannelRegistry } from './feishu-channel.js';
import { listFeishuOpenIdsByChatId } from './feishu-members.js';

const FEISHU_PERMISSION_BATCH_SIZE = 20;
const FEISHU_PERMISSION_RETRY_LIMIT = 3;
const FEISHU_PERMISSION_RETRY_BACKOFF_MS = 500;
const FEISHU_DOC_BLOCK_BATCH_SIZE = 50;

interface FeishuDocTestInstance {
  client: any;
  botOpenId: string;
}

let feishuDocSleepImplementation = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const feishuDocTestRegistry = new Map<string, FeishuDocTestInstance>();

function resolveFeishuDocBinding(chatJid: string): {
  client: any;
  chatId: string;
  botOpenId: string;
} {
  const parsed = parseFeishuJid(chatJid);
  if (!parsed) {
    throw new Error(`Invalid Feishu JID: ${chatJid}`);
  }
  const testInstance = feishuDocTestRegistry.get(parsed.instanceId);
  if (testInstance) {
    return {
      client: testInstance.client,
      chatId: parsed.chatId,
      botOpenId: testInstance.botOpenId,
    };
  }
  const channel = feishuChannelRegistry.get(parsed.instanceId);
  if (!channel || !channel.ownsJid(chatJid)) {
    throw new Error(`No Feishu instance owns JID: ${chatJid}`);
  }
  return {
    client: channel.getDocHelperClient(),
    chatId: parsed.chatId,
    botOpenId: channel.getBotOpenId(),
  };
}

interface FeishuTextElementStyle {
  bold?: boolean;
  inline_code?: boolean;
  link?: {
    url: string;
  };
}

interface FeishuTextRun {
  content: string;
  text_element_style?: FeishuTextElementStyle;
}

type FeishuTextElement = { text_run: FeishuTextRun };

function buildFeishuTextElement(
  content: string,
  style?: FeishuTextElementStyle,
): FeishuTextElement {
  if (!style || (!style.bold && !style.inline_code && !style.link)) {
    return { text_run: { content } };
  }
  return {
    text_run: {
      content,
      text_element_style: style,
    },
  };
}

function sameFeishuTextStyle(
  left?: FeishuTextElementStyle,
  right?: FeishuTextElementStyle,
): boolean {
  return !!left?.bold === !!right?.bold &&
    !!left?.inline_code === !!right?.inline_code &&
    String(left?.link?.url || '') === String(right?.link?.url || '');
}

function pushFeishuTextElement(
  elements: FeishuTextElement[],
  content: string,
  style?: FeishuTextElementStyle,
): void {
  if (!content) return;
  const last = elements[elements.length - 1];
  if (last && sameFeishuTextStyle(last.text_run.text_element_style, style)) {
    last.text_run.content += content;
    return;
  }
  elements.push(buildFeishuTextElement(content, style));
}

function tryConsumeWrappedFeishuInline(
  text: string,
  index: number,
  marker: '`' | '**',
): { content: string; nextIndex: number } | null {
  if (!text.startsWith(marker, index)) {
    return null;
  }
  const endIndex = text.indexOf(marker, index + marker.length);
  if (endIndex <= index + marker.length) {
    return null;
  }
  const content = text.slice(index + marker.length, endIndex);
  if (content.includes('\n') || content.includes('\r')) {
    return null;
  }
  return {
    content,
    nextIndex: endIndex + marker.length,
  };
}

function tryConsumeFeishuLinkInline(
  text: string,
  index: number,
): { content: string; url: string; nextIndex: number } | null {
  if (text[index] !== '[') {
    return null;
  }
  const labelEnd = text.indexOf(']', index + 1);
  if (labelEnd <= index + 1 || text[labelEnd + 1] !== '(') {
    return null;
  }
  const urlEnd = text.indexOf(')', labelEnd + 2);
  if (urlEnd <= labelEnd + 2) {
    return null;
  }
  const content = text.slice(index + 1, labelEnd);
  const url = text.slice(labelEnd + 2, urlEnd).trim();
  if (!content || !url || content.includes('\n') || content.includes('\r')) {
    return null;
  }
  return {
    content,
    url,
    nextIndex: urlEnd + 1,
  };
}

function mergeFeishuTextStyle(
  base?: FeishuTextElementStyle,
  extra?: FeishuTextElementStyle,
): FeishuTextElementStyle | undefined {
  if (!base && !extra) {
    return undefined;
  }
  return {
    ...(base || {}),
    ...(extra || {}),
  };
}

function buildFeishuTextElements(
  text: string,
  options?: {
    parseInlineMarkdown?: boolean;
    baseStyle?: FeishuTextElementStyle;
  },
): FeishuTextElement[] {
  if (options?.parseInlineMarkdown === false) {
    return [buildFeishuTextElement(text, options.baseStyle)];
  }

  const elements: FeishuTextElement[] = [];
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    const inlineCode = tryConsumeWrappedFeishuInline(text, index, '`');
    if (inlineCode) {
      pushFeishuTextElement(
        elements,
        text.slice(plainStart, index),
        options?.baseStyle,
      );
      pushFeishuTextElement(
        elements,
        inlineCode.content,
        mergeFeishuTextStyle(options?.baseStyle, { inline_code: true }),
      );
      index = inlineCode.nextIndex;
      plainStart = index;
      continue;
    }

    const bold = tryConsumeWrappedFeishuInline(text, index, '**');
    if (bold) {
      pushFeishuTextElement(
        elements,
        text.slice(plainStart, index),
        options?.baseStyle,
      );
      elements.push(
        ...buildFeishuTextElements(bold.content, {
          baseStyle: mergeFeishuTextStyle(options?.baseStyle, { bold: true }),
        }),
      );
      index = bold.nextIndex;
      plainStart = index;
      continue;
    }

    const link = tryConsumeFeishuLinkInline(text, index);
    if (link) {
      pushFeishuTextElement(
        elements,
        text.slice(plainStart, index),
        options?.baseStyle,
      );
      elements.push(
        ...buildFeishuTextElements(link.content, {
          baseStyle: mergeFeishuTextStyle(options?.baseStyle, {
            link: { url: link.url },
          }),
        }),
      );
      index = link.nextIndex;
      plainStart = index;
      continue;
    }

    index += 1;
  }

  pushFeishuTextElement(elements, text.slice(plainStart), options?.baseStyle);
  return elements.length > 0
    ? elements
    : [buildFeishuTextElement(text, options?.baseStyle)];
}

function mapFeishuHeadingField(level: 1 | 2 | 3): 'heading1' | 'heading2' | 'heading3' {
  if (level === 1) return 'heading1';
  if (level === 2) return 'heading2';
  return 'heading3';
}

function mapFeishuDocSectionToBlock(
  section: FeishuDocSection,
): Record<string, unknown> {
  if (section.kind === 'heading') {
    return {
      block_type: section.level === 1 ? 3 : section.level === 2 ? 4 : 5,
      [mapFeishuHeadingField(section.level)]: {
        elements: buildFeishuTextElements(section.text),
      },
    };
  }
  if (section.kind === 'code') {
    return {
      block_type: 14,
      code: {
        elements: buildFeishuTextElements(section.text, {
          parseInlineMarkdown: false,
        }),
      },
    };
  }
  return {
    block_type: 2,
    text: {
      elements: buildFeishuTextElements(section.text),
    },
  };
}

function splitIntoBatches(memberIds: string[], batchSize: number): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < memberIds.length; index += batchSize) {
    batches.push(memberIds.slice(index, index + batchSize));
  }
  return batches;
}

function normalizeFeishuMemberBatches(input: {
  openIds?: string[];
  batches?: string[][];
}): string[][] {
  if (input.batches && input.batches.length > 0) {
    return input.batches
      .map((batch) => batch.map((memberId) => String(memberId || '').trim()))
      .map((batch) => [...new Set(batch.filter(Boolean))])
      .filter((batch) => batch.length > 0);
  }
  const memberIds = [...new Set((input.openIds || []).map((entry) => entry.trim()))]
    .filter(Boolean);
  return splitIntoBatches(memberIds, FEISHU_PERMISSION_BATCH_SIZE);
}

function getFeishuErrorMessage(err: unknown): string {
  const responseMsg = String((err as any)?.response?.data?.msg || '').trim();
  if (responseMsg) return responseMsg;
  const message = String((err as Error | undefined)?.message || '').trim();
  if (message) return message;
  return 'Unknown Feishu API error';
}

function isTransientFeishuPermissionError(err: unknown): boolean {
  const apiCode = getFeishuApiCode(err);
  if (apiCode === 99991663 || apiCode === 1254290) {
    return true;
  }
  const message = getFeishuErrorMessage(err).toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('temporarily unavailable')
  );
}

function pickRecentFeishuSenderCounterpart(
  participantRows: Awaited<ReturnType<typeof listConversationParticipants>>,
  botOpenId: string,
): string | null {
  const recentSender = participantRows.find(
    (entry) =>
      entry.source === 'feishu_message' &&
      entry.member_id.trim() &&
      entry.member_id !== botOpenId,
  );
  if (recentSender) {
    return recentSender.member_id;
  }
  const persisted = participantRows.find(
    (entry) => entry.member_id.trim() && entry.member_id !== botOpenId,
  );
  return persisted?.member_id || null;
}

export async function createFeishuDocByJid(
  chatJid: string,
  input: { title: string; folderToken?: string },
): Promise<{ documentId: string; title: string }> {
  const { client } = resolveFeishuDocBinding(chatJid);
  const response = await client.docx.document.create({
    data: {
      title: input.title,
      folder_token: input.folderToken,
    },
  });
  const documentId = String(response?.data?.document?.document_id || '').trim();
  if (!documentId) {
    throw new Error('Feishu doc creation did not return a document ID');
  }
  const title =
    String(response?.data?.document?.title || '').trim() || input.title.trim();
  return { documentId, title };
}

export async function populateFeishuDocByJid(
  chatJid: string,
  input: { documentId: string; sections: FeishuDocSection[] },
): Promise<void> {
  const { client } = resolveFeishuDocBinding(chatJid);
  const sections = input.sections.filter((section) =>
    String((section as any)?.text || '').trim(),
  );
  if (sections.length === 0) {
    throw new Error('Feishu doc population requires at least one non-empty section');
  }
  for (
    let index = 0;
    index < sections.length;
    index += FEISHU_DOC_BLOCK_BATCH_SIZE
  ) {
    const children = sections
      .slice(index, index + FEISHU_DOC_BLOCK_BATCH_SIZE)
      .map((section) => mapFeishuDocSectionToBlock(section));
    await client.docx.documentBlockChildren.create({
      path: {
        document_id: input.documentId,
        block_id: input.documentId,
      },
      data: {
        children,
      },
    });
  }
}

export async function resolveFeishuDocUrlByJid(
  chatJid: string,
  input: { documentId: string },
): Promise<string> {
  const { client } = resolveFeishuDocBinding(chatJid);
  const response = await client.drive.meta.batchQuery({
    data: {
      request_docs: [
        {
          doc_token: input.documentId,
          doc_type: 'docx',
        },
      ],
      with_url: true,
    },
  });
  const url = String(response?.data?.metas?.[0]?.url || '').trim();
  if (!url) {
    throw new Error('Feishu doc URL lookup did not return a share URL');
  }
  return url;
}

export async function getFeishuChatContextByJid(
  chatJid: string,
): Promise<{ chatId: string; isGroup: boolean; participantOpenIds: string[] }> {
  const { client, chatId } = resolveFeishuDocBinding(chatJid);
  const chat = await client.im.chat.get({
    path: { chat_id: chatId },
    params: { user_id_type: 'open_id' },
  });
  const isGroup =
    chat?.data?.chat_mode === 'group' || chat?.data?.chat_type === 'group';
  const participantOpenIds = await listFeishuOpenIdsByChatId(client, chatId);
  return {
    chatId,
    isGroup,
    participantOpenIds,
  };
}

export async function resolveFeishuDmCounterpartOpenIdByJid(
  chatJid: string,
): Promise<string> {
  const { client, chatId, botOpenId } = resolveFeishuDocBinding(chatJid);
  const liveMemberIds = (await listFeishuOpenIdsByChatId(client, chatId)).filter(
    (memberId) => memberId !== botOpenId,
  );
  if (liveMemberIds.length === 1) {
    return liveMemberIds[0]!;
  }
  const persistedParticipants = await listConversationParticipants(chatJid);
  const fallback = pickRecentFeishuSenderCounterpart(
    persistedParticipants,
    botOpenId,
  );
  if (!fallback) {
    throw new Error(`Unable to resolve Feishu DM counterpart for ${chatJid}`);
  }
  return fallback;
}

export async function grantFeishuDocToChatByJid(
  chatJid: string,
  input: {
    documentId: string;
    chatId: string;
    perm: 'view' | 'edit' | 'full_access';
  },
): Promise<FeishuDocChatGrantResult> {
  const { client } = resolveFeishuDocBinding(chatJid);
  await client.drive.permissionMember.create({
    path: { token: input.documentId },
    params: { type: 'docx', need_notification: false },
    data: {
      member_type: 'openchat',
      member_id: input.chatId,
      perm: input.perm,
      type: 'chat',
    },
  });
  return {
    authorizationStrategy: 'chat',
    authorizationStatus: 'complete',
    warnings: [],
    targets: [
      {
        targetType: 'chat',
        targetId: input.chatId,
        status: 'success',
      },
    ],
  };
}

export async function grantFeishuDocToUsersByJid(
  chatJid: string,
  input: {
    documentId: string;
    openIds?: string[];
    batches?: string[][];
    perm?: 'view' | 'edit' | 'full_access';
  },
): Promise<FeishuDocUserGrantResult> {
  const { client } = resolveFeishuDocBinding(chatJid);
  const normalizedBatches = normalizeFeishuMemberBatches(input);
  if (normalizedBatches.length === 0) {
    return {
      authorizationStrategy: 'users',
      authorizationStatus: 'failed',
      warnings: ['No Feishu users resolved for document authorization'],
      batches: [],
      targets: [],
    };
  }
  const batchResults: FeishuDocPermissionBatchResult[] = [];
  const targets: FeishuDocAuthorizationTargetResult[] = [];
  for (const [batchIndex, memberIds] of normalizedBatches.entries()) {
    let attempts = 0;
    let lastError: unknown = null;
    while (attempts < FEISHU_PERMISSION_RETRY_LIMIT) {
      try {
        await client.drive.permissionMember.batchCreate({
          path: { token: input.documentId },
          params: { type: 'docx', need_notification: false },
          data: {
            members: memberIds.map((memberId) => ({
              member_type: 'openid',
              member_id: memberId,
              perm: input.perm || 'edit',
              type: 'user',
            })),
          },
        });
        batchResults.push({
          batchIndex,
          status: 'success',
          memberIds,
        });
        for (const memberId of memberIds) {
          targets.push({
            targetType: 'user',
            targetId: memberId,
            status: 'success',
          });
        }
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        attempts += 1;
        if (
          attempts < FEISHU_PERMISSION_RETRY_LIMIT &&
          isTransientFeishuPermissionError(err)
        ) {
          await feishuDocSleepImplementation(FEISHU_PERMISSION_RETRY_BACKOFF_MS);
          continue;
        }
        break;
      }
    }
    if (lastError) {
      const error = getFeishuErrorMessage(lastError);
      batchResults.push({
        batchIndex,
        status: 'failed',
        memberIds,
        error,
      });
      for (const memberId of memberIds) {
        targets.push({
          targetType: 'user',
          targetId: memberId,
          status: 'failed',
          error,
        });
      }
    }
  }

  const successCount = batchResults.filter((entry) => entry.status === 'success')
    .length;
  const failureCount = batchResults.filter((entry) => entry.status === 'failed')
    .length;
  const authorizationStatus =
    failureCount === 0
      ? 'complete'
      : successCount === 0
        ? 'failed'
        : 'partial';

  return {
    authorizationStrategy: 'users',
    authorizationStatus,
    warnings:
      authorizationStatus === 'complete'
        ? []
        : [`${failureCount} Feishu permission batch(es) failed`],
    batches: batchResults,
    targets,
  };
}

export const __testing = {
  registerTestInstance(input: {
    instanceId: string;
    client: any;
    botOpenId?: string;
  }): void {
    feishuDocTestRegistry.set(input.instanceId, {
      client: input.client,
      botOpenId: String(input.botOpenId || '').trim(),
    });
  },
  setSleepImplementation(
    implementation: (ms: number) => Promise<void>,
  ): void {
    feishuDocSleepImplementation = implementation;
  },
  reset(): void {
    feishuDocTestRegistry.clear();
    feishuDocSleepImplementation = async (ms: number): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    };
  },
};
