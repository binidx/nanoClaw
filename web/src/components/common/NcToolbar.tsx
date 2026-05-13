import React from 'react';

export interface NcToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'center' | 'between';
}

export function NcToolbar({
  align = 'between',
  className = '',
  children,
  ...rest
}: NcToolbarProps) {
  const cls = ['nc-toolbar', `nc-toolbar-${align}`, className]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
