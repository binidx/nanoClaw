import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { QuoteBlock } from './QuoteBlock.js';
import { ReactionBar, type ReactionGroup } from './ReactionBar.js';
import { MessageActions } from './MessageActions.js';

export interface MessageBubbleProps {
  id: string;
  content: React.ReactNode;
  senderName: string;
  timestamp: string;
  isMine: boolean;
  isEdited?: boolean;
  isDeleted?: boolean;
  avatar?: React.ReactNode;
  replyTo?: { senderName: string; content: string } | null;
  reactions?: ReactionGroup[];
  stacked?: boolean;
  onReply?: (id: string) => void;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onCopy?: (id: string) => void;
  onReact?: (id: string, emoji: string) => void;
  formatTime?: (ts: string) => string;
  children?: React.ReactNode;
}

function defaultFormatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  } catch {
    return '';
  }
}

const RECALL_WINDOW_MS = 2 * 60 * 1000;

export const MessageBubble: React.FC<MessageBubbleProps> = ({
  id,
  content,
  senderName,
  timestamp,
  isMine,
  isEdited,
  isDeleted,
  avatar,
  replyTo,
  reactions = [],
  stacked = false,
  onReply,
  onEdit,
  onDelete,
  onCopy,
  onReact,
  formatTime = defaultFormatTime,
  children,
}) => {
  const { t } = useTranslation('chat');
  const [showActions, setShowActions] = useState(false);

  const handleReply = useCallback(() => onReply?.(id), [id, onReply]);
  const handleEdit = useCallback(() => onEdit?.(id), [id, onEdit]);
  const handleDelete = useCallback(() => onDelete?.(id), [id, onDelete]);
  const handleCopy = useCallback(() => onCopy?.(id), [id, onCopy]);
  const handleReact = useCallback(
    (emoji: string) => onReact?.(id, emoji),
    [id, onReact],
  );
  const handleToggleReaction = useCallback(
    (emoji: string) => onReact?.(id, emoji),
    [id, onReact],
  );

  const [recallNow, setRecallNow] = useState(() => Date.now());
  const getRecallable = (nowMs: number) => {
    if (!isMine || !timestamp) return false;
    const elapsed = nowMs - new Date(timestamp).getTime();
    return Number.isFinite(elapsed) && elapsed < RECALL_WINDOW_MS;
  };
  const isRecallable = getRecallable(recallNow);

  useEffect(() => {
    const elapsed = Date.now() - new Date(timestamp).getTime();
    if (!isMine || !timestamp || !Number.isFinite(elapsed) || elapsed >= RECALL_WINDOW_MS) {
      return;
    }
    const timer = setTimeout(
      () => setRecallNow(Date.now()),
      RECALL_WINDOW_MS - elapsed,
    );
    return () => clearTimeout(timer);
  }, [isMine, timestamp]);

  const side = isMine ? 'mine' : 'theirs';
  const stackClass = stacked ? ' stacked' : '';

  return (
    <div
      className={`chat-bubble-row ${side}${stackClass}`}
      tabIndex={-1}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      onFocus={() => setShowActions(true)}
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setShowActions(false);
        }
      }}
    >
      <div className={`chat-bubble-avatar${stacked ? ' ghost' : ''}`}>
        {!stacked && avatar}
      </div>
      <div className="chat-bubble-content-wrap">
        {!stacked && !isMine && (
          <span className="chat-bubble-sender">{senderName}</span>
        )}
        {replyTo && (
          <QuoteBlock
            senderName={replyTo.senderName}
            content={replyTo.content}
          />
        )}
        <div className={`chat-bubble ${side}${isDeleted ? ' deleted' : ''}`}>
          {isDeleted ? (
            <span className="chat-bubble-deleted">{t('bubble.deleted')}</span>
          ) : (
            content
          )}
        </div>
        {children}
        <ReactionBar
          reactions={reactions}
          onToggle={handleToggleReaction}
        />
        <div className="chat-bubble-meta">
          {isEdited && <span className="chat-bubble-edited">{t('bubble.edited')}</span>}
          <span className="chat-bubble-time">{formatTime(timestamp)}</span>
        </div>
        {showActions && !isDeleted && (
          <MessageActions
            canEdit={isMine}
            canDelete={isMine}
            isRecallable={isRecallable}
            onReply={onReply ? handleReply : undefined}
            onEdit={isMine && onEdit ? handleEdit : undefined}
            onDelete={isMine && onDelete ? handleDelete : undefined}
            onCopy={onCopy ? handleCopy : undefined}
            onReact={onReact ? handleReact : undefined}
          />
        )}
      </div>
    </div>
  );
};
