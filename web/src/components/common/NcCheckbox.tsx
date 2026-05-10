import React from 'react';

export interface NcCheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: React.ReactNode;
}

export const NcCheckbox = React.forwardRef<HTMLInputElement, NcCheckboxProps>(
  ({ label, className = '', ...rest }, ref) => {
    return (
      <label className={`nc-checkbox ${className}`.trim()}>
        <input ref={ref} type="checkbox" {...rest} />
        <span className="nc-checkbox-box" />
        {label != null && <span className="nc-checkbox-label">{label}</span>}
      </label>
    );
  },
);
NcCheckbox.displayName = 'NcCheckbox';
