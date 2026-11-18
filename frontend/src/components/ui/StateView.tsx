// Shared async-state views (C10): EmptyState / LoadingState / ErrorPanel /
// Skeleton, plus the inline ErrorPanel form used for "refreshing → error"
// (stale data kept, row-level warning instead of falling back to empty).
//
// Hard rules enforced here:
//   - failure never renders an empty state (A3 IX-01 / IX-04);
//   - every async block has one state, not `array.length === 0` (IX-01);
//   - a retry stays in the error branch until the caller re-enters loading;
//   - empty-state titles are real headings and error panels are `role="alert"`.
//
// Sizes (A2 C10): page = py-16, card = py-10, inline = py-3. The old scattered
// paddings (py-24/20/12/8/10) are intentionally not offered.
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from './Button';

export type StateSize = 'page' | 'card' | 'inline';

export interface EmptyAction {
    label: string;
    onClick: () => void;
    testId?: string;
}

export interface EmptyStateProps {
    icon?: LucideIcon;
    title: string;
    hint?: string;
    action?: EmptyAction;
    size?: StateSize;
    testId?: string;
    className?: string;
}

const EMPTY_PADDING: Record<StateSize, string> = {
    page: 'py-16',
    card: 'py-10',
    inline: 'py-3',
};

/**
 * Empty state: only for "request succeeded and the result is empty".
 * Four slots — icon + title + one hint + at most one next action.
 */
export function EmptyState({
    icon: Icon,
    title,
    hint,
    action,
    size = 'card',
    testId,
    className,
}: EmptyStateProps) {
    const inline = size === 'inline';
    const Heading = size === 'page' ? 'h2' : 'h3';
    return (
        <div
            data-testid={testId}
            data-state="empty"
            className={cn(
                'flex flex-col items-center justify-center text-center',
                EMPTY_PADDING[size],
                inline ? 'gap-0.5' : 'gap-1',
                className,
            )}
        >
            {Icon && (
                <Icon
                    aria-hidden="true"
                    className={cn(
                        'text-zinc-700',
                        inline ? 'mb-1 h-4 w-4' : 'mb-2 h-10 w-10',
                    )}
                />
            )}
            <Heading
                className={cn(
                    'text-fg-strong',
                    inline ? 'text-caption font-medium' : 'text-ui font-medium',
                )}
            >
                {title}
            </Heading>
            {hint && (
                <p
                    className={cn(
                        'text-fg-secondary',
                        inline ? 'text-micro leading-relaxed' : 'text-caption leading-relaxed',
                        inline ? 'max-w-full' : 'max-w-md',
                    )}
                >
                    {hint}
                </p>
            )}
            {action && (
                <Button
                    variant="secondary"
                    size={inline ? 'sm' : 'md'}
                    className={cn(inline ? 'mt-1.5' : 'mt-3')}
                    onClick={action.onClick}
                    testId={action.testId}
                >
                    {action.label}
                </Button>
            )}
        </div>
    );
}

export interface LoadingStateProps {
    kind?: 'spinner' | 'skeleton';
    label?: string;
    /** Prevents the surrounding card from collapsing while loading. */
    minHeight?: number;
    /** Skeleton rows; defaults to 3 like the real list. */
    rows?: number;
    size?: 'sm' | 'md' | 'lg';
    testId?: string;
    className?: string;
}

const SPINNER_SIZE: Record<NonNullable<LoadingStateProps['size']>, string> = {
    sm: 'h-3.5 w-3.5',
    md: 'h-4 w-4',
    lg: 'h-6 w-6',
};

/**
 * Loading state: skeleton for a list's first paint, inline spinner for
 * refreshes. `aria-busy` marks the block; the label is the readable status
 * (a bare spinner is never the only signal, IX-03).
 */
export function LoadingState({
    kind = 'spinner',
    label,
    minHeight,
    rows = 3,
    size = 'md',
    testId,
    className,
}: LoadingStateProps) {
    return (
        <div
            data-testid={testId}
            data-state={kind === 'skeleton' ? 'loading-skeleton' : 'loading'}
            role="status"
            aria-busy="true"
            aria-live="polite"
            className={cn('min-w-0', kind === 'spinner' && 'flex items-center gap-2', className)}
            style={minHeight !== undefined ? { minHeight } : undefined}
        >
            {kind === 'skeleton' ? (
                <div className="min-w-0 space-y-2" aria-hidden="true">
                    {Array.from({ length: Math.max(1, rows) }, (_, index) => (
                        <div
                            key={index}
                            className="h-10 animate-pulse rounded-xl bg-white/5"
                        />
                    ))}
                </div>
            ) : (
                <Loader2
                    aria-hidden="true"
                    className={cn('shrink-0 animate-spin text-zinc-500', SPINNER_SIZE[size])}
                />
            )}
            {label && (
                <span className={cn('text-zinc-500', kind === 'skeleton' ? 'sr-only' : 'text-micro')}>
                    {label}
                </span>
            )}
        </div>
    );
}

export interface ErrorPanelProps {
    level?: StateSize;
    /** What happened, in the user's language (no stack traces/status codes). */
    title?: string;
    /** Optional extra context; never the only copy. */
    detail?: string;
    /** Primary action: retry the same request with the same parameters. */
    onRetry?: () => void;
    retryLabel?: string;
    /** A second way out (back to content, login, …) so users are never trapped. */
    secondary?: EmptyAction;
    /** True while the caller's retry is in flight; disables repeat clicks. */
    retrying?: boolean;
    testId?: string;
    /** Stable selector for the retry button (tests only). */
    retryTestId?: string;
    className?: string;
}

/**
 * Error panel: what happened → what you can do → one primary action.
 * `inline` collapses to a single row and is also the "refreshing failed, old
 * data kept" warning (A4 G12-21) — it must never replace the rendered data.
 */
export function ErrorPanel({
    level = 'card',
    title,
    detail,
    onRetry,
    retryLabel,
    secondary,
    retrying = false,
    testId,
    retryTestId,
    className,
}: ErrorPanelProps) {
    const inline = level === 'inline';
    const retryButton = onRetry ? (
        <Button
            variant="secondary"
            size="sm"
            loading={retrying}
            iconLeft={retrying ? undefined : <RefreshCw />}
            onClick={onRetry}
            testId={retryTestId}
            className={cn(inline && 'shrink-0')}
        >
            {retryLabel}
        </Button>
    ) : null;
    const secondaryButton = secondary ? (
        <Button
            variant="ghost"
            size="sm"
            onClick={secondary.onClick}
            className={cn(inline && 'shrink-0')}
        >
            {secondary.label}
        </Button>
    ) : null;

    if (inline) {
        return (
            <div
                data-testid={testId}
                data-state="error-inline"
                role="alert"
                className={cn(
                    'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-caption',
                    className,
                )}
            >
                <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-danger-fg" />
                <span className="min-w-0 flex-1 text-danger-fg">
                    {title}
                    {detail && <span className="ml-1 text-fg-muted">{detail}</span>}
                </span>
                {retryButton}
                {secondaryButton}
            </div>
        );
    }

    const page = level === 'page';
    return (
        <div
            data-testid={testId}
            data-state="error"
            role="alert"
            aria-live="assertive"
            className={cn(
                'min-w-0',
                page
                    ? 'flex flex-col items-center justify-center py-16 text-center'
                    : 'flex items-start gap-3 rounded-card border border-danger/20 bg-danger/[0.06] p-4',
                className,
            )}
        >
            <span
                className={cn(
                    'flex shrink-0 items-center justify-center',
                    page
                        ? 'mb-2 h-10 w-10 text-danger-fg'
                        : 'mt-0.5 h-8 w-8 rounded-full bg-danger/10 text-danger-fg',
                )}
            >
                <AlertTriangle aria-hidden="true" className={page ? 'h-10 w-10' : 'h-4 w-4'} />
            </span>
            <div className={cn('min-w-0', page ? 'max-w-md' : 'flex-1')}>
                {title && (
                    <p className={cn('font-medium text-danger-fg', page ? 'text-ui' : 'text-caption')}>
                        {title}
                    </p>
                )}
                {detail && (
                    <p className={cn('text-fg-secondary', page ? 'mt-1 text-caption' : 'mt-0.5 text-micro', 'leading-relaxed')}>
                        {detail}
                    </p>
                )}
                {(retryButton || secondaryButton) && (
                    <div
                        className={cn(
                            'flex flex-wrap items-center gap-2',
                            page ? 'justify-center' : 'mt-2.5',
                        )}
                    >
                        {retryButton}
                        {secondaryButton}
                    </div>
                )}
            </div>
        </div>
    );
}

export interface SkeletonProps {
    lines?: number;
    className?: string;
}

/** Bare skeleton body for composing into a card that owns its own padding. */
export function Skeleton({ lines = 3, className }: SkeletonProps) {
    return (
        <div aria-hidden="true" data-state="skeleton" className={cn('space-y-2', className)}>
            {Array.from({ length: Math.max(1, lines) }, (_, index) => (
                <div key={index} className="h-3 animate-pulse rounded-full bg-white/5" />
            ))}
        </div>
    );
}

export interface RefreshingStateProps {
    label?: string;
    testId?: string;
    className?: string;
}

/**
 * `success → refreshing` indicator: data stays on screen, only a small inline
 * spinner + label is added (IX-01). A refresh failure then renders
 * `ErrorPanel level="inline"` underneath the kept data.
 */
export function RefreshingState({ label, testId, className }: RefreshingStateProps) {
    return (
        <LoadingState
            kind="spinner"
            size="sm"
            label={label}
            testId={testId}
            className={className}
        />
    );
}
