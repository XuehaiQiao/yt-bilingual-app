/* eslint-disable react-refresh/only-export-components -- the provider and its hook are one unit by design */
// Authentication state for the whole app.
//
// The backend owns the session: it sets an httpOnly `ln_session` cookie that
// JavaScript can never read, so "who am I" is always answered by
// `GET /api/auth/me` instead of localStorage. This provider is the single
// source of truth the app shell and the top bar read from.
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { apiFetch, subscribeToUnauthorized } from './api';
import { describeApiError, toast } from './toast';

export interface AuthUser {
    id: string;
    email: string;
}

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

interface AuthContextValue {
    status: AuthStatus;
    user: AuthUser | null;
    login: (email: string, password: string) => Promise<void>;
    signup: (email: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
}

interface UserPayload {
    user?: AuthUser;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function readUser(res: Response): Promise<AuthUser> {
    const data = (await res.json().catch(() => null)) as UserPayload | null;
    if (!data?.user?.email) {
        throw new Error('认证响应缺少用户信息，请检查后端契约。');
    }
    return data.user;
}

/**
 * Owns the session state. Mount it once, above the app shell:
 * `GET /api/auth/me` decides between the auth screen and the app, while any
 * business-endpoint 401 flips the same state back to `anonymous` in place
 * (no reload, no white screen).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
    const [status, setStatus] = useState<AuthStatus>('loading');
    const [user, setUser] = useState<AuthUser | null>(null);
    // Latest status for the 401 listener without re-subscribing on each change.
    // Updated synchronously so a burst of business-request 401s (models,
    // history, favorites…) only signs the user out once and toasts once.
    const statusRef = useRef<AuthStatus>('loading');
    const applyAuthState = useCallback((next: AuthStatus, nextUser: AuthUser | null) => {
        statusRef.current = next;
        setUser(nextUser);
        setStatus(next);
    }, []);

    // Boot: ask the backend who is logged in. A 401 is the normal anonymous
    // answer; any other failure is surfaced but still lands on the auth screen
    // instead of blocking the app behind a dead backend.
    useEffect(() => {
        let cancelled = false;
        const bootstrap = async () => {
            try {
                const res = await apiFetch('/api/auth/me');
                if (cancelled) return;
                if (res.status === 401) {
                    applyAuthState('anonymous', null);
                    return;
                }
                if (!res.ok) throw new Error(await describeApiError(res));
                const nextUser = await readUser(res);
                if (cancelled) return;
                applyAuthState('authenticated', nextUser);
            } catch (err) {
                if (cancelled) return;
                toast.error(await describeApiError(err));
                applyAuthState('anonymous', null);
            }
        };
        void bootstrap();
        return () => {
            cancelled = true;
        };
    }, [applyAuthState]);

    // Global 401: apiFetch excludes `/api/auth/*`, so a failed login/signup
    // (which is a 401) can never re-enter this handler and loop.
    useEffect(() => subscribeToUnauthorized(() => {
        if (statusRef.current !== 'authenticated') return;
        toast.info('登录状态已过期，请重新登录。');
        applyAuthState('anonymous', null);
    }), [applyAuthState]);

    const authenticate = useCallback(async (
        path: '/api/auth/login' | '/api/auth/signup',
        email: string,
        password: string,
    ) => {
        const res = await apiFetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        if (!res.ok) throw new Error(await describeApiError(res));
        const nextUser = await readUser(res);
        applyAuthState('authenticated', nextUser);
    }, [applyAuthState]);

    const login = useCallback(
        (email: string, password: string) => authenticate('/api/auth/login', email, password),
        [authenticate],
    );

    const signup = useCallback(
        (email: string, password: string) => authenticate('/api/auth/signup', email, password),
        [authenticate],
    );

    const logout = useCallback(async () => {
        try {
            const res = await apiFetch('/api/auth/logout', { method: 'POST' });
            if (!res.ok) throw new Error(await describeApiError(res));
        } catch (err) {
            // Still leave the app locally; warn that the cookie may not have
            // been cleared and could restore the session on the next load.
            toast.error(await describeApiError(err));
        } finally {
            applyAuthState('anonymous', null);
        }
    }, [applyAuthState]);

    return (
        <AuthContext.Provider value={{ status, user, login, signup, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
    return ctx;
}
