import React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'warning' | 'success';
export type ButtonSize = 'default' | 'sm';

export interface NcButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const NcButton = React.forwardRef<HTMLButtonElement, NcButtonProps>(
  ({ variant = 'outline', size, className = '', children, ...rest }, ref) => {
    const cls = [
      `btn-${variant}`,
      size === 'sm' ? 'btn-sm' : '',
      className,
    ].filter(Boolean).join(' ');

    return (
      <button ref={ref} className={cls} {...rest}>
        {children}
      </button>
    );
  },
);
NcButton.displayName = 'NcButton';
