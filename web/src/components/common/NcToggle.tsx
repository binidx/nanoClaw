export interface NcToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
  className?: string;
}

export function NcToggle({
  checked,
  onChange,
  disabled = false,
  label,
  className = '',
}: NcToggleProps) {
  return (
    <label className={`toggle-switch-control ${className}${disabled ? ' disabled' : ''}`.trim()}>
      <span className={`toggle-switch${disabled ? ' disabled' : ''}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="toggle-switch-track" aria-hidden="true">
          <span className="toggle-switch-thumb" />
        </span>
      </span>
      {label != null && <span className="nc-toggle-label">{label}</span>}
    </label>
  );
}
