import React from 'react';
import { useTranslation } from 'react-i18next';

export interface CardGridProps {
  children: React.ReactNode;
  minCardWidth?: number;
  emptyText?: string;
  isEmpty?: boolean;
}

export function CardGrid({
  children,
  minCardWidth = 280,
  emptyText,
  isEmpty,
}: CardGridProps) {
  const { t } = useTranslation('common');
  if (isEmpty) {
    return (
      <div className="nc-card-grid-empty">
        <div className="nc-empty-icon">
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
        </div>
        <div className="nc-empty-text">{emptyText ?? t('common.cardGrid.noData')}</div>
      </div>
    );
  }

  return (
    <div
      className="nc-card-grid"
      style={{ '--nc-card-min-width': `${minCardWidth}px` } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

export interface CardProps {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  className?: string;
}

export function Card({ children, onClick, active, className }: CardProps) {
  return (
    <div
      className={`nc-card${active ? ' nc-card-active' : ''}${onClick ? ' nc-card-clickable' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? e => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
    >
      {children}
    </div>
  );
}
