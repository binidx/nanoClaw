import React from 'react';
import { useTranslation } from 'react-i18next';

export interface ScrollToBottomProps {
  visible: boolean;
  unreadCount?: number;
  onClick: () => void;
}

export const ScrollToBottom: React.FC<ScrollToBottomProps> = ({
  visible,
  unreadCount = 0,
  onClick,
}) => {
  const { t } = useTranslation('chat');
  if (!visible) return null;

  return (
    <button className="chat-scroll-bottom" onClick={onClick} title={t('scrollToBottom')}>
      {unreadCount > 0 && (
        <span className="chat-scroll-bottom-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
      )}
      <span className="chat-scroll-bottom-arrow">↓</span>
    </button>
  );
};
