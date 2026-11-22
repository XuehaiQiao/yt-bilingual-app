import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'tinted' | 'ghost' | 'destructive' | 'icon';
export type ButtonTone = 'brand' | 'success' | 'warning' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl'; // 32 / 36 / 40 / 48

export interface ButtonProps {
  /**
   * Visual hierarchy. Defaults to `secondary` on purpose: a primary button is
   * an explicit decision, never an accidental default.
   */
  variant?: ButtonVariant;
  /** Only meaningful for `tinted` (brand / success / warning / danger). */
  tone?: ButtonTone;
  size?: ButtonSize;
  loading?: boolean;
  /** Replaces the label while loading; omitted = the original children stay. */
  loadingLabel?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  /** Square icon-only button; `ariaLabel` becomes mandatory. */
  iconOnly?: boolean;
  ariaLabel?: string;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  /** Explicit button type; native default `submit` is never inherited. */
  type?: 'button' | 'submit';
  onClick?: () => void;
  /** Layout overrides only (width / margin / alignment); visuals come from props. */
  className?: string;
  testId?: string;
  children?: ReactNode;
  /** Optional ARIA state for toggle buttons (star, expand). */
  ariaPressed?: boolean;
  /** Optional ARIA state for the expand control. */
  ariaExpanded?: boolean;
  ariaControls?: string;
}

const BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap select-none ' +
  'transition-[background-color,border-color,color,transform,opacity] duration-200 ease-apple ' +
  'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50';

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-control-sm px-3 rounded-control text-caption',
  md: 'h-control-md px-4 rounded-control text-ui',
  lg: 'h-control-lg px-5 rounded-control-lg text-ui',
  xl: 'h-control-xl px-6 rounded-full text-ui',
};

// Icon buttons are square at every size, keep a 44×44 touch target, and never
// depend on hover (the state matrix requires pointer-coarse parity).
const ICON_SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-control-sm w-8 p-0 rounded-control',
  md: 'h-control-md w-9 p-0 rounded-control',
  lg: 'h-control-lg w-10 p-0 rounded-control-lg',
  xl: 'h-control-xl w-12 p-0 rounded-full',
};

// Tailwind 3.4 has no built-in `pointer-coarse` variant; the arbitrary media
// variant keeps the 44×44 touch target without enlarging the desktop button.
const ICON_TOUCH_CLASSES =
  '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11';

const VARIANT_CLASSES: Record<Exclude<ButtonVariant, 'tinted'>, string> = {
  primary: 'bg-control font-semibold text-fg-inverse hover:bg-white active:bg-white',
  secondary:
    'border border-line-subtle bg-surface-2/60 font-medium text-fg-strong ' +
    'hover:bg-surface-3/60 hover:text-fg-primary active:bg-surface-3/80',
  ghost:
    'font-medium text-fg-secondary hover:bg-state-hover hover:text-fg-primary ' +
    'active:bg-state-pressed',
  destructive:
    'border border-danger/20 bg-danger/10 font-medium text-danger-fg ' +
    'hover:bg-danger/15 active:bg-danger/20',
  icon:
    'font-medium text-fg-secondary hover:bg-state-hover hover:text-fg-primary ' +
    'active:bg-state-pressed',
};

const TINTED_CLASSES: Record<ButtonTone, string> = {
  brand:
    'border border-brand/20 bg-brand/10 text-brand-300 font-medium ' +
    'hover:bg-brand/15 active:bg-brand/20',
  success:
    'border border-success/20 bg-success/10 text-success-fg font-medium ' +
    'hover:bg-success/15 active:bg-success/20',
  warning:
    'border border-warning/20 bg-warning/10 text-warning-fg font-medium ' +
    'hover:bg-warning/15 active:bg-warning/20',
  danger:
    'border border-danger/20 bg-danger/10 text-danger-fg font-medium ' +
    'hover:bg-danger/15 active:bg-danger/20',
};

function IconSlot({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4"
    >
      {children}
    </span>
  );
}

export function Button({
  variant = 'secondary',
  tone = 'brand',
  size = 'md',
  loading = false,
  loadingLabel,
  disabled = false,
  fullWidth = false,
  iconOnly = false,
  ariaLabel,
  iconLeft,
  iconRight,
  type = 'button',
  onClick,
  className,
  testId,
  children,
  ariaPressed,
  ariaExpanded,
  ariaControls,
}: ButtonProps) {
  const isIcon = iconOnly || variant === 'icon';
  const isDisabled = disabled || loading;
  const label = loading && loadingLabel ? loadingLabel : children;

  return (
    <button
      type={type}
      data-testid={testId}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-busy={loading || undefined}
      aria-disabled={isDisabled || undefined}
      disabled={isDisabled}
      onClick={() => {
        if (isDisabled) return;
        onClick?.();
      }}
      className={cn(
        BASE_CLASSES,
        isIcon ? ICON_SIZE_CLASSES[size] : SIZE_CLASSES[size],
        variant === 'tinted' ? TINTED_CLASSES[tone] : VARIANT_CLASSES[variant],
        isIcon && ICON_TOUCH_CLASSES,
        fullWidth && !isIcon && 'w-full',
        className,
      )}
    >
      {loading && <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" />}
      {!loading && iconLeft && <IconSlot>{iconLeft}</IconSlot>}
      {label}
      {!loading && iconRight && <IconSlot>{iconRight}</IconSlot>}
    </button>
  );
}

export type IconButtonProps = Omit<ButtonProps, 'variant' | 'iconOnly'> & {
  ariaLabel: string;
};

/** Square, icon-only Button. `ariaLabel` is required by the type. */
export function IconButton({ ariaLabel, children, ...rest }: IconButtonProps) {
  return (
    <Button {...rest} variant="icon" iconOnly ariaLabel={ariaLabel}>
      {children}
    </Button>
  );
}
