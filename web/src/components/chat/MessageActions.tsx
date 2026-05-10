import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export interface MessageActionsProps {
  canEdit?: boolean;
  canDelete?: boolean;
  /** When true, shows "撤回" label instead of the delete icon */
  isRecallable?: boolean;
  onReply?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onCopy?: () => void;
  onReact?: (emoji: string) => void;
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '😢', '🔥'];

export const MessageActions: React.FC<MessageActionsProps> = ({
  canEdit,
  canDelete,
  isRecallable,
  onReply,
  onEdit,
  onDelete,
  onCopy,
  onReact,
}) => {
  const { t } = useTranslation('chat');
  const [showEmojis, setShowEmojis] = useState(false);

  const handleEmojiKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setShowEmojis(false);
    }
  }, []);

  return (
    <div className="chat-msg-actions" role="toolbar" aria-label={t('actions.toolbar')}>
      {onReact && (
        <div className="chat-msg-actions-emoji-wrap" onKeyDown={handleEmojiKeyDown}>
          <button
            className="chat-msg-action-btn"
            onClick={() => setShowEmojis(!showEmojis)}
            aria-label={t('actions.react')}
            aria-expanded={showEmojis}
            aria-haspopup="true"
          >
            😀
          </button>
          {showEmojis && (
            <div className="chat-msg-actions-emoji-picker" role="menu" aria-label={t('actions.selectEmoji')}>
              {QUICK_EMOJIS.map(e => (
                <button
                  key={e}
                  className="chat-msg-actions-emoji-item"
                  role="menuitem"
                  aria-label={t('actions.reactWith', { emoji: e })}
                  onClick={() => {
                    onReact(e);
                    setShowEmojis(false);
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {onReply && (
        <button className="chat-msg-action-btn" onClick={onReply} aria-label={t('actions.reply')} title={t('actions.reply')}>
          ↩
        </button>
      )}
      {canEdit && onEdit && (
        <button className="chat-msg-action-btn" onClick={onEdit} aria-label={t('actions.edit')} title={t('actions.edit')}>
          ✎
        </button>
      )}
      {onCopy && (
        <button className="chat-msg-action-btn" onClick={onCopy} aria-label={t('actions.copy')} title={t('actions.copy')}>
          ⧉
        </button>
      )}
      {canDelete && onDelete && (
        isRecallable ? (
          <button
            className="chat-msg-action-btn chat-msg-action-danger"
            onClick={onDelete}
            aria-label={t('actions.recall')}
            title={t('actions.recall')}
          >
            {t('actions.recall')}
          </button>
        ) : (
          <button
            className="chat-msg-action-btn chat-msg-action-danger"
            onClick={onDelete}
            aria-label={t('actions.delete')}
            title={t('actions.delete')}
          >
            <span aria-hidden="true">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </span>
          </button>
        )
      )}
    </div>
  );
};
