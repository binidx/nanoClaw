import React from 'react';

export interface LibraryCardRow {
  key?: React.Key;
  label: React.ReactNode;
  value: React.ReactNode;
}

export interface LibraryCardProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  heading: React.ReactNode;
  badge?: React.ReactNode;
  rows: LibraryCardRow[];
  bodyClassName?: string;
}

export function LibraryCard({
  heading,
  badge,
  rows,
  bodyClassName = '',
  className = '',
  type = 'button',
  ...rest
}: LibraryCardProps) {
  const visibleRows = rows.filter(
    (row) =>
      row.value !== null && row.value !== undefined && row.value !== false,
  );

  return (
    <button
      type={type}
      className={['nc-library-card', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <div className="nc-library-card-header">
        <strong>{heading}</strong>
        {badge ? <span className="nc-library-card-badge">{badge}</span> : null}
      </div>
      <div
        className={['nc-library-card-body', bodyClassName]
          .filter(Boolean)
          .join(' ')}
      >
        {visibleRows.map((row, index) => (
          <div
            key={row.key ?? `${String(row.label)}-${index}`}
            className="nc-library-card-row"
          >
            <span className="nc-library-card-label">{row.label}</span>
            <span className="nc-library-card-value">{row.value}</span>
          </div>
        ))}
      </div>
    </button>
  );
}
