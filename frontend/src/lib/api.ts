// Central API base configuration.
// Override with VITE_API_BASE (e.g. in .env.local or at build time) when the
// backend is not running on the default local address.
export const API_BASE: string =
    (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ||
    'http://127.0.0.1:8000';

export const api = (path: string) => `${API_BASE}${path}`;

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

// `/api/auth/*` owns its own 401s (wrong password, not logged in yet).
// Excluding them keeps the auth screen from triggering a logout loop.
function isAuthEndpoint(path: string): boolean {
    return path === '/api/auth' || path.startsWith('/api/auth/');
}

// fetch() wrapper that attaches the optional VITE_API_KEY as X-API-Key,
// matching the backend's API_AUTH_KEY protection for public deployments.
// `credentials: 'include'` makes the browser send/receive the httpOnly
// `ln_session` cookie on cross-origin dev requests; it defaults to the same
// behaviour for same-origin calls.
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
    const key = import.meta.env.VITE_API_KEY as string | undefined;
    const headers = new Headers(init?.headers);
    if (key) headers.set('X-API-Key', key);
    return fetch(api(path), {
        ...init,
        credentials: 'include',
        headers,
    }).then((res) => {
        if (res.status === 401 && !isAuthEndpoint(path)) {
            unauthorizedListeners.slice().forEach((listener) => {
                try {
                    listener();
                } catch {
                    // A broken listener must never mask the response itself.
                }
            });
        }
        return res;
    });
}
