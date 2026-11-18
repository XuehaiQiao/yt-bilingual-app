// Shared list row (design-system/components.md C2).
//
// One surface for every scannable row: `p-3 rounded-control-lg bg-surface-2/30`
// with the same hover (border + surface-2/60) and focus ring. Callers pass
// leading / title / subtitle / meta / trailing; they never re-declare the row
// background.
//
// A row with an action renders `div[role="button"]` (not `<button>`) so an
// independent trailing action — e.g. the delete icon — can stay inside the row
// without nesting interactive elements. That nested action must call
// `event.stopPropagation()`; RecentLearning does.
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface ListRowProps
  extends Omit<HTMLAttributes<HTMLElement>, 'title' | 'onClick'> {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  /** Row navigation. Mutually exclusive with `onClick`. */
  href?: string;
  /** Row action. */
  onClick?: () => void;
  testId?: string;
  ariaLabel?: string;
  /** Override the title treatment (e.g. `truncate` or `line-clamp-2`). */
  titleClassName?: string;
  /** Override the subtitle treatment (e.g. brand link hint). */
  subtitleClassName?: string;
  className?: string;
  /** Pass-through `data-*` attributes (testids, analytics hooks). */
  [key: `data-${string}`]: unknown;
}

const BASE_CLASSES =
  'flex min-w-0 items-start gap-2.5 rounded-control-lg border border-line-subtle ' +
  'bg-surface-2/30 p-3 text-left';

const INTERACTIVE_CLASSES =
  'cursor-pointer transition-colors hover:border-line-strong hover:bg-surface-2/60 ' +
  'active:bg-surface-2/70 focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-brand/50';

export function ListRow({
  leading,
  title,
  subtitle,
  meta,
  trailing,
  href,
  onClick,
  testId,
  ariaLabel,
  titleClassName,
  subtitleClassName,
  className,
  ...rest
}: ListRowProps) {
  const clickable = Boolean(onClick || href);
  const classes = cn(BASE_CLASSES, clickable && INTERACTIVE_CLASSES, className);
  const body = (
    <>
      {leading && <div className="shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1">
        <span className={cn('block text-ui font-medium text-fg-strong', titleClassName)}>
          {title}
        </span>
        {subtitle && (
          <span
            className={cn(
              'mt-0.5 block text-caption leading-relaxed text-fg-secondary',
              subtitleClassName,
            )}
          >
            {subtitle}
          </span>
        )}
        {meta && <span className="mt-0.5 block text-micro text-fg-muted">{meta}</span>}
      </div>
      {trailing && <div className="flex shrink-0 items-start gap-1">{trailing}</div>}
    </>
  );

  if (href) {
    return (
      <a {...rest} href={href} data-testid={testId} aria-label={ariaLabel} className={classes}>
        {body}
      </a>
    );
  }

  if (onClick) {
    return (
      <div
        {...rest}
        role="button"
        tabIndex={0}
        data-testid={testId}
        aria-label={ariaLabel}
        className={classes}
        onClick={onClick}
        onKeyDown={(event) => {
          // A nested trailing action keeps its own keyboard behaviour.
          if (event.target !== event.currentTarget) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onClick();
        }}
      >
        {body}
      </div>
    );
  }

  return (
    <div {...rest} data-testid={testId} aria-label={ariaLabel} className={classes}>
      {body}
    </div>
  );
}

export default ListRow;
