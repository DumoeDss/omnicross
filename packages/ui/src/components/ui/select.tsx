/**
 * Select - Custom styled select component
 *
 * A dropdown select component that matches the project's design system.
 * Uses Portal rendering to avoid overflow clipping by parent containers.
 */
import { Check,ChevronDown, Search } from 'lucide-react';
import * as React from 'react';
import { useCallback,useEffect,useMemo,useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/shared/utils/utils';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

// Props for new API (with options array)
export interface SelectPropsNew {
  /** Current value */
  value: string;
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Options to display */
  options: SelectOption[];
  /** Placeholder when no value selected */
  placeholder?: string;
  /** Whether the select is disabled */
  disabled?: boolean;
  /** Additional class name for the trigger button */
  className?: string;
  /** ID for the select (for labels) */
  id?: string;
  /** Size variant */
  size?: 'sm' | 'default';
  children?: never;
}

// Props for legacy API (with children)
export interface SelectPropsLegacy {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
  // These props should not exist in legacy mode
  onChange?: never;
  options?: never;
  placeholder?: never;
  className?: never;
  id?: never;
  size?: never;
}

export type SelectProps = SelectPropsNew | SelectPropsLegacy;

/** Calculate fixed position for portal dropdown based on trigger rect */
function calcDropdownPosition(triggerEl: HTMLElement, dropdownHeight: number) {
  const rect = triggerEl.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const flipUp = spaceBelow < dropdownHeight && rect.top > spaceBelow;

  return {
    left: rect.left,
    width: rect.width,
    flipUp,
    ...(flipUp
      ? { bottom: window.innerHeight - rect.top + 4 }
      : { top: rect.bottom + 4 }),
  } as React.CSSProperties & { flipUp: boolean };
}

/**
 * Select component - supports both new API (with options) and legacy API (with children)
 */
export function Select(props: SelectProps) {
  // Check if using legacy API (has children)
  const isLegacyAPI = 'children' in props && props.children;

  if (isLegacyAPI) {
    const legacyProps = props as SelectPropsLegacy;
    return <SelectRoot {...legacyProps} />;
  }

  // Using new API (has options) - render through a separate component
  return <SelectNew {...(props as SelectPropsNew)} />;
}

/**
 * SelectNew - Internal component for new API (with options)
 */
function SelectNew({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  disabled = false,
  className,
  id,
  size = 'default'
}: SelectPropsNew) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [posStyle, setPosStyle] = useState<React.CSSProperties>({});

  // Calculate position when opening
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const h = Math.min(options.length * 36 + 16, 272);
      const { flipUp: _, ...style } = calcDropdownPosition(triggerRef.current, h);
      setPosStyle(style);
    }
  }, [isOpen, options.length]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        (!triggerRef.current || !triggerRef.current.contains(t)) &&
        (!dropdownRef.current || !dropdownRef.current.contains(t))
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen]);

  const selectedOption = options.find(opt => opt.value === value);

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        id={id}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          'flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-1 text-sm text-foreground transition-colors',
          'hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-primary/50',
          disabled && 'opacity-50 cursor-not-allowed',
          size === 'sm' ? 'h-8 px-2 py-1' : 'h-9 px-3 py-2',
          className
        )}
      >
        <span className={cn('truncate', !selectedOption && 'text-muted-foreground')}>
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDown className={cn(
          'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
          isOpen && 'rotate-180'
        )} />
      </button>

      {isOpen ? createPortal(
        <>
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- Backdrop overlay — closes the popover/modal on click; not a focusable button surface. */}
          <div className="fixed inset-0 z-[60] pointer-events-auto" onClick={() => setIsOpen(false)} />
          <div
            ref={dropdownRef}
            className="fixed z-[70] pointer-events-auto bg-popover wallpaper-panel border border-border rounded-lg shadow-lg overflow-hidden"
            style={posStyle}
          >
            <div className="max-h-64 overflow-y-auto py-1">
              {options.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground text-center">
                  No options
                </div>
              ) : (
                options.map((option) => {
                  const isSelected = option.value === value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => !option.disabled && handleSelect(option.value)}
                      disabled={option.disabled}
                      className={cn(
                        'w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition-colors',
                        isSelected ? 'bg-primary/10 text-foreground' : 'text-foreground hover:bg-surface-2',
                        option.disabled && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <span className="truncate">{option.label}</span>
                      {isSelected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>,
        document.body
      ) : null}
    </div>
  );
}

/**
 * SelectWithGroups - A select with grouped options
 */
export interface SelectGroupOption {
  label: string;
  options: SelectOption[];
}

export interface SelectWithGroupsProps extends Omit<SelectPropsNew, 'options'> {
  /** Grouped options */
  groups: SelectGroupOption[];
  /** When true, renders a search input at the top of the dropdown that
   *  filters options by `label` (case-insensitive). Groups with zero
   *  matches are hidden; empty results show `emptyMessage`. */
  searchable?: boolean;
  /** Placeholder for the search input. Defaults to "Search...". */
  searchPlaceholder?: string;
  /** Message shown when search yields zero matches. Defaults to "No matches". */
  emptyMessage?: string;
}

export function SelectWithGroups({
  value,
  onChange,
  groups,
  placeholder = 'Select...',
  disabled = false,
  className,
  id,
  size = 'default',
  searchable = false,
  searchPlaceholder = 'Search...',
  emptyMessage = 'No matches'
}: SelectWithGroupsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [posStyle, setPosStyle] = useState<React.CSSProperties>({});

  // Filter groups by search query when searchable. Done up-front so the
  // height calc + render path both operate on the same filtered list.
  const filteredGroups = useMemo<SelectGroupOption[]>(() => {
    if (!searchable) return groups;
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return groups;
    const result: SelectGroupOption[] = [];
    for (const group of groups) {
      const matching = group.options.filter((opt) =>
        opt.label.toLowerCase().includes(trimmed)
      );
      if (matching.length > 0) {
        result.push({ label: group.label, options: matching });
      }
    }
    return result;
  }, [groups, query, searchable]);

  const totalOptions = filteredGroups.reduce((sum, g) => sum + g.options.length, 0);

  // Calculate position when opening
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const searchH = searchable ? 44 : 0;
      const h = Math.min(totalOptions * 36 + filteredGroups.length * 28 + 16 + searchH, 272 + searchH);
      const { flipUp: _, ...style } = calcDropdownPosition(triggerRef.current, h);
      setPosStyle(style);
    }
  }, [isOpen, totalOptions, filteredGroups.length, searchable]);

  // Single close helper bundles the query reset so we never leave stale
  // search state behind on close — keeps the next open starting fresh
  // without resorting to setState-in-effect.
  const close = useCallback(() => {
    setIsOpen(false);
    setQuery('');
  }, []);

  // Autofocus the search input shortly after the dropdown opens. rAF gives
  // the portal a tick to mount before we try to focus.
  useEffect(() => {
    if (!isOpen || !searchable) return;
    const id = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [isOpen, searchable]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        (!triggerRef.current || !triggerRef.current.contains(t)) &&
        (!dropdownRef.current || !dropdownRef.current.contains(t))
      ) {
        close();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, close]);

  // Find selected option from the ORIGINAL groups so the trigger label stays
  // correct even when the search query hides the selected option.
  let selectedOption: SelectOption | undefined;
  for (const group of groups) {
    selectedOption = group.options.find(opt => opt.value === value);
    if (selectedOption) break;
  }

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    close();
  };

  // Enter on the search input picks the first match — fast keyboard flow.
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const first = filteredGroups[0]?.options.find((opt) => !opt.disabled);
      if (first) {
        e.preventDefault();
        handleSelect(first.value);
      }
    } else if (e.key === 'Escape') {
      close();
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        id={id}
        onClick={() => !disabled && (isOpen ? close() : setIsOpen(true))}
        disabled={disabled}
        className={cn(
          'flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-1 text-sm text-foreground transition-colors',
          'hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-primary/50',
          disabled && 'opacity-50 cursor-not-allowed',
          size === 'sm' ? 'h-8 px-2 py-1' : 'h-9 px-3 py-2',
          className
        )}
      >
        <span className={cn('truncate', !selectedOption && 'text-muted-foreground')}>
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDown className={cn(
          'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
          isOpen && 'rotate-180'
        )} />
      </button>

      {isOpen ? createPortal(
        <>
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- Backdrop overlay — closes the popover/modal on click; not a focusable button surface. */}
          <div className="fixed inset-0 z-[60] pointer-events-auto" onClick={close} />
          <div
            ref={dropdownRef}
            className="fixed z-[70] pointer-events-auto bg-popover wallpaper-panel border border-border rounded-lg shadow-lg overflow-hidden flex flex-col"
            style={posStyle}
          >
            {searchable ? (
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={searchPlaceholder}
                  className="flex-1 min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                />
              </div>
            ) : null}
            <div className="max-h-64 overflow-y-auto py-1">
              {filteredGroups.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                  {emptyMessage}
                </div>
              ) : (
                filteredGroups.map((group, groupIndex) => (
                  <div key={group.label}>
                    {groupIndex > 0 && <div className="h-px bg-border my-1" />}
                    <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase">
                      {group.label}
                    </div>
                    {group.options.map((option) => {
                      const isSelected = option.value === value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => !option.disabled && handleSelect(option.value)}
                          disabled={option.disabled}
                          className={cn(
                            'w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition-colors',
                            isSelected ? 'bg-primary/10 text-foreground' : 'text-foreground hover:bg-surface-2',
                            option.disabled && 'opacity-50 cursor-not-allowed'
                          )}
                        >
                          <span className="truncate">{option.label}</span>
                          {isSelected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        </>,
        document.body
      ) : null}
    </div>
  );
}

export default Select;

// ============================================================================
// Legacy API Support (Context-based API for backward compatibility)
// ============================================================================

interface SelectContextValue {
  value: string;
  onValueChange: (value: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  disabled: boolean;
  triggerEl: HTMLButtonElement | null;
  setTriggerEl: (el: HTMLButtonElement | null) => void;
}

// TODO(zustand-migration): bucket=slot-pattern — keep; primitive compound-component internal (Select.Root provides to Select.Trigger/Content/Item subtrees). Zustand would force a global identity per Select instance.
 
const SelectContext = React.createContext<SelectContextValue | null>(null);

interface LegacySelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}

/**
 * SelectRoot - Context-based Select for legacy API
 * Use this when you need SelectTrigger, SelectContent, SelectItem pattern
 */
export function SelectRoot({ value, defaultValue, onValueChange, disabled = false, children }: LegacySelectProps) {
  const [internalValue, setInternalValue] = useState(defaultValue || '');
  const [open, setOpen] = useState(false);
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null);

  const currentValue = value !== undefined ? value : internalValue;
  const handleValueChange = useCallback((newValue: string) => {
    if (disabled) return;
    if (value === undefined) {
      setInternalValue(newValue);
    }
    onValueChange?.(newValue);
  }, [disabled, value, onValueChange]);

  const handleSetOpen = useCallback((v: boolean) => {
    if (!disabled) setOpen(v);
  }, [disabled]);

  return (
    <SelectContext.Provider
      value={{
        value: currentValue,
        onValueChange: handleValueChange,
        open: disabled ? false : open,
        setOpen: handleSetOpen,
        disabled,
        triggerEl,
        setTriggerEl
      }}
    >
      <div className={cn('relative', disabled && 'opacity-50 cursor-not-allowed')}>{children}</div>
    </SelectContext.Provider>
  );
}

interface SelectTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children?: React.ReactNode;
}

export const SelectTrigger = React.forwardRef<HTMLButtonElement, SelectTriggerProps>(
  ({ className, children, disabled, ...props }, ref) => {
    const context = React.useContext(SelectContext);
    if (!context) throw new Error('SelectTrigger must be used within Select');

    const isDisabled = disabled || context.disabled;
    const { setTriggerEl } = context;

    // Merge refs: forward ref + context trigger element setter
    const mergedRef = useCallback((node: HTMLButtonElement | null) => {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLButtonElement | null>).current = node;
      setTriggerEl(node);
    }, [ref, setTriggerEl]);

    return (
      <button
        ref={mergedRef}
        type="button"
        disabled={isDisabled}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-foreground transition-colors',
          'hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-primary/50',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        onClick={() => !isDisabled && context.setOpen(!context.open)}
        {...props}
      >
        {children}
        <ChevronDown className={cn(
          'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
          context.open && 'rotate-180'
        )} />
      </button>
    );
  }
);
SelectTrigger.displayName = 'SelectTrigger';

interface SelectValueProps {
  placeholder?: string;
}

export function SelectValue({ placeholder }: SelectValueProps) {
  const context = React.useContext(SelectContext);
  if (!context) throw new Error('SelectValue must be used within Select');

  return (
    <span className={cn('truncate', !context.value && 'text-muted-foreground')}>
      {context.value || placeholder}
    </span>
  );
}

interface SelectContentProps {
  children: React.ReactNode;
  className?: string;
}

export function SelectContent({ children, className }: SelectContentProps) {
  const context = React.useContext(SelectContext);
  const dropdownRef = useRef<HTMLDivElement>(null);

  if (!context) throw new Error('SelectContent must be used within Select');

  // Calculate position from trigger element (derived state, no effect needed)
  const posStyle = useMemo<React.CSSProperties>(() => {
    if (context.open && context.triggerEl) {
      const { flipUp: _, ...style } = calcDropdownPosition(context.triggerEl, 272);
      return style;
    }
    return {};
  }, [context.open, context.triggerEl]);

  // Close on click outside
  useEffect(() => {
    if (!context.open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        (!context.triggerEl || !context.triggerEl.contains(t)) &&
        (!dropdownRef.current || !dropdownRef.current.contains(t))
      ) {
        context.setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [context.open, context.triggerEl, context.setOpen]);

  // Close on escape
  useEffect(() => {
    if (!context.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') context.setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [context.open, context.setOpen]);

  if (!context.open) return null;

  return createPortal(
    <>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- Backdrop overlay — closes the popover/modal on click; not a focusable button surface. */}
      <div className="fixed inset-0 z-[60] pointer-events-auto" onClick={() => context.setOpen(false)} />
      <div
        ref={dropdownRef}
        className={cn(
          'fixed z-[70] pointer-events-auto max-h-64 overflow-auto rounded-lg border border-border bg-popover wallpaper-panel shadow-lg',
          className
        )}
        style={posStyle}
      >
        <div className="py-1">
          {children}
        </div>
      </div>
    </>,
    document.body
  );
}

interface SelectItemProps {
  value: string;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function SelectItem({ value, disabled, children, className }: SelectItemProps) {
  const context = React.useContext(SelectContext);
  if (!context) throw new Error('SelectItem must be used within Select');

  const isSelected = context.value === value;

  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition-colors',
        isSelected ? 'bg-primary/10 text-foreground' : 'text-foreground hover:bg-surface-2',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
      onClick={() => {
        if (!disabled) {
          context.onValueChange(value);
          context.setOpen(false);
        }
      }}
    >
      <span className="truncate">{children}</span>
      {isSelected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
    </button>
  );
}

interface SelectGroupProps {
  children: React.ReactNode;
}

export function SelectGroup({ children }: SelectGroupProps) {
  return <div>{children}</div>;
}

interface SelectLabelProps {
  children: React.ReactNode;
  className?: string;
}

export function SelectLabel({ children, className }: SelectLabelProps) {
  return (
    <div className={cn('px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase', className)}>
      {children}
    </div>
  );
}

export function SelectSeparator() {
  return <div className="h-px bg-border my-1" />;
}
