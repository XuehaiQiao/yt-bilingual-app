// Shared binary switch (role=switch). Distinct from Segmented/Tabs: a switch
// takes effect immediately and is never a "Save"-gated form control.
//
// Native <button> keeps Space/Enter, focus and disabled behaviour for free;
// we only add the role/state/loading contract on top. The visible track is
// 24px tall, while coarse pointers get a 44px hit target via a pseudo-element
// (so layout next to text does not grow).
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';

export type SwitchTone = 'brand' | 'warning';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name. The switch announces on/off itself. */
  ariaLabel: string;
  disabled?: boolean;
  /** Keeps the track width, disables input, shows a spinner in the thumb. */
  loading?: boolean;
  /** `warning` is for a switch that enables a warning state (maintenance). */
  tone?: SwitchTone;
  title?: string;
  testId?: string;
  /** Layout overrides only (margin / alignment). */
  className?: string;
}

const TRACK_BY_TONE: Record<SwitchTone, string> = {
  brand:
    'border-brand/40 bg-brand hover:bg-brand/90 active:bg-brand-600',
  warning:
    'border-warning/40 bg-warning/80 hover:bg-warning/90 active:bg-warning',
};

const TOUCH_TARGET =
  '[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 ' +
  "[@media(pointer:coarse)]:after:content-['']";

export function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
  loading = false,
  tone = 'brand',
  title,
  testId,
  className,
}: SwitchProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      aria-disabled={isDisabled || undefined}
      title={title}
      data-testid={testId}
      data-state={checked ? 'checked' : 'unchecked'}
      disabled={isDisabled}
      onClick={() => {
        if (isDisabled) return;
        onChange(!checked);
      }}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 select-none items-center rounded-full border',
        'transition-colors duration-200 ease-apple active:scale-[0.98]',
        'disabled:pointer-events-none disabled:opacity-50',
        TOUCH_TARGET,
        checked ? TRACK_BY_TONE[tone] : 'border-line-subtle bg-surface-3/80',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded-full bg-control shadow-elev-1',
          'transition-transform duration-200 ease-apple',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
      >
        {loading && <Loader2 className="h-3 w-3 animate-spin text-fg-inverse" />}
      </span>
    </button>
  );
}

export default Switch;
