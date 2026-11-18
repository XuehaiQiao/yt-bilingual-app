// Shared card / row atoms (design-system/components.md C2).
//
// Rules this file enforces:
//   - one material recipe per role: card 16px / panel 24px / row 12px / stat
//     compact tile — pages never write `rounded-* border bg-zinc-900/*` again;
//   - an interactive card is a real <button>/<a>, never a div with onClick;
//   - the list row lives next door in ListRow.tsx; cards never imitate it.
//
// `padding="none"` is the documented escape hatch for horizontal shelves and
// stat tiles that keep a page-specific compact padding. `as` preserves the
// page semantics (section/article) without re-implementing the surface.
import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { ButtonTone } from './Button';

export type CardVariant = 'card' | 'panel' | 'interactive' | 'stat';
export type CardPadding = 'card' | 'panel' | 'row' | 'none';

export interface CardProps
  extends Omit<HTMLAttributes<HTMLElement>, 'title' | 'onClick'> {
  /** Surface role. `interactive` adds hover + active feedback. */
  variant?: CardVariant;
  /** Inner rhythm; defaults to the variant's own recipe. */
  padding?: CardPadding;
  title?: ReactNode;
  description?: ReactNode;
  /** Renders an IconTile before the title when `title` is present. */
  icon?: LucideIcon;
  iconTone?: ButtonTone;
  footer?: ReactNode;
  /** Keeps the card's height while replacing its body with skeleton lines. */
  loading?: boolean;
  /** Whole-card navigation. Mutually exclusive with `onClick`. */
  href?: string;
  /** Whole-card action. Mutually exclusive with `href`. */
  onClick?: () => void;
  /** Element used for the non-interactive surface (default `div`). */
  as?: ElementType;
  testId?: string;
  /** shorthand for `aria-label` on an interactive card. */
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
  /** Pass-through `data-*` attributes (testids, analytics hooks). */
  [key: `data-${string}`]: unknown;
}

const BASE_CLASSES = 'min-w-0 border text-left';

const VARIANT_CLASSES: Record<CardVariant, string> = {
  card: 'rounded-card border-line-subtle bg-surface/40',
  panel: 'rounded-panel border-line-subtle bg-surface/40',
  interactive:
    'rounded-card border-line-subtle bg-surface/40 ' +
    'transition-[background-color,border-color,transform] duration-200 ease-apple ' +
    'hover:border-line-strong hover:bg-surface/50',
  stat: 'rounded-control-lg border-line-subtle bg-surface-2/30',
};

const PADDING_CLASSES: Record<CardPadding, string> = {
  card: 'p-4 sm:p-5',
  panel: 'p-4 sm:p-6',
  row: 'p-3',
  none: '',
};

const DEFAULT_PADDING: Record<CardVariant, CardPadding> = {
  card: 'card',
  panel: 'panel',
  interactive: 'card',
  stat: 'row',
};

function CardHeader({
  icon,
  iconTone,
  title,
  description,
}: {
  icon?: LucideIcon;
  iconTone?: ButtonTone;
  title?: ReactNode;
  description?: ReactNode;
}) {
  if (!title && !description) return null;
  return (
    <div className="flex items-start gap-3">
      {icon && <IconTile icon={icon} tone={iconTone} size="md" />}
      <div className="min-w-0">
        {title && (
          <h3 className="text-section font-semibold tracking-tight text-fg-primary">
            {title}
          </h3>
        )}
        {description && (
          <p className="mt-0.5 text-caption leading-relaxed text-fg-secondary">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

function CardBody({ loading, children }: { loading?: boolean; children?: ReactNode }) {
  if (loading) {
    return (
      <div className="space-y-2" aria-hidden="true">
        <div className="h-4 w-3/5 animate-pulse rounded bg-white/5" />
        <div className="h-3 w-full animate-pulse rounded bg-white/5" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-white/5" />
      </div>
    );
  }
  return <>{children}</>;
}

export function Card({
  variant = 'card',
  padding,
  title,
  description,
  icon,
  iconTone,
  footer,
  loading = false,
  href,
  onClick,
  as,
  testId,
  ariaLabel,
  className,
  children,
  ...rest
}: CardProps) {
  const interactive = variant === 'interactive' || Boolean(href || onClick);
  const surface = interactive && variant !== 'interactive' ? 'interactive' : variant;
  const classes = cn(
    BASE_CLASSES,
    VARIANT_CLASSES[surface],
    interactive && surface === 'interactive' && 'cursor-pointer active:scale-[0.99]',
    PADDING_CLASSES[padding ?? DEFAULT_PADDING[variant]],
    className,
  );
  const body = (
    <>
      <CardHeader
        icon={icon}
        iconTone={iconTone}
        title={title}
        description={description}
      />
      {(title || description) && children ? (
        <div className="mt-3 min-w-0">{loading ? <CardBody loading /> : children}</div>
      ) : (
        <CardBody loading={loading}>{children}</CardBody>
      )}
      {footer && <div className="mt-3 flex flex-wrap items-center gap-2">{footer}</div>}
    </>
  );

  if (href) {
    return (
      <a
        {...rest}
        href={href}
        data-testid={testId}
        aria-label={ariaLabel}
        className={classes}
      >
        {body}
      </a>
    );
  }

  if (onClick) {
    return (
      <button
        {...rest}
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        onClick={onClick}
        className={classes}
      >
        {body}
      </button>
    );
  }

  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag {...rest} data-testid={testId} aria-label={ariaLabel} className={classes}>
      {body}
    </Tag>
  );
}

export interface IconTileProps {
  icon: LucideIcon;
  tone?: ButtonTone;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const ICON_TILE_SIZE: Record<NonNullable<IconTileProps['size']>, string> = {
  sm: 'h-9 w-9 rounded-control-lg',
  md: 'h-10 w-10 rounded-control-lg',
  lg: 'h-12 w-12 rounded-card',
};

const ICON_TILE_GLYPH: Record<NonNullable<IconTileProps['size']>, string> = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-6 w-6',
};

const ICON_TILE_TONE: Record<ButtonTone, string> = {
  brand: 'border-brand/20 bg-brand/10 text-brand-300',
  success: 'border-success/20 bg-success/10 text-success-fg',
  warning: 'border-warning/20 bg-warning/10 text-warning-fg',
  danger: 'border-danger/20 bg-danger/10 text-danger-fg',
};

/** Card/list icon container. Same role on one screen must share one size. */
export function IconTile({ icon: Icon, tone, size = 'md', className }: IconTileProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center border',
        ICON_TILE_SIZE[size],
        tone ? ICON_TILE_TONE[tone] : 'border-line-subtle bg-surface-2/60 text-fg-secondary',
        className,
      )}
    >
      <Icon aria-hidden="true" className={ICON_TILE_GLYPH[size]} />
    </span>
  );
}

export interface SectionHeaderProps {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  id?: string;
  testId?: string;
  className?: string;
}

/** Shelf/section title: 17/600 + optional hint and one text-link action. */
export function SectionHeader({
  title,
  hint,
  action,
  id,
  testId,
  className,
}: SectionHeaderProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex flex-wrap items-end justify-between gap-x-4 gap-y-2',
        className,
      )}
    >
      <div className="min-w-0">
        <h2
          id={id}
          className="text-section font-semibold tracking-tight text-fg-primary"
        >
          {title}
        </h2>
        {hint && (
          <p className="mt-0.5 text-caption leading-relaxed text-fg-secondary">{hint}</p>
        )}
      </div>
      {action && <div className="shrink-0 text-caption text-brand-300">{action}</div>}
    </div>
  );
}

export default Card;
