import type { ReactNode } from 'react';

export interface RepoReviewModalShellProps {
  title: ReactNode;
  subtitle?: ReactNode;
  closeAriaLabel: string;
  className: string;
  onClose: () => void;
  children: ReactNode;
}

export function RepoReviewModalShell({
  title,
  subtitle,
  closeAriaLabel,
  className,
  onClose,
  children,
}: RepoReviewModalShellProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal ${className}`} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>{title}</h3>
            {subtitle ? <div className="settings-hint">{subtitle}</div> : null}
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label={closeAriaLabel}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
