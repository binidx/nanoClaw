import React from 'react';
import { useTranslation } from 'react-i18next';

export interface QuoteBlockProps {
  senderName: string;
  content: string;
  onClear?: () => void;
  maxLength?: number;
}

export const QuoteBlock: React.FC<QuoteBlockProps> = ({
  senderName,
  content,
  onClear,
  maxLength = 120,
}) => {
  const { t } = useTranslation('chat');
  const truncated =
    content.length > maxLength ? content.slice(0, maxLength) + '…' : content;

  return (
    <div className="chat-quote-block">
      <div className="chat-quote-bar" />
      <div className="chat-quote-body">
        <span className="chat-quote-sender">{senderName}</span>
        <span className="chat-quote-text">{truncated}</span>
      </div>
      {onClear && (
        <button
          className="chat-quote-clear"
          onClick={onClear}
          title={t('quote.cancel')}
        >
          ×
        </button>
      )}
    </div>
  );
};
