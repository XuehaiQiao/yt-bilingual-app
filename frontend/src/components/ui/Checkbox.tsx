// Shared checkbox (A2 components.md §2 / A3 IX-07).
//
// Native `<input type="checkbox">` inside a 36×36 (44×44 on coarse pointers)
// label, so the hit area is reachable on touch without a custom glyph. The
// accent colour is the brand token; `aria-label` is mandatory because the
// control never renders a visible label of its own (the row text is the label
// but it is not programmatically associated with a table of repeated rows).
import { cn } from '../../lib/cn';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name, e.g. 「选择 abundant」. */
  ariaLabel: string;
  disabled?: boolean;
  testId?: string;
  /** Layout overrides only. */
  className?: string;
}

export function Checkbox({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
  testId,
  className,
}: CheckboxProps) {
  return (
    <label
      className={cn(
        'inline-flex h-control-md w-9 shrink-0 cursor-pointer items-center justify-center rounded-control',
        'transition-colors duration-200 ease-apple hover:bg-state-hover',
        '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      <input
        type="checkbox"
        data-testid={testId}
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 cursor-pointer accent-brand disabled:cursor-not-allowed"
      />
    </label>
  );
}

export default Checkbox;
