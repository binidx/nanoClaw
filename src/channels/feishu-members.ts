import type { FeishuChatMember } from './feishu-types.js';
import { parseFeishuJid } from './feishu-jid.js';
import { feishuChannelRegistry } from './feishu-channel.js';

export async function listFeishuChatMembersByJid(
  chatJid: string,
): Promise<FeishuChatMember[]> {
  const parsed = parseFeishuJid(chatJid);
  if (!parsed) return [];
  const channel = feishuChannelRegistry.get(parsed.instanceId);
  if (!channel) return [];
  return channel.listChatMembers(chatJid);
}

export async function listFeishuOpenIdsByChatId(
  client: any,
  chatId: string,
): Promise<string[]> {
  const memberIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.im.chatMembers.get({
      path: { chat_id: chatId },
      params: {
        member_id_type: 'open_id',
        page_size: 100,
        page_token: pageToken,
      },
    });
    for (const item of response?.data?.items || []) {
      const memberId = String(item?.member_id || '').trim();
      if (!memberId || memberIds.includes(memberId)) continue;
      memberIds.push(memberId);
    }
    pageToken = response?.data?.has_more
      ? String(response?.data?.page_token || '').trim() || undefined
      : undefined;
  } while (pageToken);
  return memberIds;
}
