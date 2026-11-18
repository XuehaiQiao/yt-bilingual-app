// Shared badge family (design-system/components.md C7).
//
//   Badge       – static status/source/level label, 11px minimum;
//   CountBadge  – navigation/tab count, `0` renders nothing, `>max` → `99+`;
//   Dot         – colour-only status with a mandatory accessible label.
//
// Colour never carries the meaning alone: Badge children are the text and a
// Dot always has `role="img"` + `aria-label`.
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { formatCount } from '../../lib/format';

export type BadgeTone =
  | 'neutral'
  | 'brand'
  | 'success'
  | 'warning'
  | 'danger'
  | 'highlight';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'border-line-subtle bg-surface-2/60 text-fg-strong',
  brand: 'border-brand/20 bg-brand/10 text-brand-300',
  success: 'border-success/20 bg-success/10 text-success-fg',
  warning: 'border-warning/20 bg-warning/10 text-warning-fg',
  danger: 'border-danger/20 bg-danger/10 text-danger-fg',
  highlight: 'border-highlight/30 bg-highlight/15 text-highlight-fg',
};

const BASE_CLASSES =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 ' +
  'text-micro font-medium leading-none';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  icon?: ReactNode;
  title?: string;
  testId?: string;
  children: ReactNode;
}

/**
 * Non-interactive label. Use `Button` for anything clickable; use `Dot` only
 * when there is no room for text (and still pass a label).
 */
export function Badge({
  tone = 'neutral',
  icon,
  title,
  testId,
  children,
  className,
  ...rest
}: BadgeProps) {
  return (
    <span
      {...rest}
      data-testid={testId}
      title={title}
      className={cn(BASE_CLASSES, TONE_CLASSES[tone], className)}
    >
      {icon && (
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 items-center [&>svg]:h-3 [&>svg]:w-3"
        >
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}

export interface CountBadgeProps {
  /** Raw count; 0/invalid renders nothing (never a "0" bubble). */
  count: number;
  /** Values above this become `${max}+` (default 99). */
  max?: number;
  /** Full sentence for screen readers, e.g. 「复习到期 12 个」. */
  ariaLabel: string;
  size?: 'sm' | 'md';
  testId?: string;
  className?: string;
}

const COUNT_SIZE: Record<NonNullable<CountBadgeProps['size']>, string> = {
  sm: 'min-w-4 h-4 px-1',
  md: 'min-w-[18px] h-[18px] px-1',
};

export function CountBadge({
  count,
  max = 99,
  ariaLabel,
  size = 'md',
  testId,
  className,
}: CountBadgeProps) {
  if (!Number.isFinite(count) || count <= 0) return null;
  return (
    <span
      data-testid={testId}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-brand',
        'text-micro font-semibold leading-none tabular-nums text-fg-inverse',
        COUNT_SIZE[size],
        className,
      )}
    >
      {formatCount(count, max)}
    </span>
  );
}

const DOT_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-fg-muted',
  brand: 'bg-brand',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  highlight: 'bg-highlight',
};

export interface DotProps {
  tone?: BadgeTone;
  /** Required: colour alone never conveys status. */
  label: string;
  className?: string;
}

export function Dot({ tone = 'neutral', label, className }: DotProps) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', DOT_TONE[tone], className)}
    />
  );
}
