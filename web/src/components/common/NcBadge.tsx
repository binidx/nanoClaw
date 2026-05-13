import React from 'react';

export type NcBadgeTone =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger';
export type NcBadgeVariant = 'subtle' | 'solid';

export interface NcBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: NcBadgeTone;
  variant?: NcBadgeVariant;
}

export function NcBadge({
  tone = 'neutral',
  variant = 'subtle',
  className = '',
  children,
  ...rest
}: NcBadgeProps) {
  const cls = ['nc-badge', `nc-badge-${tone}`, `nc-badge-${variant}`, className]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}
