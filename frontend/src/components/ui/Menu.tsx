// Shared anchored menu (A2 components.md §1.3 / A3 interaction-spec.md IX-19).
//
// One trigger button plus one popup with `role="menu"`. The menu owns the open
// state, roving focus, outside-click dismissal, Escape/Tab close and the focus
// return to the trigger. Items are either `menuitemradio` (pass `checked`) or
// plain `menuitem`; `count`, `disabled` and a two-line label are supported so
// the model picker and the review action menu share one implementation.
//
// The popup is positioned inside the caller's box (no portal): both current
// menus live in normal flow and must stay inside the app chrome.
import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type MouseEventHandler,
    type ReactNode,
    type RefObject,
} from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';
import { CountBadge } from './Badge';

export interface MenuItem {
    /** Stable identity for the item; also used as the React key. */
    id: string;
    label: ReactNode;
    /** Optional second line (quota / hint). */
    description?: ReactNode;
    /** Leading action icon. Ignored when `checked` is set (radio indicator wins). */
    icon?: ReactNode;
    /** Trailing slot next to the label, e.g. the model provider chip. */
    meta?: ReactNode;
    /**
     * Passing `checked` (true or false) makes the item a `menuitemradio` with
     * `aria-checked`; omitting it makes a plain `menuitem`.
     */
    checked?: boolean;
    /** Count bubble on the trailing edge; 0 renders nothing (A2 C7). */
    count?: number;
    /** Values above this become `${max}+` (default 99). */
    countMax?: number;
    /** Full sentence for the count bubble, e.g. 「复习到期 12 个」. */
    countAriaLabel?: string;
    disabled?: boolean;
    title?: string;
    onSelect?: () => void;
    /** Keep the menu open after activation (e.g. a retry that refills the list). */
    keepOpen?: boolean;
    /** `data-*` attributes forwarded to the item button (legacy test hooks). */
    data?: Record<string, string | undefined>;
    testId?: string;
    /** Override the accessible name when the visible label is composed. */
    ariaLabel?: string;
}

export interface MenuTriggerProps {
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls': string;
    onClick: MouseEventHandler<HTMLButtonElement>;
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

export interface MenuTriggerState {
    open: boolean;
    triggerRef: RefObject<HTMLButtonElement | null>;
    triggerProps: MenuTriggerProps;
}

export interface MenuProps {
    /** Accessible name of the popup. */
    ariaLabel: string;
    items: MenuItem[];
    /** Render the trigger; spread `triggerProps` and attach `triggerRef`. */
    trigger: (state: MenuTriggerState) => ReactNode;
    /** Controlled mode (the ReviewScreen closes the menu when the card changes). */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Popup edge alignment against the trigger. */
    align?: 'start' | 'end';
    /** Extra popup classes; use for width. Vertical placement is managed here. */
    popupClassName?: string;
    /** Optional heading rendered above the items. */
    header?: ReactNode;
    /** Shown when `items` is empty (e.g. the catalog is still loading). */
    empty?: ReactNode;
    menuTestId?: string;
    /** Wrapper classes; the wrapper is always `relative`. */
    className?: string;
    disabled?: boolean;
}

type OpenIntent = 'first' | 'last';

const ITEM_SELECTOR = '[data-menu-item="true"]:not(:disabled)';

function enabledItems(menu: HTMLElement | null): HTMLButtonElement[] {
    if (!menu) return [];
    return Array.from(menu.querySelectorAll<HTMLButtonElement>(ITEM_SELECTOR));
}

function focusItem(item: HTMLButtonElement | null | undefined): void {
    item?.focus({ preventScroll: true });
}

function sameNode(a: EventTarget | null, root: HTMLElement | null): boolean {
    return !!a && !!root && a instanceof Node && root.contains(a);
}

export function Menu({
    ariaLabel,
    items,
    trigger,
    open,
    onOpenChange,
    align = 'end',
    popupClassName,
    header,
    empty,
    menuTestId,
    className,
    disabled = false,
}: MenuProps) {
    const menuId = useId();
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const controlled = open !== undefined;
    const isOpen = controlled ? open : uncontrolledOpen;

    const intentRef = useRef<OpenIntent>('first');
    // Set once the popup has actually been open; a close without an open (the
    // first render, a card change before interaction) must not move focus.
    const hasOpenedRef = useRef(false);

    const setOpenState = useCallback(
        (next: boolean) => {
            if (!controlled) setUncontrolledOpen(next);
            onOpenChange?.(next);
        },
        [controlled, onOpenChange],
    );

    const closeMenu = useCallback(
        (restoreFocus: boolean) => {
            setOpenState(false);
            if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
        },
        [setOpenState],
    );

    const openMenu = useCallback(
        (intent: OpenIntent) => {
            if (disabled) return;
            intentRef.current = intent;
            setOpenState(true);
        },
        [disabled, setOpenState],
    );

    // Anchored popups flip above the trigger when the viewport has no room
    // below. This is a layout-only data attribute (measured before paint), so
    // it never re-renders React or loses item focus.
    useLayoutEffect(() => {
        if (!isOpen) return;
        const triggerRect = triggerRef.current?.getBoundingClientRect();
        const menu = menuRef.current;
        if (!triggerRect || !menu) return;
        const menuHeight = menu.getBoundingClientRect().height;
        const spaceBelow = window.innerHeight - triggerRect.bottom - 8;
        const spaceAbove = triggerRect.top - 8;
        const next = spaceBelow < menuHeight && spaceAbove > spaceBelow ? 'top' : 'bottom';
        if (menu.dataset.placement !== next) menu.dataset.placement = next;
    }, [isOpen, items.length]);

    // Move focus into the menu after it mounts. A radio group starts on the
    // checked option; ArrowUp starts on the last enabled option.
    useEffect(() => {
        if (!isOpen) return;
        hasOpenedRef.current = true;
        const enabled = enabledItems(menuRef.current);
        if (enabled.length === 0) return;
        const checked = enabled.find((item) => item.getAttribute('aria-checked') === 'true');
        focusItem(intentRef.current === 'last' ? enabled[enabled.length - 1] : checked ?? enabled[0]);
    }, [isOpen]);

    // Async item lists (retry refills the model catalog). If the focused item
    // disappeared and focus fell back to <body>, put it back in the menu
    // instead of stranding the keyboard.
    useEffect(() => {
        if (!isOpen || items.length === 0) return;
        const active = document.activeElement;
        if (active && active !== document.body) return;
        focusItem(enabledItems(menuRef.current)[0]);
    }, [isOpen, items.length]);

    useEffect(() => {
        if (isOpen) return;
        if (!hasOpenedRef.current) return;
        hasOpenedRef.current = false;
        // Closing via Escape/selection already focused the trigger. This
        // covers a parent that flips `open` from outside (card change): the
        // popup unmounts and the browser parks focus on <body>.
        const active = document.activeElement;
        if (!active || active === document.body) {
            triggerRef.current?.focus({ preventScroll: true });
        }
    }, [isOpen]);

    // Dismiss on outside pointer-down (capture, so a consumer that stops the
    // event cannot keep the menu open). Focus goes back to the trigger only
    // when it was inside the menu; clicking another control keeps its focus.
    useEffect(() => {
        if (!isOpen) return;
        const onPointerDown = (event: PointerEvent) => {
            if (sameNode(event.target, rootRef.current)) return;
            const focusInside = sameNode(document.activeElement, rootRef.current);
            closeMenu(false);
            if (!focusInside) return;
            // The default pointer-down action blurs a menu item when the click
            // lands on a non-focusable area, so restore after that action. If
            // the click landed on a focusable control, that control keeps
            // focus — do not steal it back.
            window.requestAnimationFrame(() => {
                const active = document.activeElement;
                if (!active || active === document.body) {
                    triggerRef.current?.focus({ preventScroll: true });
                }
            });
        };
        const onFocusIn = (event: FocusEvent) => {
            if (sameNode(event.target, rootRef.current)) return;
            // Tab / programmatic focus left the menu: close, but do not steal
            // focus back from the element the user just reached.
            closeMenu(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('focusin', onFocusIn);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('focusin', onFocusIn);
        };
    }, [closeMenu, isOpen]);

    const activateItem = useCallback(
        (item: MenuItem) => {
            if (item.disabled) return;
            item.onSelect?.();
            if (!item.keepOpen) closeMenu(true);
        },
        [closeMenu],
    );

    const onTriggerClick = useCallback(() => {
        if (disabled) return;
        if (isOpen) closeMenu(false);
        else openMenu('first');
    }, [closeMenu, disabled, isOpen, openMenu]);

    const onTriggerKeyDown = useCallback(
        (event: KeyboardEvent<HTMLButtonElement>) => {
            if (disabled) return;
            const { key } = event;
            if (key === 'Escape') {
                if (!isOpen) return;
                event.preventDefault();
                event.stopPropagation();
                closeMenu(true);
                return;
            }
            if (key === 'ArrowDown' || key === 'ArrowUp') {
                event.preventDefault();
                if (!isOpen) {
                    openMenu(key === 'ArrowUp' ? 'last' : 'first');
                    return;
                }
                const enabled = enabledItems(menuRef.current);
                focusItem(key === 'ArrowUp' ? enabled[enabled.length - 1] : enabled[0]);
                return;
            }
            if (key === 'Enter' || key === ' ') {
                // Suppress the native button click; open/close exactly once.
                event.preventDefault();
                if (isOpen) closeMenu(false);
                else openMenu('first');
            }
        },
        [closeMenu, disabled, isOpen, openMenu],
    );

    const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!isOpen) return;

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeMenu(true);
            return;
        }

        if (event.key === 'Tab') {
            // Tab leaves the menu: restore the trigger first so the browser
            // continues from the trigger's position in the tab order.
            closeMenu(true);
            return;
        }

        if (!menuRef.current || !sameNode(event.target, menuRef.current)) return;
        const enabled = enabledItems(menuRef.current);
        if (enabled.length === 0) return;

        const currentIndex = enabled.indexOf(document.activeElement as HTMLButtonElement);
        let nextIndex = -1;
        switch (event.key) {
            case 'ArrowDown':
                nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % enabled.length;
                break;
            case 'ArrowUp':
                nextIndex =
                    currentIndex < 0
                        ? enabled.length - 1
                        : (currentIndex - 1 + enabled.length) % enabled.length;
                break;
            case 'Home':
                nextIndex = 0;
                break;
            case 'End':
                nextIndex = enabled.length - 1;
                break;
            default:
                return;
        }
        event.preventDefault();
        focusItem(enabled[nextIndex]);
    };

    return (
        <div
            ref={rootRef}
            className={cn('relative inline-block max-w-full align-middle', className)}
            onKeyDown={onRootKeyDown}
        >
            {trigger({ open: isOpen, triggerRef, triggerProps: {
                'aria-haspopup': 'menu',
                'aria-expanded': isOpen,
                'aria-controls': menuId,
                onClick: onTriggerClick,
                onKeyDown: onTriggerKeyDown,
            } })}

            {isOpen && (
                <div
                    ref={menuRef}
                    id={menuId}
                    role="menu"
                    aria-label={ariaLabel}
                    aria-orientation="vertical"
                    data-placement="bottom"
                    tabIndex={-1}
                    data-testid={menuTestId}
                    className={cn(
                        'absolute z-popover max-h-[min(28rem,calc(100dvh-6rem))] min-w-0 max-w-[calc(100vw-2rem)] overflow-y-auto',
                        'data-[placement=top]:bottom-full data-[placement=top]:mb-2',
                        'data-[placement=bottom]:top-full data-[placement=bottom]:mt-2',
                        'rounded-2xl border border-line-strong bg-surface/90 p-2 shadow-elev-3 backdrop-blur-2xl',
                        'animate-[fadeIn_0.15s_ease-out]',
                        align === 'end' ? 'right-0' : 'left-0',
                        popupClassName ?? 'w-64',
                    )}
                >
                    {header != null && (
                        <div role="presentation" className="px-2.5 pb-2 pt-1.5 text-micro font-medium text-fg-muted">
                            {header}
                        </div>
                    )}

                    {items.map((item) => {
                        const isRadio = item.checked !== undefined;
                        const checked = item.checked === true;
                        return (
                            <button
                                key={item.id}
                                type="button"
                                role={isRadio ? 'menuitemradio' : 'menuitem'}
                                aria-checked={isRadio ? checked : undefined}
                                aria-label={item.ariaLabel}
                                disabled={item.disabled}
                                title={item.title}
                                tabIndex={-1}
                                data-menu-item="true"
                                data-testid={item.testId}
                                {...item.data}
                                onClick={() => activateItem(item)}
                                className={cn(
                                    'flex w-full items-start gap-3 rounded-xl border p-3 text-left',
                                    'transition-[background-color,border-color,opacity] duration-200 ease-apple',
                                    checked
                                        ? 'border-brand/40 bg-brand/10'
                                        : 'border-line-subtle bg-surface-2/30 hover:border-line-strong hover:bg-surface-2/60',
                                    'focus-visible:border-line-strong focus-visible:bg-surface-2/60',
                                    item.disabled && 'cursor-not-allowed opacity-45',
                                )}
                            >
                                {isRadio ? (
                                    <span
                                        aria-hidden="true"
                                        className={cn(
                                            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                                            checked
                                                ? 'border-brand bg-brand text-fg-inverse'
                                                : 'border-fg-disabled',
                                        )}
                                    >
                                        {checked && <Check className="h-3 w-3" strokeWidth={3} />}
                                    </span>
                                ) : item.icon ? (
                                    <span
                                        aria-hidden="true"
                                        className="mt-0.5 inline-flex shrink-0 items-center text-fg-muted [&>svg]:h-4 [&>svg]:w-4"
                                    >
                                        {item.icon}
                                    </span>
                                ) : null}

                                <span className="flex min-w-0 flex-1 flex-col">
                                    <span className="flex items-center justify-between gap-2">
                                        <span className="truncate text-ui font-medium text-fg-primary">
                                            {item.label}
                                        </span>
                                        {item.meta != null && <span className="shrink-0">{item.meta}</span>}
                                    </span>
                                    {item.description != null && (
                                        <span className="mt-0.5 block text-caption leading-relaxed text-fg-muted">
                                            {item.description}
                                        </span>
                                    )}
                                </span>

                                {typeof item.count === 'number' && (
                                    <CountBadge
                                        count={item.count}
                                        max={item.countMax}
                                        size="sm"
                                        ariaLabel={
                                            item.countAriaLabel ??
                                            (typeof item.label === 'string'
                                                ? `${item.label}: ${item.count}`
                                                : String(item.count))
                                        }
                                        testId={item.testId ? `${item.testId}-count` : undefined}
                                    />
                                )}
                            </button>
                        );
                    })}

                    {items.length === 0 && empty != null && (
                        <div role="presentation" className="px-3 py-4 text-center text-caption text-fg-muted">
                            {empty}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export default Menu;
