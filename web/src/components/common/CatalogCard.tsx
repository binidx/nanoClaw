import React from 'react';

export interface CatalogCardRow {
  key?: React.Key;
  label: React.ReactNode;
  value: React.ReactNode;
}

export interface CatalogCardProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    'children' | 'title'
  > {
  title: React.ReactNode;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  rows?: CatalogCardRow[];
  footer?: React.ReactNode;
  bodyClassName?: string;
}

export function CatalogCard({
  title,
  description,
  badge,
  leading,
  trailing,
  rows = [],
  footer,
  bodyClassName = '',
  className = '',
  type = 'button',
  ...rest
}: CatalogCardProps) {
  const visibleRows = rows.filter(
    (row) =>
      row.value !== null && row.value !== undefined && row.value !== false,
  );

  return (
    <button
      type={type}
      className={['nc-catalog-card', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <div className="nc-catalog-card-head">
        {leading ? (
          <div className="nc-catalog-card-leading">{leading}</div>
        ) : null}
        <div className="nc-catalog-card-copy">
          <div className="nc-catalog-card-title-row">
            <strong>{title}</strong>
            {badge ? (
              <span className="nc-catalog-card-badge">{badge}</span>
            ) : null}
          </div>
          {description ? (
            <p className="nc-catalog-card-description">{description}</p>
          ) : null}
        </div>
        {trailing ? (
          <div className="nc-catalog-card-trailing">{trailing}</div>
        ) : null}
      </div>
      {visibleRows.length > 0 ? (
        <div
          className={['nc-catalog-card-body', bodyClassName]
            .filter(Boolean)
            .join(' ')}
        >
          {visibleRows.map((row, index) => (
            <div
              key={row.key ?? `${String(row.label)}-${index}`}
              className="nc-catalog-card-row"
            >
              <span className="nc-catalog-card-label">{row.label}</span>
              <span className="nc-catalog-card-value">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {footer ? <div className="nc-catalog-card-footer">{footer}</div> : null}
    </button>
  );
}
