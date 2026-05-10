import React from 'react';
import { useTranslation } from 'react-i18next';
import type { useAuth } from '../hooks/useAuth';

interface PermissionGateProps {
  /** Single permission code, OR array of codes (any one suffices). */
  permission: string | string[];
  /** 'hidden' = don't render at all; 'disabled' = render children but disabled */
  mode?: 'hidden' | 'disabled';
  /** Tooltip text when disabled */
  tooltip?: string;
  /** Auth status to use for permission check */
  auth: ReturnType<typeof useAuth>;
  children: React.ReactNode;
  /** Fallback UI when no permission and mode='hidden' */
  fallback?: React.ReactNode;
}

export function PermissionGate({
  permission,
  mode = 'hidden',
  tooltip,
  auth,
  children,
  fallback = null,
}: PermissionGateProps) {
  const { t } = useTranslation('common');
  const codes = Array.isArray(permission) ? permission : [permission];
  const allowed = codes.some((c) => auth.hasPermission(c));

  if (allowed) {
    return <>{children}</>;
  }

  if (mode === 'disabled') {
    return (
      <fieldset
        disabled
        aria-disabled="true"
        title={tooltip || t('error.permission')}
        style={{ opacity: 0.5, cursor: 'not-allowed', border: 'none', padding: 0, margin: 0 }}
      >
        {children}
      </fieldset>
    );
  }

  return <>{fallback}</>;
}

interface PermissionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  permission: string | string[];
  auth: ReturnType<typeof useAuth>;
  tooltip?: string;
}

export function PermissionButton({
  permission,
  auth,
  tooltip,
  children,
  disabled,
  ...rest
}: PermissionButtonProps) {
  const { t } = useTranslation('common');
  const codes = Array.isArray(permission) ? permission : [permission];
  const allowed = codes.some((c) => auth.hasPermission(c));

  return (
    <button
      {...rest}
      disabled={disabled || !allowed}
      title={!allowed ? (tooltip || t('error.permission')) : rest.title}
    >
      {children}
    </button>
  );
}
