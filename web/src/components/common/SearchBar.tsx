import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';

export interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  children?: React.ReactNode;
}

export function SearchBar({ value, onChange, placeholder, children }: SearchBarProps) {
  const { t } = useTranslation('common');
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="nc-search-bar">
      <div className="nc-search-input-wrap">
        <input
          ref={inputRef}
          type="text"
          className="nc-search-input"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder || t('common.searchBar.placeholder')}
        />
        {value && (
          <button
            type="button"
            className="nc-search-clear"
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
        {!value && <span className="nc-search-icon">⌕</span>}
      </div>
      {children && <div className="nc-search-filters">{children}</div>}
    </div>
  );
}
