import React from 'react';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
  meta,
  className = '',
}: PageHeaderProps) {
  return (
    <div className={`nc-page-header ${className}`.trim()}>
      {breadcrumb && <div className="nc-page-breadcrumb">{breadcrumb}</div>}
      <div className="nc-page-header-surface">
        <div className="nc-page-header-row">
          <div className="nc-page-header-copy">
            <div className="nc-page-header-text">
              <h2 className="nc-page-title">{title}</h2>
              {subtitle && <span className="nc-page-subtitle">{subtitle}</span>}
            </div>
            {meta ? <div className="nc-page-header-meta">{meta}</div> : null}
          </div>
          {actions && <div className="nc-page-header-actions">{actions}</div>}
        </div>
      </div>
    </div>
  );
}
