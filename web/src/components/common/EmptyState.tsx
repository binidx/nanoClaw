import React from 'react';
import { useTranslation } from 'react-i18next';

function DefaultEmptyFolderIcon() {
  return (
    <span aria-hidden="true">
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      </svg>
    </span>
  );
}

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title?: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  const { t } = useTranslation('common');
  return (
    <div className="nc-empty-state">
      <div className="nc-empty-icon">{icon ?? <DefaultEmptyFolderIcon />}</div>
      <div className="nc-empty-title">{title ?? t('common.emptyState.noData')}</div>
      {description && <div className="nc-empty-desc">{description}</div>}
      {action && <div className="nc-empty-action">{action}</div>}
    </div>
  );
}
