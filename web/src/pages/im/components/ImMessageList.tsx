import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImAttachment, ImMessage } from '../im-api';
import { ImLinkPreview } from './ImLinkPreview';
import { MessageBubble } from '../../../components/chat/MessageBubble.js';
import { ScrollToBottom } from '../../../components/chat/ScrollToBottom.js';
import { TypingIndicator } from '../../../components/chat/TypingIndicator.js';
import i18n from '../../../i18n';
import {
  extractDetectedUrls,
  findDetectedUrls,
  getImageAltText,
  isLikelyImageUrl,
} from '../../../message-link-utils';
import { decryptAttachmentBlob, type ImE2eeUiState } from '../im-e2ee';

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderTextWithLinks(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of findDetectedUrls(text)) {
    if (match.index > lastIndex) {
      parts.push(
        ...renderMentions(
          text.slice(lastIndex, match.index),
          `text-${lastIndex}`,
        ),
      );
    }

    if (isLikelyImageUrl(match.url)) {
      parts.push(
        <a
          key={`image-${match.index}`}
          href={match.url}
          target="_blank"
          rel="noopener noreferrer"
          className="md-image-link im-msg-inline-image-link"
        >
          <img
            className="md-inline-image im-msg-inline-image"
            src={match.url}
            alt={getImageAltText(match.url)}
            loading="lazy"
          />
        </a>,
      );
    } else {
      parts.push(
        <a
          key={`link-${match.index}`}
          href={match.url}
          target="_blank"
          rel="noopener noreferrer"
          className="im-msg-link"
        >
          {match.url}
        </a>,
      );
    }

    if (match.suffix) {
      parts.push(match.suffix);
    }

    lastIndex = match.index + match.raw.length;
  }

  if (lastIndex < text.length)
    parts.push(...renderMentions(text.slice(lastIndex), `text-${lastIndex}`));
  return parts;
}

function renderMentions(text: string, keyPrefix: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(@[^\s@]{1,64})/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push(
      <mark key={`${keyPrefix}-mention-${match.index}`} className="im-mention">
        {match[0]}
      </mark>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function ImageAttachment({ att }: { att: ImAttachment }) {
  const [lightbox, setLightbox] = useState(false);

  useEffect(() => {
    if (!lightbox) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [lightbox]);

  return (
    <>
      <img
        src={att.url}
        alt={att.fileName}
        onClick={() => setLightbox(true)}
        className="im-msg-image"
      />
      {lightbox && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setLightbox(false)}
          className="im-msg-lightbox"
        >
          <img
            src={att.url}
            alt={att.fileName}
            className="im-msg-lightbox-img"
          />
        </div>
      )}
    </>
  );
}

function FileAttachment({
  att,
  chatJid,
  currentUserId,
}: {
  att: ImAttachment;
  chatJid: string;
  currentUserId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const downloadEncrypted = useCallback(
    async (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (!att.encrypted) return;
      event.preventDefault();
      if (!chatJid || busy) return;
      setBusy(true);
      setError(null);
      try {
        const blob = await decryptAttachmentBlob(chatJid, currentUserId, att);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = att.fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        setError(err instanceof Error ? err.message : i18n.t('im.解密失败'));
      } finally {
        setBusy(false);
      }
    },
    [att, busy, chatJid, currentUserId],
  );

  return (
    <div>
      <a
        href={att.url}
        download={att.fileName}
        className="im-msg-file"
        onClick={downloadEncrypted}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <div className="im-msg-file-info">
          <div className="im-msg-file-name">{att.fileName}</div>
          <div className="im-msg-file-size">
            {formatSize(att.size)}
            {att.mimeType ? ` · ${att.mimeType}` : ''}
            {att.encrypted ? ` · ${i18n.t('im.加密附件')}` : ''}
          </div>
        </div>
        <span className="im-msg-file-download">
          {busy ? i18n.t('im.解密中…') : i18n.t('im.下载')}
        </span>
      </a>
      {error ? <div className="im-msg-file-error">{error}</div> : null}
    </div>
  );
}

function MessageAttachments({
  attachments,
  chatJid,
  currentUserId,
}: {
  attachments: ImAttachment[];
  chatJid: string;
  currentUserId: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="im-msg-attachments">
      {attachments.map((att) =>
        att.mimeType.startsWith('image/') && !att.encrypted ? (
          <ImageAttachment key={att.id} att={att} />
        ) : (
          <FileAttachment
            key={att.id}
            att={att}
            chatJid={chatJid}
            currentUserId={currentUserId}
          />
        ),
      )}
    </div>
  );
}

export interface ImMessageListProps {
  messages: ImMessage[];
  currentUserId: string;
  chatJid: string | null;
  loadingOlder: boolean;
  hasMoreOlder: boolean;
  onLoadOlder: () => void;
  onReply?: (messageId: string) => void;
  onEdit?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  onReact?: (messageId: string, emoji: string) => void;
  onRetry?: (messageId: string) => void;
  highlightedMessageId?: string | null;
  e2eeState?: ImE2eeUiState;
  typingNames?: string[];
}

export function ImMessageList({
  messages,
  currentUserId,
  chatJid,
  loadingOlder,
  hasMoreOlder,
  onLoadOlder,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onRetry,
  highlightedMessageId,
  e2eeState,
  typingNames = [],
}: ImMessageListProps) {
  const { t } = useTranslation('im');
  const rootRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  useEffect(() => {
    if (!stickBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!highlightedMessageId || !rootRef.current) return;
    const selector = `[data-im-message-id="${CSS.escape(highlightedMessageId)}"]`;
    const el = rootRef.current.querySelector<HTMLElement>(selector);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightedMessageId, messages]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    stickBottomRef.current = true;
    setShowScrollBtn(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const nearBottom = scrollHeight - scrollTop - clientHeight < 80;
    stickBottomRef.current = nearBottom;
    setShowScrollBtn(!nearBottom);
    if (scrollTop < 48 && hasMoreOlder && !loadingOlder) {
      onLoadOlder();
    }
  }, [hasMoreOlder, loadingOlder, onLoadOlder]);

  const messageById = useMemo(
    () => new Map(messages.map((m) => [m.id, m])),
    [messages],
  );

  const handleCopy = useCallback(
    (id: string) => {
      const msg = messageById.get(id);
      if (msg) {
        void navigator.clipboard.writeText(msg.content);
      }
    },
    [messageById],
  );

  return (
    <div className="im-message-list-wrap">
      <div ref={rootRef} onScroll={onScroll} className="im-message-list">
        {loadingOlder ? (
          <div className="im-message-list-hint">{t('im.加载更早的消息…')}</div>
        ) : !hasMoreOlder && messages.length > 0 ? (
          <div className="im-message-list-hint end">
            {t('im.已加载全部消息')}
          </div>
        ) : null}

        {e2eeState?.historyBoundaryText ? (
          <div className="im-e2ee-boundary">
            {e2eeState.historyBoundaryText}
          </div>
        ) : null}

        {messages.map((m, i) => {
          const mine = m.sender === currentUserId;
          const urls = extractDetectedUrls(m.content);
          const previewUrls = e2eeState?.enabled
            ? []
            : urls.filter((url) => !isLikelyImageUrl(url));
          const attachments = m.attachments || [];
          const isPlaceholder =
            m.content === '[文件]' && attachments.length > 0;
          const prevMsg = i > 0 ? messages[i - 1] : null;
          const stacked = prevMsg?.sender === m.sender;
          const senderName = mine ? t('im.我') : m.sender_name || m.sender;
          const initial = senderName.charAt(0).toUpperCase();

          const replyTo = m.reply_to_id
            ? (() => {
                const orig = messageById.get(m.reply_to_id!);
                if (!orig) return null;
                return {
                  senderName:
                    orig.sender === currentUserId
                      ? t('im.我')
                      : orig.sender_name || orig.sender,
                  content: orig.content,
                };
              })()
            : null;

          return (
            <div
              key={m.id}
              data-im-message-id={m.id}
              className={
                highlightedMessageId === m.id
                  ? 'im-message-highlight'
                  : undefined
              }
            >
              <MessageBubble
                id={m.id}
                isMine={mine}
                senderName={senderName}
                timestamp={m.timestamp}
                isEdited={!!m.edited_at}
                isDeleted={!!m.deleted_at}
                stacked={stacked}
                replyTo={replyTo}
                reactions={(m.reactions || []).map((r) => ({
                  ...r,
                  reacted: r.users?.includes(currentUserId),
                }))}
                avatar={<span>{initial}</span>}
                formatTime={formatTs}
                onReply={onReply}
                onEdit={mine ? onEdit : undefined}
                onDelete={mine ? onDelete : undefined}
                onCopy={handleCopy}
                onReact={onReact}
                content={
                  <>
                    {!isPlaceholder && (
                      <div
                        className={
                          m.e2eeError
                            ? 'im-msg-text im-e2ee-unreadable-message'
                            : 'im-msg-text'
                        }
                      >
                        {renderTextWithLinks(m.content)}
                      </div>
                    )}
                    <MessageAttachments
                      attachments={attachments}
                      chatJid={chatJid || m.chat_jid}
                      currentUserId={currentUserId}
                    />
                  </>
                }
              >
                {chatJid && previewUrls.length > 0 && (
                  <div className="im-msg-link-previews">
                    {previewUrls.slice(0, 3).map((url) => (
                      <ImLinkPreview
                        key={`${chatJid}:${url}`}
                        url={url}
                        chatJid={chatJid}
                      />
                    ))}
                  </div>
                )}
              </MessageBubble>
              {m.delivery_status ? (
                <div className={`im-delivery-state ${m.delivery_status}`}>
                  <span>
                    {m.delivery_status === 'sending'
                      ? t('im.发送中…')
                      : m.delivery_error || t('im.发送失败')}
                  </span>
                  {m.delivery_status === 'failed' && onRetry ? (
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() => onRetry(m.id)}
                    >
                      {t('im.重试')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}

        <TypingIndicator names={typingNames} />
        <div ref={bottomRef} />
      </div>

      <ScrollToBottom visible={showScrollBtn} onClick={scrollToBottom} />
    </div>
  );
}
