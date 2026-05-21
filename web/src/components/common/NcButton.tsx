import React from 'react';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'danger'
  | 'warning'
  | 'success'
  | 'ghost'
  | 'glass'
  | 'toolbar';
export type ButtonSize = 'xs' | 'sm' | 'default' | 'lg';
export type ButtonAppearance = 'solid' | 'glass' | 'ghost' | 'toolbar';

export interface NcButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  appearance?: ButtonAppearance;
  iconOnly?: boolean;
  loading?: boolean;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
}

export const NcButton = React.forwardRef<HTMLButtonElement, NcButtonProps>(
  (
    {
      variant = 'outline',
      size = 'default',
      appearance,
      iconOnly = false,
      loading = false,
      leadingIcon,
      trailingIcon,
      type = 'button',
      className = '',
      children,
      disabled,
      ...rest
    },
    ref,
  ) => {
    const resolvedVariant =
      appearance === 'glass'
        ? 'glass'
        : appearance === 'ghost'
          ? 'ghost'
          : appearance === 'toolbar'
            ? 'toolbar'
            : variant;
    const cls = [
      `btn-${resolvedVariant}`,
      size !== 'default' ? `btn-${size}` : '',
      iconOnly ? 'btn-icon-only' : '',
      loading ? 'is-loading' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button ref={ref} type={type} className={cls} disabled={disabled || loading} aria-busy={loading} {...rest}>
        {loading ? <span className="nc-btn-spinner" aria-hidden="true" /> : null}
        {!loading && leadingIcon ? <span className="nc-btn-icon">{leadingIcon}</span> : null}
        {children ? <span className="nc-btn-label">{children}</span> : null}
        {!loading && trailingIcon ? <span className="nc-btn-icon">{trailingIcon}</span> : null}
      </button>
    );
  },
);
NcButton.displayName = 'NcButton';
