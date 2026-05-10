import React from 'react';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
}

export function PageHeader({ title, subtitle, actions, breadcrumb }: PageHeaderProps) {
  return (
    <div className="nc-page-header">
      {breadcrumb && <div className="nc-page-breadcrumb">{breadcrumb}</div>}
      <div className="nc-page-header-row">
        <div className="nc-page-header-text">
          <h2 className="nc-page-title">{title}</h2>
          {subtitle && <span className="nc-page-subtitle">{subtitle}</span>}
        </div>
        {actions && <div className="nc-page-header-actions">{actions}</div>}
      </div>
    </div>
  );
}
