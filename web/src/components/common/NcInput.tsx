import React from 'react';

export type NcInputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const NcInput = React.forwardRef<HTMLInputElement, NcInputProps>(
  ({ className = '', ...rest }, ref) => {
    return (
      <input ref={ref} className={`nc-input ${className}`.trim()} {...rest} />
    );
  },
);
NcInput.displayName = 'NcInput';
