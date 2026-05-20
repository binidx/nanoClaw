import React, { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  width?: number | string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function Drawer({ open, onClose, title, width = 560, children, footer }: DrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const previousBodyOverflowRef = useRef<string | null>(null);
  const previousBodyPaddingRightRef = useRef<string | null>(null);
  const { t } = useTranslation('common');

  // Save + restore focus
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      previousBodyOverflowRef.current = document.body.style.overflow;
      previousBodyPaddingRightRef.current = document.body.style.paddingRight;
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = 'hidden';
      if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`;
      }
      // Focus the drawer itself or first focusable after mount
      requestAnimationFrame(() => {
        const el = drawerRef.current;
        if (!el) return;
        const firstFocusable = el.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        (firstFocusable || el).focus();
      });
    } else if (previousFocusRef.current) {
      previousFocusRef.current.focus();
      previousFocusRef.current = null;
    }

    return () => {
      document.body.style.overflow = previousBodyOverflowRef.current || '';
      document.body.style.paddingRight =
        previousBodyPaddingRightRef.current || '';
    };
  }, [open]);

  // Focus trap + Escape
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const el = drawerRef.current;
      if (!el) return;
      const focusables = el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  if (!open) return null;

  const titleId = title !== undefined ? 'nc-drawer-title' : undefined;

  return (
    <div className="nc-drawer-overlay" onClick={onClose}>
      <div
        ref={drawerRef}
        className="nc-drawer nc-drawer-content"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ width: typeof width === 'number' ? `${width}px` : width }}
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {title !== undefined && (
          <div className="nc-drawer-header">
            <div className="nc-drawer-title" id={titleId}>
              {title}
            </div>
            <button className="modal-close-btn" onClick={onClose} aria-label={t('common.drawer.close')}>
              ×
            </button>
          </div>
        )}
        <div className="nc-drawer-body">{children}</div>
        {footer && <div className="nc-drawer-footer">{footer}</div>}
      </div>
    </div>
  );
}
