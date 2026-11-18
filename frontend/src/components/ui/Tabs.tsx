// Shared tab strip (A2 components.md C5 / A3 interaction-spec.md IX-18).
//
// Two skins only:
//   nav   — text tab + 2px brand underline (the md–lg top-bar navigation);
//   panel — track + one white sliding thumb (content pages, admin, vocab).
//
// A tablist never owns its panel markup: callers spread `tabPanelProps(...)` on
// the existing panel container. That keeps ids / roles / aria in one contract
// without inserting wrapper divs that would shift the page layout.
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '../../lib/cn';

export interface TabItem {
  id: string;
  label: string;
  /** Rendered only when > 0 (C7: a zero count is not a badge). */
  count?: number | null;
  /** Formatted visual count (e.g. "10,000"); defaults to `count`. */
  countLabel?: string;
  /** Adds the untruncated count to the tab's accessible name. */
  countAriaLabel?: string;
  disabled?: boolean;
  /** Native tooltip explaining a disabled tab. */
  title?: string;
  icon?: ReactNode;
  testId?: string;
  countTestId?: string;
}

export interface TabsProps {
  skin: 'nav' | 'panel';
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Unique per screen; drives the underline / white-thumb layout animation. */
  layoutId: string;
  ariaLabel: string;
  /** Enables `aria-controls` / panel ids. Required when a panel is rendered. */
  idPrefix?: string;
  /** Panel skin only: let items grow to fill a full-width track (admin 375px). */
  fill?: boolean;
  testId?: string;
  className?: string;
}

const SPRING = { type: 'spring' as const, stiffness: 420, damping: 36 };
const COUNT_BASE =
  'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-micro tabular-nums';

export function tabPanelId(idPrefix: string, tabId: string): string {
  return `${idPrefix}-panel-${tabId}`;
}

/**
 * Panel contract for the matching tab. Spread it on the content container:
 * `<section {...tabPanelProps('admin', 'users')}>`.
 */
export function tabPanelProps(idPrefix: string, tabId: string) {
  return {
    role: 'tabpanel' as const,
    id: tabPanelId(idPrefix, tabId),
    'aria-labelledby': `${idPrefix}-tab-${tabId}`,
  };
}

export function Tabs({
  skin,
  items,
  value,
  onChange,
  layoutId,
  ariaLabel,
  idPrefix,
  fill = false,
  testId,
  className,
}: TabsProps) {
  const reducedMotion = useReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const transition = reducedMotion ? { duration: 0 } : SPRING;

  // Keep the selected tab visible in the horizontally scrolling strips
  // (375px vocab/admin); never scroll the page itself.
  useEffect(() => {
    const list = listRef.current;
    const selected = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !selected) return;
    if (list.scrollWidth <= list.clientWidth + 1) return;
    selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const key = event.key;
      if (
        key !== 'ArrowRight' &&
        key !== 'ArrowLeft' &&
        key !== 'ArrowDown' &&
        key !== 'ArrowUp' &&
        key !== 'Home' &&
        key !== 'End'
      ) {
        return;
      }
      const enabled = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !item.disabled);
      if (enabled.length === 0) return;
      event.preventDefault();

      const current = Math.max(
        0,
        enabled.findIndex(({ item }) => item.id === value),
      );
      let next = current;
      if (key === 'ArrowRight' || key === 'ArrowDown') next = (current + 1) % enabled.length;
      else if (key === 'ArrowLeft' || key === 'ArrowUp') {
        next = (current - 1 + enabled.length) % enabled.length;
      } else if (key === 'Home') next = 0;
      else if (key === 'End') next = enabled.length - 1;

      const target = enabled[next];
      if (!target) return;
      onChange(target.item.id);
      tabRefs.current.get(target.item.id)?.focus();
    },
    [items, onChange, value],
  );

  const nav = skin === 'nav';
  const showCount = (item: TabItem) =>
    !item.disabled && item.count != null && item.count > 0;

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      data-testid={testId}
      onKeyDown={onKeyDown}
      className={cn(
        'items-center',
        nav
          ? 'inline-flex min-w-0 gap-1'
          : 'inline-flex max-w-full gap-0.5 rounded-control border border-line-subtle bg-surface-2/80 p-0.5',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.id === value;
        const countText = item.countLabel ?? (item.count != null ? String(item.count) : '');
        return (
          <button
            key={item.id}
            ref={(node) => {
              if (node) tabRefs.current.set(item.id, node);
              else tabRefs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${item.id}` : undefined}
            aria-selected={active}
            aria-controls={
              idPrefix && !item.disabled ? tabPanelId(idPrefix, item.id) : undefined
            }
            aria-disabled={item.disabled || undefined}
            aria-label={
              item.countAriaLabel ? `${item.label}, ${item.countAriaLabel}` : undefined
            }
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            title={item.disabled ? item.title : undefined}
            data-testid={item.testId}
            onClick={() => onChange(item.id)}
            className={cn(
              'relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-control font-medium',
              'transition-colors duration-200 ease-apple',
              '[@media(pointer:coarse)]:min-h-11',
              nav
                ? 'h-9 px-2.5 text-caption md:px-3 md:text-ui'
                : 'h-8 gap-1.5 px-3 text-caption',
              fill && !nav && 'flex-1',
              item.disabled && 'cursor-not-allowed opacity-40',
              nav
                ? active
                  ? 'bg-state-selected text-fg-primary'
                  : 'text-fg-secondary hover:bg-state-hover hover:text-fg-primary'
                : active
                  ? 'text-fg-inverse'
                  : 'text-fg-secondary hover:text-fg-primary',
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                aria-hidden="true"
                transition={transition}
                className={cn(
                  'absolute',
                  nav
                    ? '-bottom-[13px] left-2 right-2 h-0.5 rounded-full bg-brand'
                    : 'inset-0 rounded-control bg-control',
                )}
              />
            )}
            <span className="relative z-raised inline-flex min-w-0 items-center gap-1.5">
              {item.icon}
              <span className="truncate">{item.label}</span>
              {showCount(item) && !nav && (
                <span
                  data-testid={item.countTestId}
                  className={cn(
                    COUNT_BASE,
                    active
                      ? 'bg-fg-inverse/10 text-fg-muted'
                      : 'bg-surface-2/60 text-fg-secondary',
                  )}
                >
                  {countText}
                </span>
              )}
            </span>
            {showCount(item) && nav && (
              <span
                data-testid={item.countTestId}
                className={cn(
                  COUNT_BASE,
                  'absolute -right-1 -top-1 bg-brand font-semibold text-fg-primary',
                )}
              >
                {countText}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default Tabs;
