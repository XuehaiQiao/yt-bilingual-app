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
    /**
     * v1.1 (P2-38): whether the account's email is verified. Optional so an old
     * backend never breaks the shell; the account page only prompts when the
     * server explicitly says `false` (old users are not forced to verify).
     */
    emailVerified?: boolean;
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
    signup: (
        email: string,
        password: string,
        username?: string,
        inviteCode?: string,
    ) => Promise<void>;
    logout: () => Promise<void>;
    /**
     * Local-only reset after the server already revoked every session (account
     * deletion submission). Never calls `/api/auth/logout`: that endpoint would
     * 401 with the cleared cookie and show a misleading error toast.
     */
    clearSession: () => void;
    /**
     * Re-read `GET /api/auth/me` so `user.status` follows the server (e.g.
     * `deletion_pending` → `active` after cancelling a deletion).
     */
    refreshSession: () => Promise<void>;
    /** Rename the signed-in user (`PATCH /api/user/profile`); updates context. */
    updateUsername: (username: string) => Promise<AuthUser>;
}

interface UserPayload {
    user?: AuthUser | null;
    guest?: boolean;
    isAdmin?: boolean;
}

/** Public registration switches (`GET /api/auth/registration`, specs/032). */
export interface RegistrationConfig {
    registrationOpen: boolean;
    inviteSignupEnabled: boolean;
    inviteRequired: boolean;
    registrationClosed: boolean;
}

/** Conservative fallback: G1 production default is invite-only. */
export const DEFAULT_REGISTRATION_CONFIG: RegistrationConfig = {
    registrationOpen: false,
    inviteSignupEnabled: true,
    inviteRequired: true,
    registrationClosed: false,
};

/**
 * Fetch the public registration switches. Failures fall back to the G1
 * default (invite required) so the form never silently offers open signup
 * against a closed backend.
 */
export async function fetchRegistrationConfig(): Promise<RegistrationConfig> {
    try {
        const res = await apiFetch('/api/auth/registration');
        if (!res.ok) return DEFAULT_REGISTRATION_CONFIG;
        const data = (await res.json().catch(() => null)) as Partial<RegistrationConfig> | null;
        if (!data || typeof data.registrationOpen !== 'boolean') {
            return DEFAULT_REGISTRATION_CONFIG;
        }
        return {
            registrationOpen: data.registrationOpen,
            inviteSignupEnabled: data.inviteSignupEnabled !== false,
            inviteRequired: data.inviteRequired === true,
            registrationClosed: data.registrationClosed === true,
        };
    } catch {
        return DEFAULT_REGISTRATION_CONFIG;
    }
}

/**
 * Auth request error that keeps the HTTP status and the backend's stable
 * `code` (`invite_required` / `invite_invalid` / `registration_closed`), so
 * the auth screen can show localized copy instead of parsing Chinese text.
 */
export class AuthRequestError extends Error {
    readonly status: number;
    readonly code?: string;

    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = 'AuthRequestError';
        this.status = status;
        this.code = code;
    }
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

// One browser profile has exactly one backend session (the httpOnly
// `ln_session` cookie is shared by every tab). A second tab signing in or out
// therefore changes the identity of the first tab too. Broadcast that change
// and let the stale tab reload, instead of keeping A's UI while every request
// already runs as B. This is deliberately a reload, not a soft state merge:
// module caches / local-only accumulators are reset with the page.
const AUTH_SYNC_KEY = 'ln_auth_sync_v1';
const AUTH_SYNC_CHANNEL = 'ln-auth-sync-v1';

function announceAuthChange(): void {
    try {
        localStorage.setItem(AUTH_SYNC_KEY, String(Date.now()));
    } catch {
        // Private mode / storage disabled: BroadcastChannel below still works.
    }
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            const channel = new BroadcastChannel(AUTH_SYNC_CHANNEL);
            channel.postMessage('auth-change');
            channel.close();
        }
    } catch {
        // No cross-tab channel: the next page load still uses the new cookie.
    }
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

    // Another tab changed the shared session cookie. Reload this document so
    // the stale account's React state, Today history and local caches cannot
    // survive under the new identity.
    useEffect(() => {
        const reload = () => window.location.reload();
        const onStorage = (event: StorageEvent) => {
            if (event.key === AUTH_SYNC_KEY) reload();
        };
        let channel: BroadcastChannel | null = null;
        try {
            if (typeof BroadcastChannel !== 'undefined') {
                channel = new BroadcastChannel(AUTH_SYNC_CHANNEL);
                channel.addEventListener('message', reload);
            }
        } catch {
            channel = null;
        }
        window.addEventListener('storage', onStorage);
        return () => {
            window.removeEventListener('storage', onStorage);
            try { channel?.close(); } catch { /* already closed */ }
        };
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
        inviteCode?: string,
    ) => {
        const body: Record<string, string> = { email, password };
        // Signup carries the display name (specs/023); login does not.
        if (username !== undefined) body.username = username;
        const trimmedInvite = inviteCode?.trim();
        if (trimmedInvite) body.inviteCode = trimmedInvite;
        const res = await apiFetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const payload = (await res.json().catch(() => null)) as
            | (UserPayload & { detail?: unknown; code?: unknown })
            | null;
        if (!res.ok) {
            const message = typeof payload?.detail === 'string' && payload.detail.trim()
                ? payload.detail
                : t('errors.httpStatus', { status: res.status });
            throw new AuthRequestError(
                message,
                res.status,
                typeof payload?.code === 'string' ? payload.code : undefined,
            );
        }
        const nextUser = payload?.user;
        if (!nextUser?.email) throw new Error(t('errors.missingUser'));
        await claimGuest();
        setDataRevision((revision) => revision + 1);
        applyAuthState('authenticated', nextUser);
        announceAuthChange();
        // Fire-and-forget: the app must not wait on a flag request to finish
        // signing in; the entry appears as soon as `/me` answers.
        void syncAdminFlag();
    }, [applyAuthState, claimGuest, syncAdminFlag]);

    const login = useCallback(
        (email: string, password: string) => authenticate('/api/auth/login', email, password),
        [authenticate],
    );

    const signup = useCallback(
        (email: string, password: string, username?: string, inviteCode?: string) =>
            authenticate('/api/auth/signup', email, password, username, inviteCode),
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
            announceAuthChange();
        }
    }, [applyAuthState]);

    // Account lifecycle (M2b): once a deletion request is accepted the backend
    // has already deleted every session row and cleared the cookie, so this is
    // purely the local half of that sign-out.
    const clearSession = useCallback(() => {
        setDataRevision((revision) => revision + 1);
        setIsAdmin(false);
        applyAuthState('anonymous', null);
        announceAuthChange();
    }, [applyAuthState]);

    // Used after cancelling a deletion: `/api/auth/me` carries `status`, which
    // drives the restricted banner; a failure keeps the current state (a stale
    // banner is recoverable, a spurious sign-out is not).
    const refreshSession = useCallback(async () => {
        try {
            const res = await apiFetch('/api/auth/me');
            if (res.status === 401) {
                setIsAdmin(false);
                applyAuthState('anonymous', null);
                return;
            }
            if (!res.ok) return;
            const data = (await res.json().catch(() => null)) as UserPayload | null;
            if (!data?.guest && data?.user?.email) {
                setIsAdmin(data.isAdmin === true);
                applyAuthState('authenticated', data.user);
            }
        } catch {
            // Keep the current session; the next navigation retries.
        }
    }, [applyAuthState]);

    return (
        <AuthContext.Provider value={{
            status,
            user,
            isAdmin,
            dataRevision,
            login,
            signup,
            logout,
            clearSession,
            refreshSession,
            updateUsername,
        }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
    return ctx;
}
