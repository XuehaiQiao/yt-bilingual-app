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
import { t } from '../i18n';
import { describeApiError, toast } from './toast';

export interface AuthUser {
    id: string;
    email: string;
    // Since the user-profile contract (specs/023) signup/login/me all carry
    // the display name plus the account's credit balance and state. They are
    // optional so an old backend (or a 401-less guest payload) can never break
    // the shell; call sites fall back to the email prefix.
    username?: string | null;
    credits?: number;
    status?: string;
}

// `guest` is the normal "not logged in" state since M1 ⑧: the backend issues an
// httpOnly `ln_guest` cookie and keeps guest data in an isolated directory, so
// the app can be used (estimate / watch / lookup) before signing up.
export type AuthStatus = 'loading' | 'anonymous' | 'guest' | 'authenticated';

interface AuthContextValue {
    status: AuthStatus;
    user: AuthUser | null;
    /** Backend `isAdmin` flag (`GET /api/auth/me`); drives the admin entry. */
    isAdmin: boolean;
    /** Bumped after a successful guest claim so data-loading effects refetch. */
    dataRevision: number;
    login: (email: string, password: string) => Promise<void>;
    signup: (email: string, password: string, username?: string) => Promise<void>;
    logout: () => Promise<void>;
    /** Rename the signed-in user (`PATCH /api/user/profile`); updates context. */
    updateUsername: (username: string) => Promise<AuthUser>;
}

interface UserPayload {
    user?: AuthUser | null;
    guest?: boolean;
    isAdmin?: boolean;
}

interface ClaimPayload {
    claimed?: boolean;
    merged?: {
        history?: number;
        favorites?: number;
        subscriptions?: number;
    };
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function readUser(res: Response): Promise<AuthUser> {
    const data = (await res.json().catch(() => null)) as UserPayload | null;
    if (!data?.user?.email) {
        throw new Error(t('errors.missingUser'));
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
    // Separate from `user`: the frozen `/api/auth/me` user object stays
    // `{id,email}`, while the admin flag is a top-level field. Keeping it in
    // its own state means an admin flag refresh never rewrites identity.
    const [isAdmin, setIsAdmin] = useState(false);
    const [dataRevision, setDataRevision] = useState(0);
    // Latest status for the 401 listener without re-subscribing on each change.
    // Updated synchronously so a burst of business-request 401s (models,
    // history, favorites…) only signs the user out once and toasts once.
    const statusRef = useRef<AuthStatus>('loading');
    const applyAuthState = useCallback((next: AuthStatus, nextUser: AuthUser | null) => {
        statusRef.current = next;
        setUser(nextUser);
        setStatus(next);
    }, []);

    // Boot: ask the backend who is logged in. A 401 is the legacy anonymous
    // answer; `{guest:true}` is the M1 ⑧ guest state (backend already issued the
    // httpOnly `ln_guest` cookie). Other failures still land on the auth screen
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
                const data = (await res.json().catch(() => null)) as UserPayload | null;
                if (cancelled) return;
                if (!data?.guest && data?.user?.email) {
                    setIsAdmin(data.isAdmin === true);
                    applyAuthState('authenticated', data.user);
                    return;
                }
                setIsAdmin(false);
                applyAuthState('guest', null);
            } catch (err) {
                if (cancelled) return;
                setIsAdmin(false);
                applyAuthState('anonymous', null);
                // Offline is an expected state now that the shell is cached:
                // the global offline marker explains it, so don't claim the
                // backend is down and send the user chasing uvicorn.
                if (navigator.onLine) toast.error(await describeApiError(err));
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
        toast.info(t('errors.sessionExpired'));
        setIsAdmin(false);
        applyAuthState('anonymous', null);
    }), [applyAuthState]);

    // Login/signup responses keep the frozen `{user}` shape, so the admin flag
    // is fetched once after a successful sign-in (the only extra request).
    const syncAdminFlag = useCallback(async () => {
        try {
            const res = await apiFetch('/api/auth/me');
            if (!res.ok) return;
            const data = (await res.json().catch(() => null)) as UserPayload | null;
            setIsAdmin(data?.isAdmin === true);
        } catch {
            // Non-fatal: the app works, only the admin entry may stay hidden.
            setIsAdmin(false);
        }
    }, []);

    // Merge the guest directory into the account (idempotent server-side) and
    // refresh data. Never blocks a successful login: if the merge fails, the
    // guest directory is kept and the next login retries automatically.
    const claimGuest = useCallback(async () => {
        try {
            const res = await apiFetch('/api/auth/claim-guest', { method: 'POST' });
            if (!res.ok) throw new Error(await describeApiError(res));
            const data = (await res.json().catch(() => null)) as ClaimPayload | null;
            const merged = data?.merged;
            const total =
                (merged?.history ?? 0) + (merged?.favorites ?? 0) + (merged?.subscriptions ?? 0);
            if (data?.claimed && total > 0) toast.success(t('guest.claimed'));
        } catch (err) {
            // Keep the user signed in; the guest cookie is still there for a retry.
            console.warn('Guest claim failed:', err);
            toast.info(t('guest.claimFailed'));
        }
    }, []);

    const authenticate = useCallback(async (
        path: '/api/auth/login' | '/api/auth/signup',
        email: string,
        password: string,
        username?: string,
    ) => {
        const res = await apiFetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Signup carries the display name (specs/023); login does not.
            body: JSON.stringify(username === undefined
                ? { email, password }
                : { email, password, username }),
        });
        if (!res.ok) throw new Error(await describeApiError(res));
        const nextUser = await readUser(res);
        await claimGuest();
        setDataRevision((revision) => revision + 1);
        applyAuthState('authenticated', nextUser);
        // Fire-and-forget: the app must not wait on a flag request to finish
        // signing in; the entry appears as soon as `/me` answers.
        void syncAdminFlag();
    }, [applyAuthState, claimGuest, syncAdminFlag]);

    const login = useCallback(
        (email: string, password: string) => authenticate('/api/auth/login', email, password),
        [authenticate],
    );

    const signup = useCallback(
        (email: string, password: string, username?: string) =>
            authenticate('/api/auth/signup', email, password, username),
        [authenticate],
    );

    // Rename (specs/023): the returned user is the new source of truth for the
    // top bar and the account page, so it replaces the context state directly.
    const updateUsername = useCallback(async (username: string) => {
        const res = await apiFetch('/api/user/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username }),
        });
        if (!res.ok) throw new Error(await describeApiError(res));
        const data = (await res.json().catch(() => null)) as UserPayload | null;
        const nextUser = data?.user;
        if (!nextUser?.email) throw new Error(t('errors.missingUser'));
        applyAuthState('authenticated', nextUser);
        return nextUser;
    }, [applyAuthState]);

    const logout = useCallback(async () => {
        try {
            const res = await apiFetch('/api/auth/logout', { method: 'POST' });
            if (!res.ok) throw new Error(await describeApiError(res));
        } catch (err) {
            // Still leave the app locally; warn that the cookie may not have
            // been cleared and could restore the session on the next load.
            toast.error(await describeApiError(err));
        } finally {
            setDataRevision((revision) => revision + 1);
            setIsAdmin(false);
            applyAuthState('anonymous', null);
        }
    }, [applyAuthState]);

    return (
        <AuthContext.Provider value={{ status, user, isAdmin, dataRevision, login, signup, logout, updateUsername }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
    return ctx;
}
