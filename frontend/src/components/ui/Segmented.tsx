// Shared segmented control (A2 components.md C6 / A3 interaction-spec.md IX-19).
//
// One compact, mutually-exclusive choice: 2–5 options; six or more belong in
// Tabs / a menu. The caller owns persistence and side effects; the control is
// fully controlled and applies on click (never inside a "Save" form).
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Loader2 } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '../../lib/cn';

export interface SegmentedOption {
  value: string;
  /** Text or a small composed slot (e.g. language name + BCP-47 code). */
  label: ReactNode;
  icon?: ReactNode;
  testId?: string;
}

export interface SegmentedProps {
  /** 2–5 options by design (C6). Loading-empty is allowed while data arrives. */
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** Unique per screen; two controls on one screen must not share it. */
  layoutId: string;
  ariaLabel: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Shows a spinner on that option while an async switch is in flight. */
  loadingValue?: string;
  /** Stretch to the container (language settings) instead of hugging content. */
  fullWidth?: boolean;
  testId?: string;
  className?: string;
}

const SPRING = { type: 'spring' as const, stiffness: 420, damping: 36 };
const SIZE_CLASSES = {
  sm: 'min-h-7 px-2.5 py-1 text-caption',
  md: 'min-h-8 px-3 py-1.5 text-ui',
} as const;

export function Segmented({
  options,
  value,
  onChange,
  layoutId,
  ariaLabel,
  size = 'sm',
  disabled = false,
  loadingValue,
  fullWidth = false,
  testId,
  className,
}: SegmentedProps) {
  const reducedMotion = useReducedMotion();
  const groupRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const transition = reducedMotion ? { duration: 0 } : SPRING;
  const currentIndex = options.findIndex((option) => option.value === value);

  // Design boundary (C6): 2–5 options. Transient 0–1 while data loads is fine;
  // more than five must move to Tabs / a menu. Warn in dev instead of hiding
  // real options (a show may legitimately have more seasons than the recipe).
  useEffect(() => {
    if (import.meta.env.DEV && options.length > 5) {
      console.warn(
        `[Segmented] "${ariaLabel}" has ${options.length} options; use Tabs/Menu above 5 (C6).`,
      );
    }
  }, [ariaLabel, options.length]);

  // A long season / pack strip must keep the checked option on screen.
  useEffect(() => {
    const group = groupRef.current;
    const active = group?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    if (!group || !active) return;
    if (group.scrollWidth <= group.clientWidth + 1) return;
    active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);

  const select = useCallback(
    (next: string) => {
      if (disabled || next === value) return;
      onChange(next);
    },
    [disabled, onChange, value],
  );

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
      if (disabled || options.length === 0) return;
      event.preventDefault();

      const current = Math.max(0, currentIndex);
      let next = current;
      if (key === 'ArrowRight' || key === 'ArrowDown') next = (current + 1) % options.length;
      else if (key === 'ArrowLeft' || key === 'ArrowUp') {
        next = (current - 1 + options.length) % options.length;
      } else if (key === 'Home') next = 0;
      else if (key === 'End') next = options.length - 1;

      const target = options[next];
      if (!target) return;
      select(target.value);
      optionRefs.current.get(target.value)?.focus();
    },
    [currentIndex, disabled, options, select],
  );

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      onKeyDown={onKeyDown}
      className={cn(
        'items-center gap-0.5 rounded-control border border-line-subtle bg-surface-2/80 p-0.5',
        fullWidth ? 'flex w-full' : 'inline-flex',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      {options.map((option) => {
        const checked = option.value === value;
        const loading = loadingValue === option.value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) optionRefs.current.set(option.value, node);
              else optionRefs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-busy={loading || undefined}
            tabIndex={checked || (currentIndex < 0 && option === options[0]) ? 0 : -1}
            disabled={disabled}
            data-testid={option.testId}
            onClick={() => select(option.value)}
            className={cn(
              'relative inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium',
              'transition-colors duration-200 ease-apple',
              '[@media(pointer:coarse)]:min-h-11',
              SIZE_CLASSES[size],
              fullWidth && 'min-w-0 flex-1',
              checked ? 'text-fg-inverse' : 'text-fg-secondary hover:text-fg-primary',
            )}
          >
            {checked && (
              <motion.span
                layoutId={layoutId}
                aria-hidden="true"
                transition={transition}
                className="absolute inset-0 rounded-control bg-control"
              />
            )}
            <span
              className={cn(
                'relative z-raised inline-flex min-w-0 items-center justify-center gap-1.5',
                fullWidth && 'w-full',
              )}
            >
              {option.icon}
              <span className="min-w-0">{option.label}</span>
              {loading && (
                <Loader2
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 animate-spin opacity-70"
                />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default Segmented;
