import React from 'react';

export type NcSelectSurface = 'default' | 'strong' | 'ghost';
export type NcSelectSize = 'default' | 'sm' | 'lg';

export interface NcSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  surface?: NcSelectSurface;
  uiSize?: NcSelectSize;
}

export const NcSelect = React.forwardRef<HTMLSelectElement, NcSelectProps>(
  (
    { className = '', children, surface = 'default', uiSize = 'default', ...rest },
    ref,
  ) => {
    const cls = [
      'nc-select',
      `nc-select-surface-${surface}`,
      uiSize !== 'default' ? `nc-select-${uiSize}` : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <select ref={ref} className={cls} {...rest}>
        {children}
      </select>
    );
  },
);
NcSelect.displayName = 'NcSelect';
