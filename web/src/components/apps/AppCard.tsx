import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { NcCheckbox } from '../common';

export type AppCardVariant = 'mcp' | 'skill';
export type AppCardSource = 'private' | 'shared' | 'marketplace' | 'builtin';

export interface AppCardProps {
  id: string;
  name: string;
  description?: string | null;
  variant: AppCardVariant;
  source: AppCardSource;
  enabled?: boolean;
  iconUrl?: string | null;
  tags?: string[];
  isOwner?: boolean;
  onToggleEnabled?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onToggleVisibility?: () => void;
  onInstall?: () => void;
  installing?: boolean;
  installed?: boolean;
  extra?: ReactNode;
}

const VARIANT_LABELS: Record<AppCardVariant, string> = {
  mcp: 'MCP',
  skill: 'Skill',
};

export function AppCard({
  name,
  description,
  variant,
  source,
  enabled,
  tags,
  isOwner,
  onToggleEnabled,
  onEdit,
  onDelete,
  onToggleVisibility,
  onInstall,
  installing,
  installed,
  extra,
}: AppCardProps) {
  const { t } = useTranslation('apps');
  return (
    <div className={`app-card ${enabled === false ? 'app-card--disabled' : ''}`}>
      <div className="app-card__header">
        <div className="app-card__icon">
          {variant === 'mcp' ? (
            <span aria-hidden="true">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 22v-5" />
                <path d="M9 8V2" />
                <path d="M15 8V2" />
                <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
              </svg>
            </span>
          ) : (
            <span aria-hidden="true">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </span>
          )}
        </div>
        <div className="app-card__title-group">
          <div className="app-card__title">{name}</div>
          <div className="app-card__badges">
            <span className={`app-badge app-badge--${variant}`}>
              {VARIANT_LABELS[variant]}
            </span>
            <span className={`app-badge app-badge--${source}`}>
              {t('visibility.' + source)}
            </span>
          </div>
        </div>
      </div>

      {description && (
        <div className="app-card__description">{description}</div>
      )}

      {tags && tags.length > 0 && (
        <div className="app-card__tags">
          {tags.map((tag, i) => (
            <span key={`${tag}-${i}`} className="app-card__tag">{tag}</span>
          ))}
        </div>
      )}

      {extra}

      <div className="app-card__actions">
        {onToggleEnabled && isOwner && (
          <NcCheckbox
            className="app-card__toggle"
            checked={enabled !== false}
            onChange={onToggleEnabled}
            label={enabled !== false ? t('status.enabled') : t('status.disabled')}
          />
        )}

        {onInstall && !installed && (
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={onInstall}
            disabled={installing}
          >
            {installing ? t('action.installing') : t('action.install')}
          </button>
        )}

        {installed && (
          <span className="app-badge app-badge--installed">{t('status.installed')}</span>
        )}

        {isOwner && (
          <div className="app-card__owner-actions">
            {onToggleVisibility && (
              <button
                type="button"
                className="btn-outline btn-xs"
                onClick={onToggleVisibility}
                title={source === 'shared' ? t('action.setPrivate') : t('action.share')}
              >
                {source === 'shared' ? t('action.unshare') : t('action.shareBtn')}
              </button>
            )}
            {onEdit && (
              <button
                type="button"
                className="btn-outline btn-xs"
                onClick={onEdit}
              >
                {t('action.edit')}
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                className="btn-outline btn-xs btn-danger"
                onClick={onDelete}
              >
                {t('action.delete')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
