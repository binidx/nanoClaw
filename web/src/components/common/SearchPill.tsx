import React from 'react';

export interface SearchPillProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'onChange' | 'size' | 'value'
  > {
  value: string;
  onChange: (value: string) => void;
  clearLabel?: string;
  kbdLabel?: React.ReactNode;
  leadingIcon?: React.ReactNode;
  className?: string;
}

export function SearchPill({
  value,
  onChange,
  clearLabel,
  kbdLabel,
  leadingIcon,
  className = '',
  type = 'text',
  autoComplete = 'off',
  style,
  ...rest
}: SearchPillProps) {
  return (
    <label className={['nc-search-pill', className].filter(Boolean).join(' ')}>
      {leadingIcon ? (
        <span className="nc-search-pill-icon" aria-hidden="true">
          {leadingIcon}
        </span>
      ) : null}
      <input
        className="nc-search-pill-input"
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={style}
        {...rest}
      />
      {value ? (
        <button
          type="button"
          className="nc-search-pill-clear"
          onClick={() => onChange('')}
          aria-label={clearLabel}
        >
          ×
        </button>
      ) : kbdLabel ? (
        <span className="nc-search-pill-kbd">{kbdLabel}</span>
      ) : null}
    </label>
  );
}
