import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImConversation, ImMessage } from '../im-api';
import { buildImE2eeUiState, type PlainAttachmentMeta } from '../im-e2ee';
import { ImInputBar } from './ImInputBar';
import { ImMessageList } from './ImMessageList';

export interface ImChatViewProps {
  conversation: ImConversation | null;
  messages: ImMessage[];
  currentUserId: string;
  chatLoading: boolean;
  loadingOlder: boolean;
  hasMoreOlder: boolean;
  roomKeyAvailable?: boolean;
  onLoadOlder: () => void;
  onSend: (
    text: string,
    attachmentIds: string[],
    encryptedAttachments?: PlainAttachmentMeta[],
  ) => void | Promise<void>;
  onEditMessage?: (messageId: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  onReactMessage?: (messageId: string, emoji: string) => void;
  onRetryMessage?: (messageId: string) => void;
  highlightedMessageId?: string | null;
  onToggleInfo?: () => void;
  infoPanelOpen?: boolean;
  onBack?: () => void;
}

function convTitle(
  c: ImConversation | null,
  t: (key: string) => string,
): string {
  if (!c) return t('im.消息');
  if (c.name?.trim()) return c.name;
  return c.chat_type === 'group' ? t('im.群聊') : t('im.私聊');
}

export function ImChatView({
  conversation,
  messages,
  currentUserId,
  chatLoading,
  loadingOlder,
  hasMoreOlder,
  roomKeyAvailable,
  onLoadOlder,
  onSend,
  onEditMessage,
  onDeleteMessage,
  onReactMessage,
  onRetryMessage,
  highlightedMessageId,
  onToggleInfo,
  infoPanelOpen,
  onBack,
}: ImChatViewProps) {
  const { t } = useTranslation('im');
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const mobileActionsRef = useRef<HTMLDivElement | null>(null);
  const e2eeState = buildImE2eeUiState({
    enabled: Number(conversation?.e2ee_enabled || 0) === 1,
    roomKeyAvailable,
    t,
  });
  const showMobileActions = Boolean(onBack && onToggleInfo);
  const infoActionLabel =
    conversation?.chat_type === 'group' ? t('im.群组配置') : t('im.会话信息');

  useEffect(() => {
    if (!mobileActionsOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (
        mobileActionsRef.current &&
        !mobileActionsRef.current.contains(event.target as Node)
      ) {
        setMobileActionsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileActionsOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileActionsOpen]);

  useEffect(() => {
    setMobileActionsOpen(false);
  }, [conversation?.jid, infoPanelOpen]);

  return (
    <section className="im-chat-section">
      <header className="im-chat-header">
        {onBack && (
          <button
            type="button"
            className="im-chat-back-btn"
            onClick={onBack}
            aria-label={t('im.返回')}
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
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="im-chat-title">{convTitle(conversation, t)}</h2>
          {conversation ? (
            <div className="settings-hint" style={{ marginTop: 2 }}>
              {conversation.chat_type === 'group'
                ? `${conversation.member_count} ${t('im.人')} · ${conversation.visibility === 'public' ? t('im.公开') : t('im.私有')}`
                : t('im.私聊')}
              {' · '}
              <span className={`im-e2ee-chip ${e2eeState.badgeClass}`}>
                {e2eeState.badgeText}
              </span>
              {e2eeState.enabled ? (
                <span className="im-e2ee-header-note">
                  {' '}
                  {e2eeState.headerText}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {onToggleInfo ? (
          showMobileActions ? (
            <div className="im-chat-header-menu" ref={mobileActionsRef}>
              <button
                type="button"
                className={`im-chat-info-toggle${mobileActionsOpen || infoPanelOpen ? ' active' : ''}`}
                onClick={() => setMobileActionsOpen((open) => !open)}
                title={t('im.更多操作')}
                aria-label={t('im.更多操作')}
                aria-haspopup="menu"
                aria-expanded={mobileActionsOpen}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="5" cy="12" r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                  <circle cx="19" cy="12" r="1.5" />
                </svg>
              </button>
              {mobileActionsOpen ? (
                <div className="im-chat-header-menu-popup" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="im-chat-header-menu-item"
                    onClick={() => {
                      setMobileActionsOpen(false);
                      onBack?.();
                    }}
                  >
                    {t('im.返回会话列表')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="im-chat-header-menu-item"
                    onClick={() => {
                      setMobileActionsOpen(false);
                      onToggleInfo();
                    }}
                  >
                    {infoActionLabel}
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              className={`im-chat-info-toggle${infoPanelOpen ? ' active' : ''}`}
              onClick={onToggleInfo}
              title={infoPanelOpen ? t('im.关闭信息') : infoActionLabel}
              aria-label={infoPanelOpen ? t('im.关闭信息') : infoActionLabel}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
          )
        ) : null}
      </header>
      <div className="im-chat-body">
        {chatLoading ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span className="settings-hint">{t('im.加载消息中…')}</span>
          </div>
        ) : (
          <ImMessageList
            messages={messages}
            currentUserId={currentUserId}
            chatJid={conversation?.jid ?? null}
            loadingOlder={loadingOlder}
            hasMoreOlder={hasMoreOlder}
            onLoadOlder={onLoadOlder}
            onEdit={onEditMessage}
            onDelete={onDeleteMessage}
            onReact={onReactMessage}
            onRetry={onRetryMessage}
            highlightedMessageId={highlightedMessageId}
            e2eeState={e2eeState}
          />
        )}
        <ImInputBar
          disabled={!conversation || chatLoading}
          chatJid={conversation?.jid ?? null}
          currentUserId={currentUserId}
          e2eeEnabled={Number(conversation?.e2ee_enabled || 0) === 1}
          roomKeyAvailable={e2eeState.roomKeyAvailable}
          e2eePlaceholder={e2eeState.composerPlaceholder}
          onSend={onSend}
        />
      </div>
    </section>
  );
}
