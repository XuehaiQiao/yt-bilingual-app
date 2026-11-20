// Minimal pub/sub toast bus — components call toast.error(...) from anywhere,
// the <Toaster /> mounted in App renders the stack. Messages are localized at
// the moment they are emitted (the runtime language singleton is read here).
//
// Rules live here (A2 C8 / A3 IX-08) so the renderer stays a dumb view:
// per-type lifetime, same-key dedupe window, long/actionable error persistence.
import { t, type TranslationKey } from '../i18n';

export type ToastType = 'error' | 'success' | 'info';

export interface ToastAction {
    label: string;
    onClick: () => void;
}

export interface ToastOptions {
    /** Lifetime in ms. `0` (or `Infinity`) keeps the toast until it is closed. */
    duration?: number;
    /** Optional inline action («重试» / «撤销»); clicking it runs the callback, then closes the toast. */
    action?: ToastAction;
    /** Dedupe bucket; defaults to `type + message`. A repeat within 5 s refreshes the existing toast. */
    dedupeKey?: string;
}

export interface ToastItem {
    id: number;
    message: string;
    type: ToastType;
    dedupeKey: string;
    /** Resolved lifetime in ms; `Infinity` = manual dismissal only. */
    duration: number;
    action?: ToastAction;
    /** Emission timestamp. A dedupe hit bumps it so the card restarts its timer. */
    emittedAt: number;
}

type Listener = (item: ToastItem) => void;

/** C8: success 3 s / info 5 s / error 8 s. */
export const TOAST_TTL_MS: Record<ToastType, number> = {
    success: 3000,
    info: 5000,
    error: 8000,
};

/** C8 / IX-08: the same `type + message` (or explicit key) is deduped within 5 s. */
export const TOAST_DEDUPE_WINDOW_MS = 5000;

/** C8: at most three visible at once; the rest wait in a FIFO queue. */
export const TOAST_MAX_VISIBLE = 3;

/** IX-08: errors longer than this stay until the user closes them. */
export const TOAST_LONG_ERROR_CHARS = 120;

/**
 * Resolve the lifetime for one emission.
 * An explicit `duration` always wins. Otherwise long errors and errors with an
 * action stay open until the user dismisses them (the copy cannot be read in 8 s).
 */
export function resolveToastDuration(
    type: ToastType,
    message: string,
    options?: Pick<ToastOptions, 'duration' | 'action'>,
): number {
    const explicit = options?.duration;
    if (explicit !== undefined) return explicit > 0 ? explicit : Infinity;
    if (type === 'error' && (options?.action || Array.from(message).length > TOAST_LONG_ERROR_CHARS)) {
        return Infinity;
    }
    return TOAST_TTL_MS[type];
}

let listeners: Listener[] = [];
let nextId = 1;

function emit(type: ToastType, message: string, options?: ToastOptions) {
    const item: ToastItem = {
        id: nextId++,
        type,
        message,
        dedupeKey: options?.dedupeKey ?? `${type}:${message}`,
        duration: resolveToastDuration(type, message, options),
        action: options?.action,
        emittedAt: Date.now(),
    };
    // Copy first: a listener may unsubscribe while the fan-out is running.
    listeners.slice().forEach((listener) => listener(item));
}

export const toast = {
    error: (message: string, options?: ToastOptions) => emit('error', message, options),
    success: (message: string, options?: ToastOptions) => emit('success', message, options),
    info: (message: string, options?: ToastOptions) => emit('info', message, options),
};

export function subscribeToToasts(fn: Listener): () => void {
    listeners.push(fn);
    return () => {
        listeners = listeners.filter((listener) => listener !== fn);
    };
}

// Dev-only bridge so the acceptance script can emit deterministic toasts
// without touching every call site. Vite strips this from production builds.
if (import.meta.env.DEV && typeof window !== 'undefined') {
    window.__linguaToast = toast;
}

declare global {
    interface Window {
        __linguaToast?: typeof toast;
    }
}

/**
 * Stable backend error codes that have local copy. Only codes carrying a
 * user-facing meaning belong here; everything else keeps the server's `detail`
 * (validation errors, invite codes, …) so support copy is never swallowed.
 */
const API_ERROR_KEYS: Record<string, TranslationKey> = {
    // Account in the 7-day deletion cooldown: business APIs answer 403.
    account_pending_deletion: 'errors.accountPendingDeletion',
};

/** Extract a human-readable message from a fetch Response / Error. */
export async function describeApiError(resOrErr: Response | unknown): Promise<string> {
    if (resOrErr instanceof Response) {
        const body = await resOrErr.json().catch(() => null);
        if (body?.code && typeof body.code === 'string') {
            const key = API_ERROR_KEYS[body.code];
            if (key) return t(key);
        }
        if (body?.detail && typeof body.detail === 'string') return body.detail;
        return t('errors.httpStatus', { status: resOrErr.status });
    }
    if (resOrErr instanceof TypeError) {
        // fetch network-level failure
        return t('errors.network');
    }
    if (resOrErr instanceof Error && resOrErr.message) return resOrErr.message;
    return t('errors.unknown');
}
