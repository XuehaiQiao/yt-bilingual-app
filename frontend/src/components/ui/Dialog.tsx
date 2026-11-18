// Shared modal shell (A2 components.md §C4 / A3 interaction-spec.md IX-09).
//
// One contract for every modal in the product:
//   portal → overlay → panel(role=dialog|alertdialog, aria-modal,
//   aria-labelledby) with a 44×44 close button, Escape/backdrop close, a focus
//   trap, body scroll lock, background inert, and focus restored to the
//   trigger when it closes.
//
// The exit animation is owned here: the panel stays mounted for ~160ms after
// `open` flips false (0ms under prefers-reduced-motion), then unmounts.
import {
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
    type ReactNode,
    type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/I18nProvider';

export type DialogRole = 'dialog' | 'alertdialog';
export type DialogSize = 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<DialogSize, string> = {
    sm: 'max-w-dialog-sm',
    md: 'max-w-dialog-md',
    lg: 'max-w-dialog-lg',
};

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'iframe',
    'audio[controls]',
    'video[controls]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

const EXIT_MS = 160;

function isVisible(element: HTMLElement): boolean {
    if (element.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
}

function getFocusable(panel: HTMLElement): HTMLElement[] {
    return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.getAttribute('aria-hidden') !== 'true' && isVisible(element),
    );
}

function resolveInitialFocus(
    panel: HTMLElement,
    initialFocus: RefObject<HTMLElement | null> | string | undefined,
): HTMLElement | null {
    if (initialFocus) {
        if (typeof initialFocus === 'string') {
            try {
                const match = panel.querySelector<HTMLElement>(initialFocus);
                if (match) return match;
            } catch {
                // Invalid selector: fall through to the first focusable element.
            }
        } else if (initialFocus.current && panel.contains(initialFocus.current)) {
            return initialFocus.current;
        }
    }
    return getFocusable(panel)[0] ?? panel;
}

/** Focus the trigger if it still exists; otherwise fall back to the page title. */
function restoreFocus(opener: HTMLElement | null): void {
    if (opener?.isConnected && opener !== document.body) {
        opener.focus({ preventScroll: true });
        if (document.activeElement === opener) return;
    }
    const heading = document.querySelector<HTMLElement>('[data-page-title], main h1, h1');
    if (!heading) return;
    const previousTabIndex = heading.getAttribute('tabindex');
    if (previousTabIndex === null) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
    if (previousTabIndex === null) heading.removeAttribute('tabindex');
}

export interface DialogProps {
    /** Controlled visibility. Closing runs the exit animation before unmount. */
    open: boolean;
    /** Parent-controlled close. Called after Escape/backdrop/X/onBeforeClose. */
    onClose: () => void;
    /** Required accessible name: rendered as the panel heading and wired to aria-labelledby. */
    title?: ReactNode;
    /** Optional supporting line, wired to aria-describedby. */
    description?: ReactNode;
    /** `alertdialog` for blocking/busy flows; it disables Escape/backdrop/X. */
    role?: DialogRole;
    /** Panel width: sm 448 / md 576 / lg 896 (C4). */
    size?: DialogSize;
    /** Default true. `alertdialog`/loading force it off. */
    closeOnBackdrop?: boolean;
    /** Compatibility alias for closeOnBackdrop (the user-facing prop name). */
    closeOnOverlay?: boolean;
    /** Default true (false for alertdialog). */
    closeOnEsc?: boolean;
    /** Element (ref) or selector for the initial focus; default: first focusable. */
    initialFocus?: RefObject<HTMLElement | null> | string;
    /** Show the 44×44 header close button. Default true; disabled while blocking. */
    showClose?: boolean;
    /** Override the close button's accessible label (defaults to common.close). */
    closeLabel?: string;
    /** At most two actions, secondary left / primary right (C4). */
    footer?: ReactNode;
    /** Inline error at the top of the body; role=alert, never closes the dialog. */
    error?: ReactNode;
    /** Blocking/busy: no Escape, backdrop, or X; exposes aria-busy. */
    loading?: boolean;
    /** Edge-to-edge shell for login gates/first-run guidance (no blur/rounding). */
    fullscreen?: boolean;
    /** Bottom sheet below md, centered modal above it. */
    sheet?: boolean;
    /** Close guard (IX-09/IX-15): return false (or throw) to stay open. */
    onBeforeClose?: () => boolean | Promise<boolean>;
    /** Layout escape hatch only; visuals come from the Dialog contract. */
    className?: string;
    /** Test id placed on the panel. */
    testId?: string;
    /** Accessible name fallback when `title` is omitted. */
    ariaLabel?: string;
    children?: ReactNode;
}

export function Dialog({
    open,
    onClose,
    title,
    description,
    role = 'dialog',
    size = 'md',
    closeOnBackdrop,
    closeOnOverlay,
    closeOnEsc,
    initialFocus,
    showClose = true,
    closeLabel,
    footer,
    error,
    loading = false,
    fullscreen = false,
    sheet = false,
    onBeforeClose,
    className,
    testId,
    ariaLabel,
    children,
}: DialogProps) {
    const { t } = useI18n();
    const titleId = useId();
    const descriptionId = useId();
    const rootRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const openerRef = useRef<HTMLElement | null>(null);
    const closePendingRef = useRef(false);
    // Kept in a ref so an inline `initialFocus` object cannot re-run the modal
    // session effect (which would re-lock scroll and re-capture the opener).
    const initialFocusRef = useRef(initialFocus);

    // `present` is the render gate; it outlives `open` by one exit animation.
    const [present, setPresent] = useState(open);
    const [closing, setClosing] = useState(false);

    const allowEsc = (closeOnEsc ?? role !== 'alertdialog') && !loading;
    const allowBackdrop =
        (closeOnBackdrop ?? closeOnOverlay ?? true) && role !== 'alertdialog' && !loading;
    const closeButtonEnabled = role !== 'alertdialog' && !loading;

    // Keep the latest props reachable from document listeners without
    // re-registering them on every parent render. The sync runs as an effect
    // (not during render) so React never sees a ref mutation mid-render.
    const latestRef = useRef({ open, onClose, onBeforeClose, loading, allowEsc, allowBackdrop });
    useEffect(() => {
        latestRef.current = { open, onClose, onBeforeClose, loading, allowEsc, allowBackdrop };
        initialFocusRef.current = initialFocus;
    });

    const requestClose = useCallback(() => {
        const latest = latestRef.current;
        if (!latest.open || latest.loading || closePendingRef.current) return;
        closePendingRef.current = true;
        const finish = (shouldClose: boolean) => {
            closePendingRef.current = false;
            if (shouldClose) latest.onClose();
        };
        try {
            if (latest.onBeforeClose) {
                Promise.resolve(latest.onBeforeClose()).then(finish).catch(() => finish(false));
            } else {
                finish(true);
            }
        } catch {
            finish(false);
        }
    }, []);

    // open → present, and open=false → keep the panel mounted for the exit
    // animation before returning null.
    useEffect(() => {
        if (open) {
            // This is an external mount/unmount state machine: the portal must
            // stay mounted after `open` flips false until the exit timer fires.
            // eslint-disable-next-line react-hooks/set-state-in-effect -- exit-animation lifecycle
            setPresent(true);
            setClosing(false);
            return;
        }
        if (!present) return;
        setClosing(true);
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const timer = window.setTimeout(() => {
            setPresent(false);
            setClosing(false);
        }, reduced ? 0 : EXIT_MS);
        return () => window.clearTimeout(timer);
    }, [open, present]);

    // Modal session: scroll lock + inert background + focus entry/trap/return
    // + Escape/backdrop close. Keyed on `present` because the portal below only
    // exists once present is true.
    useEffect(() => {
        if (!open || !present) return;
        const root = rootRef.current;
        const panel = panelRef.current;
        if (!root || !panel) return;

        openerRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;

        const body = document.body;
        const html = document.documentElement;
        const previousOverflow = body.style.overflow;
        const previousPaddingRight = body.style.paddingRight;
        const scrollbarGap = window.innerWidth - html.clientWidth;
        const lockedScrollY = window.scrollY;
        body.style.overflow = 'hidden';
        if (scrollbarGap > 0) body.style.paddingRight = `${scrollbarGap}px`;

        const inerted: Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }> = [];
        Array.from(body.children).forEach((child) => {
            if (child === root) return;
            const element = child as HTMLElement;
            inerted.push({
                element,
                inert: element.inert,
                ariaHidden: element.getAttribute('aria-hidden'),
            });
            element.inert = true;
            element.setAttribute('aria-hidden', 'true');
        });

        const focusPanelEdge = (edge: 'first' | 'last') => {
            const items = getFocusable(panel);
            const target = edge === 'first' ? items[0] : items[items.length - 1];
            (target ?? panel).focus({ preventScroll: true });
        };

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                if (!latestRef.current.allowEsc) return;
                event.preventDefault();
                event.stopPropagation();
                requestClose();
                return;
            }
            if (event.key !== 'Tab') return;
            const items = getFocusable(panel);
            if (items.length === 0) {
                event.preventDefault();
                panel.focus({ preventScroll: true });
                return;
            }
            const first = items[0];
            const last = items[items.length - 1];
            const active = document.activeElement;
            if (!panel.contains(active)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus({ preventScroll: true });
                return;
            }
            if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus({ preventScroll: true });
            } else if (event.shiftKey && active === first) {
                event.preventDefault();
                last.focus({ preventScroll: true });
            }
        };

        // Background is inert already; this also catches programmatic focus.
        const onFocusIn = (event: FocusEvent) => {
            const target = event.target;
            if (target instanceof Node && !panel.contains(target)) {
                focusPanelEdge('first');
            }
        };

        // Stop scroll chaining behind the dialog (body lock alone cannot stop
        // an inner app scroller). Scrolling inside the panel stays native.
        const onWheel = (event: WheelEvent) => {
            if (event.target instanceof Node && panel.contains(event.target)) return;
            event.preventDefault();
        };
        const onTouchMove = (event: TouchEvent) => {
            if (event.target instanceof Node && panel.contains(event.target)) return;
            event.preventDefault();
        };

        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('focusin', onFocusIn, true);
        document.addEventListener('wheel', onWheel, { capture: true, passive: false });
        document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });

        const focusTimer = window.setTimeout(() => {
            const target = resolveInitialFocus(panel, initialFocusRef.current);
            target?.focus({ preventScroll: true });
        }, 0);

        return () => {
            window.clearTimeout(focusTimer);
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('focusin', onFocusIn, true);
            document.removeEventListener('wheel', onWheel, { capture: true });
            document.removeEventListener('touchmove', onTouchMove, { capture: true });

            for (const { element, inert, ariaHidden } of inerted) {
                element.inert = inert;
                if (ariaHidden === null) element.removeAttribute('aria-hidden');
                else element.setAttribute('aria-hidden', ariaHidden);
            }
            body.style.overflow = previousOverflow;
            body.style.paddingRight = previousPaddingRight;
            window.scrollTo(0, lockedScrollY);
            restoreFocus(openerRef.current);
        };
    }, [open, present, requestClose]);

    if (!present) return null;

    const headerVisible = Boolean(title) || showClose;
    const labelledBy = title ? titleId : undefined;
    const describedBy = description ? descriptionId : undefined;
    const label = closeLabel ?? t('common.close');

    return createPortal(
        <div
            ref={rootRef}
            className={cn(
                'fixed inset-0 z-dialog flex justify-center',
                closing && 'pointer-events-none',
                fullscreen
                    ? 'items-stretch'
                    : sheet
                      ? 'items-end p-0 sm:items-center sm:p-4'
                      : 'items-center p-4',
            )}
        >
            {!fullscreen && (
                <div
                    aria-hidden="true"
                    data-testid={testId ? `${testId}-overlay` : undefined}
                    onClick={() => {
                        if (latestRef.current.allowBackdrop) requestClose();
                    }}
                    className={cn(
                        'absolute inset-0 bg-overlay backdrop-blur-md',
                        closing
                            ? 'opacity-0 transition-opacity duration-150 ease-exit'
                            : 'animate-[fadeIn_0.25s_ease-out]',
                    )}
                />
            )}
            <div
                ref={panelRef}
                role={role}
                aria-modal="true"
                aria-labelledby={labelledBy}
                aria-describedby={describedBy}
                aria-label={!title ? ariaLabel : undefined}
                aria-busy={loading || undefined}
                tabIndex={-1}
                data-testid={testId}
                data-state={closing ? 'closing' : 'open'}
                className={cn(
                    'relative z-10 flex w-full flex-col overflow-hidden border border-line-strong bg-surface/90 text-fg-primary shadow-elev-3 backdrop-blur-2xl',
                    fullscreen
                        ? 'h-full max-h-none max-w-none rounded-none border-0 bg-app shadow-none'
                        : sheet
                          ? 'max-h-[90dvh] rounded-t-panel rounded-b-none sm:max-h-[85dvh] sm:rounded-card'
                          : 'max-h-[85dvh] rounded-card',
                    !fullscreen && SIZE_CLASSES[size],
                    closing
                        ? 'translate-y-2 opacity-0 transition-[opacity,transform] duration-150 ease-exit'
                        : !fullscreen && 'animate-[slideUp_0.32s_cubic-bezier(0.25,1,0.5,1)]',
                    className,
                )}
            >
                {headerVisible && (
                    <div className="flex shrink-0 items-center justify-between gap-4 border-b border-line-subtle px-6 py-5">
                        <div className="min-w-0">
                            {title && (
                                <h2
                                    id={titleId}
                                    className="text-dialog font-semibold tracking-tight text-fg-primary"
                                >
                                    {title}
                                </h2>
                            )}
                            {description && (
                                <p
                                    id={descriptionId}
                                    className={cn('text-ui text-fg-secondary', title && 'mt-0.5')}
                                >
                                    {description}
                                </p>
                            )}
                        </div>
                        {showClose && (
                            <button
                                type="button"
                                onClick={() => {
                                    if (closeButtonEnabled) requestClose();
                                }}
                                disabled={!closeButtonEnabled}
                                aria-disabled={!closeButtonEnabled}
                                aria-label={label}
                                title={label}
                                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-secondary transition-colors hover:bg-state-hover hover:text-fg-primary disabled:pointer-events-none disabled:opacity-50"
                            >
                                <X className="h-5 w-5" aria-hidden="true" />
                            </button>
                        )}
                    </div>
                )}
                <div className="custom-scrollbar flex-1 overflow-y-auto overscroll-contain p-6">
                    {error ? (
                        <div
                            role="alert"
                            className="mb-4 rounded-control border border-danger/20 bg-danger/10 px-3 py-2 text-caption text-danger-fg"
                        >
                            {error}
                        </div>
                    ) : null}
                    {children}
                </div>
                {footer && (
                    <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-line-subtle px-6 py-4 sm:flex-row sm:justify-end">
                        {footer}
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
}
