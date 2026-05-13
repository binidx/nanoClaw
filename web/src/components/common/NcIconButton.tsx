import React from 'react';

export type NcIconButtonVariant = 'outline' | 'glass' | 'ghost' | 'toolbar';
export type NcIconButtonSize = 'sm' | 'md' | 'lg';

export interface NcIconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: NcIconButtonVariant;
  size?: NcIconButtonSize;
}

export const NcIconButton = React.forwardRef<HTMLButtonElement, NcIconButtonProps>(
  ({ variant = 'glass', size = 'md', className = '', children, ...rest }, ref) => {
    const cls = [
      'nc-icon-button',
      `nc-icon-button-${variant}`,
      `nc-icon-button-${size}`,
      className,
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <button ref={ref} className={cls} type="button" {...rest}>
        {children}
      </button>
    );
  },
);
NcIconButton.displayName = 'NcIconButton';
