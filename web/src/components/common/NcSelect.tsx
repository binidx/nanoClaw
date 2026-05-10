import React from 'react';

export type NcSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export const NcSelect = React.forwardRef<HTMLSelectElement, NcSelectProps>(
  ({ className = '', children, ...rest }, ref) => {
    return (
      <select ref={ref} className={`nc-select ${className}`.trim()} {...rest}>
        {children}
      </select>
    );
  },
);
NcSelect.displayName = 'NcSelect';
