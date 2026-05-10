import { getWebChannel } from '../channels/web.js';

export interface ImAttachmentPayload {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
}

export function notifyImMessage(jid: string, message: Record<string, unknown>): void {
  const wc = getWebChannel();
  if (!wc) return;
  const id = String(message.id ?? '');
  const content = String(message.content ?? '');
  const sender = String(message.sender ?? '');
  const sender_name = String(message.sender_name ?? '');
  const timestamp = String(message.timestamp ?? new Date().toISOString());

  const extra: Record<string, unknown> = {};
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    extra.attachments = message.attachments;
  }
  if (typeof message.reply_to_id === 'string') {
    extra.reply_to_id = message.reply_to_id;
  }

  wc.notifyMessage(jid, {
    id,
    chat_jid: jid,
    content,
    sender,
    sender_name,
    timestamp,
    is_bot: false,
    client_id: typeof message.client_id === 'string' ? message.client_id : undefined,
    is_from_me: false,
    ...extra,
  });
}

export function notifyImEvent(jid: string, event: Record<string, unknown>): void {
  const wc = getWebChannel();
  if (!wc) return;
  wc.emitImEvent(jid, event);
}

export function notifyImUserEvent(
  _userId: string,
  _event: Record<string, unknown>,
): void {
  // Stub — targeted per-user notification requires WebSocket session lookup
  // which is planned for P1 phase.
}
