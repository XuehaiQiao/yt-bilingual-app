// Central API base configuration.
// Override with VITE_API_BASE (e.g. in .env.local or at build time) when the
// backend is not running on the default local address.
import { getRuntimeTargetLang, type LanguageCode } from '../i18n';

export const API_BASE: string =
    (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ||
    'http://127.0.0.1:8000';

export const api = (path: string) => `${API_BASE}${path}`;

// ── Translation target language injection ────────────────────────────────
// Every endpoint that reads or writes translated content is scoped by
// `targetLang` (specs/012 §6.2). Keeping the list here — rather than sixteen
// copies in call sites — is what guarantees a new request path cannot silently
// forget the setting. HTTP uses camelCase `targetLang`; the snake_case
// `target_lang` exists only inside cache files/prompts.
const TARGET_LANG_QUERY_PATHS = new Set([
    '/api/models',
    '/api/recommendations',
    '/api/estimate-cost',
    '/api/history',
    '/api/review/queue',
    // Omitting `targetLang` on the stats endpoint means "all languages"; the
    // home card must match the deck, so it is always injected here.
    '/api/review/stats',
]);
// History detail/delete share the prefix; shows processed is the only
// language-scoped endpoint under /api/shows.
const TARGET_LANG_QUERY_PREFIXES = ['/api/history/'];
const TARGET_LANG_QUERY_PATTERN = /^\/api\/shows\/[^/]+\/processed$/;
// POST bodies the backend parses for `targetLang`.
const TARGET_LANG_BODY_PATHS = new Set([
    '/api/process-video',
    '/api/process-video-stream',
    '/api/process-subtitle',
    '/api/define',
    '/api/review/words',
    '/api/review/answer',
    '/api/review/suspend',
    // specs/014-quiz: question generation is language-scoped; the lesson id
    // scopes the remaining endpoints, so they do not take targetLang.
    '/api/lesson/start',
    // specs/030: generated courses are cached by content + level + target
    // language; the endpoint treats targetLang as optional (default zh-CN) but
    // the UI must send its current language so vi users do not get zh lessons.
    '/api/course/generate',
]);

function endpointPath(path: string): string {
    const queryIndex = path.indexOf('?');
    return queryIndex === -1 ? path : path.slice(0, queryIndex);
}

function requiresTargetLangQuery(path: string): boolean {
    const pathname = endpointPath(path);
    return (
        TARGET_LANG_QUERY_PATHS.has(pathname) ||
        TARGET_LANG_QUERY_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
        TARGET_LANG_QUERY_PATTERN.test(pathname)
    );
}

/**
 * Attach `targetLang` to the endpoints that take it as a query parameter
 * (models, estimate, history/resume, local-show processed marks). An explicit
 * value already on the path wins, so callers can override when needed.
 */
export function withTargetLang(
    path: string,
    targetLang: LanguageCode = getRuntimeTargetLang(),
): string {
    if (!requiresTargetLangQuery(path) || /(?:[?&])targetLang=/.test(path)) return path;
    return `${path}${path.includes('?') ? '&' : '?'}targetLang=${encodeURIComponent(targetLang)}`;
}

/**
 * Merge `targetLang` into a JSON request body for process/define endpoints.
 * Non-string bodies, non-JSON bodies and explicitly-set values are left alone.
 */
export function withTargetLangBody(
    path: string,
    init: RequestInit | undefined,
    targetLang: LanguageCode = getRuntimeTargetLang(),
): RequestInit | undefined {
    if (!init || typeof init.body !== 'string' || !TARGET_LANG_BODY_PATHS.has(endpointPath(path))) {
        return init;
    }
    let payload: unknown;
    try {
        payload = JSON.parse(init.body);
    } catch {
        return init;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return init;
    const record = payload as Record<string, unknown>;
    if ('targetLang' in record || 'target_lang' in record) return init;
    return { ...init, body: JSON.stringify({ ...record, targetLang }) };
}

type UnauthorizedListener = () => void;


let unauthorizedListeners: UnauthorizedListener[] = [];

/**
 * Subscribe to "a business endpoint answered 401" — the httpOnly session
 * expired or was revoked. The auth provider listens once and switches the app
 * back to the auth screen without a reload.
 */
export function subscribeToUnauthorized(listener: UnauthorizedListener): () => void {
    unauthorizedListeners.push(listener);
    return () => {
        unauthorizedListeners = unauthorizedListeners.filter(l => l !== listener);
    };
}

// ── Insufficient balance (402, M3b / specs/034) ─────────────────────────
//
// 402 is a billing state, not an auth state: it must never sign the user out
// (only 401 does). Every AI call funnels through `apiFetch`, so this is the one
// place that can surface the shortfall for all of them. The app shell listens
// once and renders a persistent banner with a link to the account page; call
// sites still get their normal Response and can show inline copy.

export interface InsufficientBalanceNotice {
    /** HTTP status (always 402; carried so callers can log the shape). */
    status: number;
    balanceMicroUsd?: number;
    availableMicroUsd?: number;
    requiredMicroUsd?: number;
}

type InsufficientBalanceListener = (notice: InsufficientBalanceNotice) => void;

let insufficientBalanceListeners: InsufficientBalanceListener[] = [];

export function subscribeToInsufficientBalance(
    listener: InsufficientBalanceListener,
): () => void {
    insufficientBalanceListeners.push(listener);
    return () => {
        insufficientBalanceListeners = insufficientBalanceListeners.filter(l => l !== listener);
    };
}

/** Fan out a 402 shortfall (also used for the SSE `error` event path). */
export function notifyInsufficientBalance(
    notice: Omit<InsufficientBalanceNotice, 'status'> & { status?: number },
): void {
    const payload: InsufficientBalanceNotice = { ...notice, status: notice.status ?? 402 };
    insufficientBalanceListeners.slice().forEach((listener) => {
        try {
            listener(payload);
        } catch {
            // A broken listener must never mask the response itself.
        }
    });
}

// `/api/auth/*` owns its own 401s (wrong password, not logged in yet).
// Excluding them keeps the auth screen from triggering a logout loop.
function isAuthEndpoint(path: string): boolean {
    return path === '/api/auth' || path.startsWith('/api/auth/');
}

// Account lifecycle password confirmations also answer 401 — with
// `code: "password_invalid"`, not an expired session (specs/033 §9). Firing the
// global unauthorized hook on that would sign the user out for mistyping a
// password; a genuine missing session still answers `auth_required` and does
// sign out. The body is only read for 401s on this prefix.
async function isPasswordRejection(response: Response): Promise<boolean> {
    const body = await response.clone().json().catch(() => null);
    return body?.code === 'password_invalid';
}

// fetch() wrapper that attaches the optional VITE_API_KEY as X-API-Key,
// matching the backend's API_AUTH_KEY protection for public deployments.
// `credentials: 'include'` makes the browser send/receive the httpOnly
// `ln_session` cookie on cross-origin dev requests; it defaults to the same
// behaviour for same-origin calls. Every call also gets the current
// translation target language where the endpoint accepts it.
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
    const key = import.meta.env.VITE_API_KEY as string | undefined;
    const targetLang = getRuntimeTargetLang();
    const resolvedPath = withTargetLang(path, targetLang);
    const resolvedInit = withTargetLangBody(path, init, targetLang);
    const headers = new Headers(resolvedInit?.headers);
    if (key) headers.set('X-API-Key', key);
    return fetch(api(resolvedPath), {
        ...resolvedInit,
        credentials: 'include',
        headers,
    }).then(async (res) => {
        if (res.status === 401 && !isAuthEndpoint(path)) {
            const isAccountPath = path === '/api/account' || path.startsWith('/api/account/');
            if (isAccountPath && await isPasswordRejection(res)) {
                return res;
            }
            unauthorizedListeners.slice().forEach((listener) => {
                try {
                    listener();
                } catch {
                    // A broken listener must never mask the response itself.
                }
            });
        }
        // 402 is not a session problem: no logout, no 500 copy. Only the
        // billing code is surfaced; other 402s stay with their call site.
        if (res.status === 402 && !isAuthEndpoint(path)) {
            const body = await res.clone().json().catch(() => null);
            if (body?.code === 'insufficient_balance') {
                notifyInsufficientBalance({
                    status: res.status,
                    balanceMicroUsd: typeof body.balanceMicroUsd === 'number'
                        ? body.balanceMicroUsd
                        : undefined,
                    availableMicroUsd: typeof body.availableMicroUsd === 'number'
                        ? body.availableMicroUsd
                        : undefined,
                    requiredMicroUsd: typeof body.requiredMicroUsd === 'number'
                        ? body.requiredMicroUsd
                        : undefined,
                });
            }
        }
        return res;
    });
}
