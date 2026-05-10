import crypto from 'crypto';

export function slugifyInstanceId(instanceId: string): string {
  return (
    instanceId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 16) || 'default'
  );
}

export function buildFeishuJid(instanceId: string, chatId: string): string {
  return instanceId === 'default'
    ? `feishu:${chatId}`
    : `feishu:${instanceId}:${chatId}`;
}

export function parseFeishuJid(
  jid: string,
): { instanceId: string; chatId: string; explicit: boolean } | null {
  if (!jid.startsWith('feishu:')) return null;
  const payload = jid.slice('feishu:'.length);
  const separatorIndex = payload.indexOf(':');
  if (separatorIndex === -1) {
    return { instanceId: 'default', chatId: payload, explicit: false };
  }

  const instanceId = payload.slice(0, separatorIndex).trim();
  const chatId = payload.slice(separatorIndex + 1).trim();
  if (!instanceId || !chatId) return null;
  return { instanceId, chatId, explicit: true };
}

export function getFeishuApiCode(err: unknown): number | null {
  const code = (err as any)?.response?.data?.code;
  return typeof code === 'number' ? code : null;
}

export function deriveFeishuGroupFolder(
  instanceId: string,
  chatId: string,
): string {
  const instancePart = slugifyInstanceId(instanceId);
  const digest = crypto
    .createHash('sha1')
    .update(`${instanceId}:${chatId}`)
    .digest('hex')
    .slice(0, 12);
  return `feishu_${instancePart}_${digest}`;
}
