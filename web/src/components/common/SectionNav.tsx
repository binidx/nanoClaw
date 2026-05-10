import React, { useCallback, useRef } from 'react';

export interface SectionNavItem {
  key: string;
  label: React.ReactNode;
  badge?: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  tone?: 'default' | 'warning' | 'danger' | 'success';
}

export interface SectionNavProps {
  items: SectionNavItem[];
  activeKey: string;
  onChange: (key: string) => void;
  ariaLabel: string;
  orientation?: 'horizontal' | 'vertical' | 'rail';
  size?: 'default' | 'small';
  className?: string;
}

export function SectionNav({
  items,
  activeKey,
  onChange,
  ariaLabel,
  orientation = 'horizontal',
  size = 'default',
  className = '',
}: SectionNavProps) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent, index: number) => {
      const enabledIndices = items
        .map((item, itemIndex) => (item.disabled ? -1 : itemIndex))
        .filter((itemIndex) => itemIndex >= 0);
      if (enabledIndices.length === 0) return;

      const currentPos = enabledIndices.indexOf(index);
      let nextIndex = -1;

      switch (event.key) {
        case 'ArrowRight':
          if (orientation === 'vertical') return;
          event.preventDefault();
          nextIndex = enabledIndices[(currentPos + 1) % enabledIndices.length];
          break;
        case 'ArrowDown':
          event.preventDefault();
          nextIndex = enabledIndices[(currentPos + 1) % enabledIndices.length];
          break;
        case 'ArrowLeft':
          if (orientation === 'vertical') return;
          event.preventDefault();
          nextIndex = enabledIndices[(currentPos - 1 + enabledIndices.length) % enabledIndices.length];
          break;
        case 'ArrowUp':
          event.preventDefault();
          nextIndex = enabledIndices[(currentPos - 1 + enabledIndices.length) % enabledIndices.length];
          break;
        case 'Home':
          event.preventDefault();
          nextIndex = enabledIndices[0];
          break;
        case 'End':
          event.preventDefault();
          nextIndex = enabledIndices[enabledIndices.length - 1];
          break;
        default:
          return;
      }

      if (nextIndex >= 0) {
        itemRefs.current[nextIndex]?.focus();
        onChange(items[nextIndex].key);
      }
    },
    [items, onChange, orientation],
  );

  return (
    <nav
      className={`nc-section-nav nc-section-nav--${orientation} nc-section-nav--${size} ${className}`.trim()}
      aria-label={ariaLabel}
    >
      <div
        className="nc-section-nav-list"
        role="tablist"
        aria-orientation={orientation === 'horizontal' ? 'horizontal' : 'vertical'}
      >
        {items.map((item, index) => (
          <button
            key={item.key}
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            aria-selected={item.key === activeKey}
            tabIndex={item.key === activeKey ? 0 : -1}
            className={`nc-section-nav-item${item.key === activeKey ? ' is-active' : ''}${item.disabled ? ' is-disabled' : ''}${item.tone && item.tone !== 'default' ? ` tone-${item.tone}` : ''}`}
            onClick={() => {
              if (!item.disabled) onChange(item.key);
            }}
            onKeyDown={(event) => handleKeyDown(event, index)}
            disabled={item.disabled}
          >
            {item.icon ? <span className="nc-section-nav-icon">{item.icon}</span> : null}
            <span className="nc-section-nav-label">{item.label}</span>
            {item.badge !== undefined ? <span className="nc-section-nav-badge">{item.badge}</span> : null}
          </button>
        ))}
      </div>
    </nav>
  );
}
