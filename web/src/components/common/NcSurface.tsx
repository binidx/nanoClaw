import React from 'react';

export type NcSurfaceVariant = 'panel' | 'card' | 'toolbar' | 'sidebar' | 'overlay';
type SurfaceElement = 'div' | 'section' | 'aside' | 'header' | 'main' | 'article';

export interface NcSurfaceProps extends React.HTMLAttributes<HTMLElement> {
  as?: SurfaceElement;
  variant?: NcSurfaceVariant;
  interactive?: boolean;
  selected?: boolean;
  padded?: boolean;
}

export function NcSurface({
  as = 'div',
  variant = 'card',
  interactive = false,
  selected = false,
  padded = true,
  className = '',
  children,
  ...rest
}: NcSurfaceProps) {
  const Tag = as;
  const cls = [
    'nc-surface',
    `nc-surface-${variant}`,
    interactive ? 'is-interactive' : '',
    selected ? 'is-selected' : '',
    padded ? 'is-padded' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Tag className={cls} {...rest}>
      {children}
    </Tag>
  );
}
