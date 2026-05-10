import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export interface ChatSearchProps {
  onSearch: (query: string) => void;
  onClose: () => void;
  placeholder?: string;
  resultCount?: number;
}

export const ChatSearch: React.FC<ChatSearchProps> = ({
  onSearch,
  onClose,
  placeholder: placeholderProp,
  resultCount,
}) => {
  const { t } = useTranslation('chat');
  const placeholder = placeholderProp ?? t('search.placeholder');
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const debouncedSearch = useCallback(
    (q: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onSearch(q), 300);
    },
    [onSearch],
  );

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return (
    <div className="chat-search-bar">
      <input
        ref={inputRef}
        className="chat-search-input"
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          debouncedSearch(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      />
      {resultCount !== undefined && value.trim() && (
        <span className="chat-search-count">
          {t('search.resultCount', { count: resultCount })}
        </span>
      )}
      {!value && (
        <span className="chat-search-icon" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </span>
      )}
      <button className="chat-search-close" onClick={onClose} title={t('search.close')}>
        ×
      </button>
    </div>
  );
};
