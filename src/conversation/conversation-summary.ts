import { t } from '../i18n/index.js';
interface ChannelInstanceLike {
  id: string;
  type: string;
  name: string;
}

function getBaseChannelLabel(channel: string): string {
  switch (channel) {
    case 'web':
      return 'Web';
    case 'feishu':
      return t('errors.auto_7714e5', {}, undefined);
    case 'telegram':
      return 'Telegram';
    case 'discord':
      return 'Discord';
    case 'slack':
      return 'Slack';
    case 'gmail':
      return 'Gmail';
    case 'whatsapp':
      return 'WhatsApp';
    default:
      return channel || t('conversation.unknownChannel', {}, undefined);
  }
}

export function extractChannelInstanceId(
  jid: string,
  channel: string,
): string | null {
  if (!channel || channel === 'web') return null;
  const prefix = `${channel}:`;
  if (!jid.startsWith(prefix)) return null;
  const payload = jid.slice(prefix.length);
  const separatorIndex = payload.indexOf(':');
  return separatorIndex === -1
    ? 'default'
    : payload.slice(0, separatorIndex).trim() || 'default';
}

function deriveConversationChannelLabel(
  jid: string,
  channel: string,
  instances: ChannelInstanceLike[],
): string | undefined {
  const baseLabel = getBaseChannelLabel(channel);
  const instanceId = extractChannelInstanceId(jid, channel);
  if (!instanceId) {
    return baseLabel;
  }

  const instance = instances.find(
    (entry) => entry.type === channel && entry.id === instanceId,
  );
  if (!instance) {
    return instanceId === 'default'
      ? baseLabel
      : `${baseLabel} · ${instanceId}`;
  }
  return `${baseLabel} · ${instance.name}`;
}

export function createConversationSummaryDecorator(deps: {
  getConfiguredChannelInstances: () =>
    | ChannelInstanceLike[]
    | Promise<ChannelInstanceLike[]>;
  getConversationLastEventSeq: (jid: string) => number;
}) {
  return async function decorateConversationSummary<
    T extends { jid: string; channel: string; name?: string },
  >(
    conversation: T,
  ): Promise<
    T & {
      channel_label: string;
      source_name: string;
      route: Record<string, unknown>;
      last_event_seq: number;
    }
  > {
    const instanceId = extractChannelInstanceId(
      conversation.jid,
      conversation.channel,
    );
    const instances = await Promise.resolve(
      deps.getConfiguredChannelInstances(),
    );
    return {
      ...conversation,
      source_name: conversation.name || conversation.jid,
      channel_label:
        deriveConversationChannelLabel(
          conversation.jid,
          conversation.channel,
          instances,
        ) || conversation.channel,
      route: {
        channel: conversation.channel || '',
        jid: conversation.jid,
        ...(instanceId ? { instanceId } : {}),
      },
      last_event_seq: deps.getConversationLastEventSeq(conversation.jid),
    };
  };
}
