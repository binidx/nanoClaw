import React from 'react';

export type NcInputSurface = 'default' | 'strong' | 'ghost';
export type NcInputSize = 'default' | 'sm' | 'lg';

export interface NcInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  surface?: NcInputSurface;
  uiSize?: NcInputSize;
}

export const NcInput = React.forwardRef<HTMLInputElement, NcInputProps>(
  ({ className = '', surface = 'default', uiSize = 'default', ...rest }, ref) => {
    const cls = [
      'nc-input',
      `nc-input-surface-${surface}`,
      uiSize !== 'default' ? `nc-input-${uiSize}` : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');
    return <input ref={ref} className={cls} {...rest} />;
  },
);
NcInput.displayName = 'NcInput';
