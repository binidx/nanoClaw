import type { ReactNode } from 'react';

export interface NcFormGroupProps {
  label?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function NcFormGroup({
  label,
  hint,
  children,
  className = '',
}: NcFormGroupProps) {
  return (
    <div className={`nc-form-group ${className}`.trim()}>
      {label && <label className="nc-form-label">{label}</label>}
      {children}
      {hint && <span className="nc-form-hint">{hint}</span>}
    </div>
  );
}
