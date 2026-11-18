import { useCallback, useEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import {
    subscribeToToasts,
    TOAST_DEDUPE_WINDOW_MS,
    TOAST_MAX_VISIBLE,
    type ToastItem,
} from '../lib/toast';

// A2 C8 / A3 IX-08: success 3 s · info 5 s · error 8 s (long/actionable errors
// stay open), same-key 5 s dedupe, at most 3 visible with a FIFO queue, timers
// pause on hover/focus, and the stack clears the mobile bottom bar + safe area.

const styles: Record<ToastItem['type'], { border: string; icon: ReactNode }> = {
    error: { border: 'border-red-500/30', icon: <AlertCircle className="w-5 h-5 text-red-400 shrink-0" aria-hidden="true" /> },
    success: { border: 'border-emerald-500/30', icon: <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" aria-hidden="true" /> },
    info: { border: 'border-blue-500/30', icon: <Info className="w-5 h-5 text-blue-400 shrink-0" aria-hidden="true" /> },
};

/** Shared card chrome used by every toast type. */
const CARD_CLASS =
    'pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-2xl bg-zinc-900/85 backdrop-blur-xl backdrop-saturate-150 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_16px_-6px_rgba(0,0,0,0.5),0_24px_64px_-16px_rgba(0,0,0,0.6)]';

interface ToastCardProps {
    item: ToastItem;
    onDismiss: (id: number) => void;
}

function ToastCard({ item, onDismiss }: ToastCardProps) {
    const { t } = useI18n();
    const reduceMotion = useReducedMotion() ?? false;
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);

    // Remaining lifetime survives pause/resume; a dedupe hit (emittedAt bump)
    // restarts it from the full duration.
    const remainingRef = useRef(item.duration);
    const startedAtRef = useRef(0);
    const paused = hovered || focused;
    const action = item.action;

    useEffect(() => {
        remainingRef.current = item.duration;
    }, [item.emittedAt, item.duration]);

    useEffect(() => {
        if (paused || !Number.isFinite(item.duration)) return;
        startedAtRef.current = Date.now();
        const timer = window.setTimeout(() => onDismiss(item.id), Math.max(0, remainingRef.current));
        return () => {
            window.clearTimeout(timer);
            remainingRef.current = Math.max(
                0,
                remainingRef.current - (Date.now() - startedAtRef.current),
            );
        };
    }, [paused, item.id, item.duration, item.emittedAt, onDismiss]);

    const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
        // Keep the timer paused while focus moves between the action and close.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onDismiss(item.id);
    };

    return (
        <motion.div
            layout={!reduceMotion}
            initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={
                reduceMotion
                    ? { opacity: 0, transition: { duration: 0 } }
                    : { opacity: 0, y: 8, scale: 0.96, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }
            }
            transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 480, damping: 34, mass: 0.9 }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            role={item.type === 'error' ? 'alert' : 'status'}
            aria-live={item.type === 'error' ? 'assertive' : 'polite'}
            aria-atomic="true"
            data-testid="toast"
            data-toast-type={item.type}
            data-toast-key={item.dedupeKey}
            className={`${CARD_CLASS} border ${styles[item.type].border}`}
        >
            {styles[item.type].icon}
            <p
                title={item.message}
                className="min-w-0 flex-1 text-sm leading-relaxed text-zinc-200 break-words line-clamp-3"
            >
                {item.message}
            </p>
            {action && (
                <button
                    type="button"
                    data-testid="toast-action"
                    onClick={() => {
                        try {
                            action.onClick();
                        } finally {
                            onDismiss(item.id);
                        }
                    }}
                    className="-my-2 inline-flex h-11 shrink-0 items-center rounded-lg px-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 hover:text-white active:scale-[0.98]"
                >
                    {action.label}
                </button>
            )}
            <button
                type="button"
                data-testid="toast-close"
                aria-label={t('common.close')}
                title={t('common.close')}
                onClick={() => onDismiss(item.id)}
                className="-m-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300 active:scale-95"
            >
                <X className="w-4 h-4" aria-hidden="true" />
            </button>
        </motion.div>
    );
}

export const Toaster = () => {
    const [items, setItems] = useState<ToastItem[]>([]);

    useEffect(
        () =>
            subscribeToToasts((incoming) => {
                setItems((prev) => {
                    const index = prev.findIndex(
                        (existing) =>
                            existing.dedupeKey === incoming.dedupeKey &&
                            incoming.emittedAt - existing.emittedAt < TOAST_DEDUPE_WINDOW_MS,
                    );
                    if (index === -1) return [...prev, incoming];

                    // Same key inside the dedupe window: refresh the existing
                    // card (stable id) instead of stacking a second one.
                    const next = prev.slice();
                    next[index] = {
                        ...next[index],
                        message: incoming.message,
                        type: incoming.type,
                        duration: incoming.duration,
                        action: incoming.action,
                        emittedAt: Math.max(incoming.emittedAt, next[index].emittedAt + 1),
                    };
                    return next;
                });
            }),
        [],
    );

    const dismiss = useCallback((id: number) => {
        setItems((prev) => prev.filter((item) => item.id !== id));
    }, []);

    // Queue: only the first three are mounted; a dismissal promotes the next.
    const visible = items.slice(0, TOAST_MAX_VISIBLE);

    return (
        <div
            data-testid="toaster"
            aria-live="polite"
            aria-atomic="false"
            className="pointer-events-none fixed left-4 right-4 bottom-safe-nav z-toast flex flex-col gap-3 md:left-auto md:right-6 md:bottom-6 md:max-w-[28rem]"
        >
            <AnimatePresence>
                {visible.map((item) => (
                    <ToastCard key={item.id} item={item} onDismiss={dismiss} />
                ))}
            </AnimatePresence>
        </div>
    );
};
