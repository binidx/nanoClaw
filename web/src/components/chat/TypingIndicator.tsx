import React from 'react';
import { useTranslation } from 'react-i18next';

export interface TypingIndicatorProps {
  names: string[];
}

export const TypingIndicator: React.FC<TypingIndicatorProps> = ({ names }) => {
  const { t } = useTranslation('chat');
  if (names.length === 0) return null;

  const label =
    names.length === 1
      ? t('typing.single', { name: names[0] })
      : names.length <= 3
        ? t('typing.multiple', { names: names.join('、') })
        : t('typing.many', { names: names.slice(0, 2).join('、'), count: names.length });

  return (
    <div className="chat-typing-indicator">
      <div className="chat-typing-dots">
        <span className="chat-typing-dot" />
        <span className="chat-typing-dot" />
        <span className="chat-typing-dot" />
      </div>
      <span className="chat-typing-label">{label}</span>
    </div>
  );
};
