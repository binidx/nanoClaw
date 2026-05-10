import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { IconCheck, IconChevronDown } from './AppIcons';

export interface AppSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface AppSelectProps {
  value: string;
  options: AppSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  ariaLabel?: string;
  menuMatchTrigger?: boolean;
  iconOnly?: boolean;
  triggerIcon?: ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
}

function joinClassNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export function AppSelect(props: AppSelectProps) {
  return (
    <AppSelectInner key={props.disabled ? 'disabled' : 'enabled'} {...props} />
  );
}

function AppSelectInner({
  value,
  options,
  onChange,
  placeholder: placeholderProp,
  disabled = false,
  compact = false,
  className,
  ariaLabel,
  menuMatchTrigger = false,
  iconOnly = false,
  triggerIcon,
  searchable = false,
  searchPlaceholder: searchPlaceholderProp,
  searchAriaLabel,
}: AppSelectProps) {
  const { t } = useTranslation('common');
  const placeholder = placeholderProp ?? t('select.placeholder');
  const searchPlaceholder = searchPlaceholderProp ?? t('select.searchPlaceholder');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [openUpward, setOpenUpward] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [searchQuery, setSearchQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
  const displayLabel = selectedOption?.label || placeholder;
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredOptions = useMemo(() => {
    if (!searchable || !normalizedSearchQuery) {
      return options;
    }
    return options.filter((option) => {
      const haystack = `${option.label} ${option.value}`.toLowerCase();
      return haystack.includes(normalizedSearchQuery);
    });
  }, [normalizedSearchQuery, options, searchable]);
  const filteredSelectedIndex = filteredOptions.findIndex(
    (option) => option.value === value,
  );

  const firstEnabledIndex = useMemo(
    () => filteredOptions.findIndex((option) => !option.disabled),
    [filteredOptions],
  );

  const getNextEnabledIndex = useCallback(
    (startIndex: number, direction: 1 | -1) => {
      if (filteredOptions.length === 0) return -1;
      let index = startIndex;
      for (let visited = 0; visited < filteredOptions.length; visited += 1) {
        index =
          (index + direction + filteredOptions.length) % filteredOptions.length;
        if (!filteredOptions[index]?.disabled) return index;
      }
      return -1;
    },
    [filteredOptions],
  );

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    setActiveIndex(-1);
    setSearchQuery('');
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const updateMenuPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const estimatedMenuHeight = Math.min(
      Math.max(filteredOptions.length, 1) * 40 + (searchable ? 64 : 16),
      240,
    );
    const shouldOpenUpward =
      window.innerHeight - rect.bottom < estimatedMenuHeight + 12 &&
      rect.top > estimatedMenuHeight;
    const viewportPadding = 8;
    const maxMenuWidth = Math.max(200, window.innerWidth - viewportPadding * 2);
    const longestOptionLength = filteredOptions.reduce(
      (max, option) => Math.max(max, option.label.length),
      0,
    );
    const estimatedLabelWidth = longestOptionLength * 8 + 84;
    const preferredWidth = Math.min(
      420,
      Math.max(rect.width, estimatedLabelWidth),
    );
    const menuWidth = menuMatchTrigger
      ? rect.width
      : Math.min(maxMenuWidth, preferredWidth);
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(
        viewportPadding,
        window.innerWidth - menuWidth - viewportPadding,
      ),
    );

    setOpenUpward(shouldOpenUpward);
    setMenuStyle({
      position: 'fixed',
      left,
      width: menuWidth,
      top: shouldOpenUpward ? undefined : rect.bottom + 8,
      bottom: shouldOpenUpward ? window.innerHeight - rect.top + 8 : undefined,
    });
  }, [filteredOptions, menuMatchTrigger, searchable]);

  const openMenu = useCallback(
    (preferredIndex?: number) => {
      if (disabled) return;
      setSearchQuery('');
      const nextIndex =
        preferredIndex !== undefined && preferredIndex >= 0
          ? preferredIndex
          : filteredSelectedIndex >= 0 && !filteredOptions[filteredSelectedIndex]?.disabled
            ? filteredSelectedIndex
            : firstEnabledIndex;
      updateMenuPosition();
      setOpen(true);
      setActiveIndex(nextIndex);
    },
    [
      disabled,
      filteredOptions,
      filteredSelectedIndex,
      firstEnabledIndex,
      updateMenuPosition,
    ],
  );

  const commitSelection = useCallback(
    (nextValue: string) => {
      onChange(nextValue);
      closeMenu(true);
    },
    [closeMenu, onChange],
  );

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        closeMenu(false);
      }
    };

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
      }
    };

    const syncMenuPosition = () => {
      window.requestAnimationFrame(updateMenuPosition);
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleWindowKeyDown);
    window.addEventListener('resize', syncMenuPosition);
    window.addEventListener('scroll', syncMenuPosition, true);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleWindowKeyDown);
      window.removeEventListener('resize', syncMenuPosition);
      window.removeEventListener('scroll', syncMenuPosition, true);
    };
  }, [closeMenu, open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return undefined;
    const frameId = window.requestAnimationFrame(() => {
      updateMenuPosition();
      if (searchable) {
        searchInputRef.current?.focus();
        return;
      }
      if (activeIndex >= 0) {
        optionRefs.current[activeIndex]?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [activeIndex, open, searchable, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    if (filteredSelectedIndex >= 0 && !filteredOptions[filteredSelectedIndex]?.disabled) {
      setActiveIndex(filteredSelectedIndex);
      return;
    }
    setActiveIndex(firstEnabledIndex);
  }, [filteredOptions, filteredSelectedIndex, firstEnabledIndex, open]);

  const handleTriggerKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (disabled) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu(
        selectedIndex >= 0
          ? getNextEnabledIndex(selectedIndex - 1, 1)
          : firstEnabledIndex,
      );
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const seedIndex = selectedIndex >= 0 ? selectedIndex + 1 : 0;
      openMenu(getNextEnabledIndex(seedIndex, -1));
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMenu();
    }
  };

  const handleOptionKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIndex = getNextEnabledIndex(index, 1);
      if (nextIndex >= 0) setActiveIndex(nextIndex);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const nextIndex = getNextEnabledIndex(index, -1);
      if (nextIndex >= 0) setActiveIndex(nextIndex);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      if (firstEnabledIndex >= 0) setActiveIndex(firstEnabledIndex);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      const lastEnabledIndex = [...filteredOptions]
        .reverse()
        .findIndex((option) => !option.disabled);
      if (lastEnabledIndex >= 0) {
        setActiveIndex(filteredOptions.length - 1 - lastEnabledIndex);
      }
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!filteredOptions[index]?.disabled) {
        commitSelection(filteredOptions[index]!.value);
      }
      return;
    }

    if (event.key === 'Tab') {
      closeMenu(false);
    }
  };

  const handleSearchKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIndex = activeIndex >= 0 ? getNextEnabledIndex(activeIndex, 1) : firstEnabledIndex;
      if (nextIndex >= 0) {
        setActiveIndex(nextIndex);
        window.requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus());
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const seedIndex =
        activeIndex >= 0 ? activeIndex : filteredOptions.length;
      const nextIndex = getNextEnabledIndex(seedIndex, -1);
      if (nextIndex >= 0) {
        setActiveIndex(nextIndex);
        window.requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus());
      }
      return;
    }

    if (event.key === 'Enter' && activeIndex >= 0 && !filteredOptions[activeIndex]?.disabled) {
      event.preventDefault();
      commitSelection(filteredOptions[activeIndex]!.value);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
    }
  };

  return (
    <div
      ref={rootRef}
      className={joinClassNames(
        'app-select',
        compact && 'compact',
        compact && 'app-select-compact',
        open && 'is-open',
        disabled && 'is-disabled',
        className,
      )}
    >
      <button
        ref={triggerRef}
        type="button"
        className={joinClassNames(
          'app-select-trigger',
          iconOnly && 'icon-only',
        )}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        title={displayLabel}
        disabled={disabled}
      >
        {!iconOnly ? (
          <span
            className={joinClassNames(
              'app-select-value',
              !selectedOption && 'is-placeholder',
            )}
          >
            {displayLabel}
          </span>
        ) : null}
        <span className="app-select-icon" aria-hidden="true">
          {triggerIcon ?? <IconChevronDown />}
        </span>
      </button>

      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={listboxId}
              style={menuStyle}
              className={joinClassNames(
                'app-select-menu',
                openUpward && 'open-upward',
              )}
              role="listbox"
              aria-label={ariaLabel}
            >
              {searchable ? (
                <div className="app-select-search">
                  <input
                    ref={searchInputRef}
                    type="text"
                    className="app-select-search-input"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder={searchPlaceholder}
                    aria-label={searchAriaLabel || t('select.searchAriaLabelFor', { label: ariaLabel || placeholder })}
                  />
                </div>
              ) : null}
              {filteredOptions.length === 0 ? (
                <div className="app-select-empty">{t('select.noMatch')}</div>
              ) : null}
              {filteredOptions.map((option, index) => {
                const isSelected = option.value === value;
                const isActive = index === activeIndex;
                return (
                  <button
                    key={`${option.value}-${index}`}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    type="button"
                    className={joinClassNames(
                      'app-select-option',
                      isSelected && 'is-selected',
                      isActive && 'is-active',
                    )}
                    onClick={() =>
                      !option.disabled && commitSelection(option.value)
                    }
                    onKeyDown={(event) => handleOptionKeyDown(event, index)}
                    onMouseEnter={() => setActiveIndex(index)}
                    role="option"
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    tabIndex={isActive ? 0 : -1}
                  >
                    <span className="app-select-option-label">
                      {option.label}
                    </span>
                    <span
                      className="app-select-option-check"
                      aria-hidden="true"
                    >
                      {isSelected ? <IconCheck /> : null}
                    </span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
