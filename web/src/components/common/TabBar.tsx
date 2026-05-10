import React, { useCallback, useRef } from 'react';

export interface Tab {
  key: string;
  label: string;
  badge?: number | string;
  disabled?: boolean;
}

export interface TabBarProps {
  tabs: Tab[];
  activeKey: string;
  onChange: (key: string) => void;
  size?: 'default' | 'small';
}

export function TabBar({ tabs, activeKey, onChange, size = 'default' }: TabBarProps) {
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      const enabledIndices = tabs
        .map((t, i) => (t.disabled ? -1 : i))
        .filter(i => i >= 0);
      const currentPos = enabledIndices.indexOf(index);
      let nextIndex = -1;

      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          nextIndex = enabledIndices[(currentPos + 1) % enabledIndices.length];
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          nextIndex = enabledIndices[(currentPos - 1 + enabledIndices.length) % enabledIndices.length];
          break;
        case 'Home':
          e.preventDefault();
          nextIndex = enabledIndices[0];
          break;
        case 'End':
          e.preventDefault();
          nextIndex = enabledIndices[enabledIndices.length - 1];
          break;
        default:
          return;
      }

      if (nextIndex >= 0) {
        tabsRef.current[nextIndex]?.focus();
        onChange(tabs[nextIndex].key);
      }
    },
    [tabs, onChange]
  );

  return (
    <div className={`nc-tab-bar${size === 'small' ? ' nc-tab-bar-sm' : ''}`} role="tablist">
      {tabs.map((tab, i) => (
        <button
          key={tab.key}
          ref={el => {
            tabsRef.current[i] = el;
          }}
          role="tab"
          aria-selected={tab.key === activeKey}
          tabIndex={tab.key === activeKey ? 0 : -1}
          className={`nc-tab${tab.key === activeKey ? ' nc-tab-active' : ''}${tab.disabled ? ' nc-tab-disabled' : ''}`}
          onClick={() => !tab.disabled && onChange(tab.key)}
          onKeyDown={e => handleKeyDown(e, i)}
          disabled={tab.disabled}
        >
          {tab.label}
          {tab.badge !== undefined && <span className="nc-tab-badge">{tab.badge}</span>}
        </button>
      ))}
    </div>
  );
}
