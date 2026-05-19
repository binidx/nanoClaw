import React from 'react';

export interface CatalogPageShellProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  controls?: React.ReactNode;
  bodyClassName?: string;
}

export function CatalogPageShell({
  title,
  subtitle,
  controls,
  bodyClassName = '',
  className = '',
  children,
  ...rest
}: CatalogPageShellProps) {
  return (
    <div
      className={['page-view', 'nc-catalog-page', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <section className="nc-catalog-page-canvas">
        <header className="nc-catalog-page-hero">
          <div className="nc-catalog-page-copy">
            <div className="nc-catalog-page-title-stack">
              <h2>{title}</h2>
              {subtitle ? <p>{subtitle}</p> : null}
            </div>
          </div>
          {controls ? (
            <div className="nc-catalog-page-controls">{controls}</div>
          ) : null}
        </header>
        <div
          className={['nc-catalog-page-body', bodyClassName]
            .filter(Boolean)
            .join(' ')}
        >
          {children}
        </div>
      </section>
    </div>
  );
}
