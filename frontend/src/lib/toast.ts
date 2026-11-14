// Minimal pub/sub toast bus — components call toast.error(...) from anywhere,
// the <Toaster /> mounted in App renders the stack. Messages are localized at
// the moment they are emitted (the runtime language singleton is read here).
import { t } from '../i18n';
export interface ToastItem {
    id: number;
    message: string;
    type: 'error' | 'success' | 'info';
}

type Listener = (t: ToastItem) => void;

let listeners: Listener[] = [];
let nextId = 1;

function emit(type: ToastItem['type'], message: string) {
    const item: ToastItem = { id: nextId++, message, type };
    listeners.forEach(l => l(item));
}

export const toast = {
    error: (message: string) => emit('error', message),
    success: (message: string) => emit('success', message),
    info: (message: string) => emit('info', message),
};

export function subscribeToToasts(fn: Listener): () => void {
    listeners.push(fn);
    return () => {
        listeners = listeners.filter(l => l !== fn);
    };
}

/** Extract a human-readable message from a fetch Response / Error. */
export async function describeApiError(resOrErr: Response | unknown): Promise<string> {
    if (resOrErr instanceof Response) {
        const body = await resOrErr.json().catch(() => null);
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
