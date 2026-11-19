// Shared filter chip (A2 tokens.md §2/§4).
//
// A single-select toggle for toolbar filters (library level, phrase type,
// CEFR band). Keyboard is the native button contract (Space/Enter); the
// pressed state is exposed through `aria-pressed`. Disabled chips keep their
// width and show the standard 50% opacity. `onClear` adds a sibling clear
// action without nesting a button inside a button.
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface FilterChipBaseProps {
  children: ReactNode;
  /** Toggle state; always mirrored to `aria-pressed`. */
  selected?: boolean;
  disabled?: boolean;
  /** Optional count (already formatted by the caller). */
  count?: ReactNode;
  /** Screen-reader name when the visible label is not enough (e.g. + count). */
  ariaLabel?: string;
  testId?: string;
  onClick?: () => void;
  /** Layout overrides only (margin / alignment). */
  className?: string;
}

/** `clearLabel` becomes mandatory as soon as the clear action exists. */
export type FilterChipClearProps =
  | { onClear: () => void; clearLabel: string }
  | { onClear?: undefined; clearLabel?: string };

export type FilterChipProps = FilterChipBaseProps & FilterChipClearProps;

const CHIP_BASE =
  'inline-flex h-control-xs shrink-0 select-none items-center justify-center gap-1.5 ' +
  'whitespace-nowrap rounded-control border px-2.5 text-caption font-medium ' +
  'transition-colors duration-200 ease-apple ' +
  '[@media(pointer:coarse)]:min-h-11 ' +
  'disabled:pointer-events-none disabled:opacity-50';

const SELECTED_CLASSES =
  'border-brand/30 bg-brand/15 text-brand-300 hover:bg-brand/20 active:bg-brand/25';

const UNSELECTED_CLASSES =
  'border-line-subtle bg-surface-2/60 text-fg-secondary ' +
  'hover:border-line-strong hover:bg-surface-3/60 hover:text-fg-primary active:bg-surface-3/80';

export function FilterChip({
  children,
  selected = false,
  disabled = false,
  count,
  ariaLabel,
  testId,
  onClick,
  onClear,
  clearLabel,
  className,
}: FilterChipProps) {
  const chip = (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onClick?.();
      }}
      className={cn(
        CHIP_BASE,
        selected ? SELECTED_CLASSES : UNSELECTED_CLASSES,
        !onClear && className,
      )}
    >
      <span>{children}</span>
      {count != null && (
        <span
          aria-hidden="true"
          className={cn('text-micro tabular-nums', selected ? 'text-brand-300/80' : 'text-fg-muted')}
        >
          {count}
        </span>
      )}
    </button>
  );

  if (!onClear) return chip;

  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {chip}
      <button
        type="button"
        aria-label={clearLabel}
        title={clearLabel}
        disabled={disabled}
        onClick={onClear}
        className={cn(
          'inline-flex h-control-xs w-7 items-center justify-center rounded-control text-fg-muted',
          'transition-colors duration-200 ease-apple hover:bg-state-hover hover:text-fg-primary',
          '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

export default FilterChip;
