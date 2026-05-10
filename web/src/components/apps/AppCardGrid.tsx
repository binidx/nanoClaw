import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface AppCardGridProps {
  children: ReactNode;
  empty?: string;
  loading?: boolean;
}

export function AppCardGrid({ children, empty, loading }: AppCardGridProps) {
  const { t } = useTranslation('apps');
  if (loading) {
    return <div className="app-card-grid app-card-grid--loading">{t('common.loading')}</div>;
  }

  const hasChildren =
    Array.isArray(children)
      ? children.some(Boolean)
      : Boolean(children);

  if (!hasChildren && empty) {
    return <div className="app-card-grid app-card-grid--empty">{empty}</div>;
  }

  return <div className="app-card-grid">{children}</div>;
}
