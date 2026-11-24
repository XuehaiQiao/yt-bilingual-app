// Account recovery + email verification API (v1.1 P0, specs/032/033, P2-38).
//
// The backend contract (P2-38) is:
//   POST /api/auth/password-reset/request   {email}            → 200 {ok:true}
//   POST /api/auth/password-reset/confirm   {token, password}  → 200 {ok:true}; 400/410
//   POST /api/auth/email-verification/request (auth)           → 202 {ok:true}
//   POST /api/auth/email-verification/confirm {token}          → 200 {ok:true}
//
// /request is intentionally not enumerating: the UI always says "if this email
// exists we sent a link", never "unknown email". Errors carry the HTTP status
// and the backend's stable `code` so the screen can show localized copy.
import { apiFetch } from './api';
import { describeApiError } from './toast';
import { translate, type LanguageCode } from '../i18n';

export type AuthLinkKind = 'reset' | 'verify';

export interface AuthLinkToken {
  kind: AuthLinkKind;
  token: string;
}

export class AccountAuthError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'AccountAuthError';
    this.status = status;
    this.code = code;
  }
}

/** Minimum client-side password length; the backend remains the authority. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Read the one-time token an email link drops into the URL:
 *   `#/login?reset=<token>`   → password reset
 *   `#/login?verify=<token>`  → email verification
 * Both the hash query (the app's real URL space) and the search query are
 * accepted so a backend that links to `/login?reset=…` still works.
 */
export function readAuthLinkToken(): AuthLinkToken | null {
  if (typeof window === 'undefined') return null;
  const fromQuery = (query: string): AuthLinkToken | null => {
    if (!query) return null;
    const params = new URLSearchParams(query);
    const reset = params.get('reset')?.trim();
    if (reset) return { kind: 'reset', token: reset };
    const verify = params.get('verify')?.trim();
    if (verify) return { kind: 'verify', token: verify };
    return null;
  };
  const search = fromQuery(window.location.search.replace(/^\?/, ''));
  if (search) return search;
  const hash = window.location.hash;
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return null;
  return fromQuery(hash.slice(queryIndex + 1));
}

/** Remove a consumed token from the URL so a refresh cannot replay it. */
export function clearAuthLinkToken(): void {
  if (typeof window === 'undefined') return;
  const search = window.location.search;
  if (/[?&](reset|verify)=/.test(search)) {
    const params = new URLSearchParams(search);
    params.delete('reset');
    params.delete('verify');
    const rest = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`,
    );
  }
  const hash = window.location.hash;
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return;
  const params = new URLSearchParams(hash.slice(queryIndex + 1));
  if (!params.has('reset') && !params.has('verify')) return;
  params.delete('reset');
  params.delete('verify');
  const rest = params.toString();
  window.history.replaceState(
    window.history.state,
    '',
    `${hash.slice(0, queryIndex)}${rest ? `?${rest}` : ''}`,
  );
}

async function postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null) as
    | { code?: unknown; detail?: unknown }
    | null;
  if (!res.ok) {
    throw new AccountAuthError(
      await describeApiError(res),
      res.status,
      typeof payload?.code === 'string' ? payload.code : undefined,
    );
  }
  return payload;
}

/** True for a syntactically plausible email; the server does real validation. */
export function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

/**
 * Ask for a reset email. Resolves on 200 even when the address is unknown
 * (the backend's anti-enumeration contract); network/5xx failures throw.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await postJson('/api/auth/password-reset/request', { email: email.trim() });
}

/** Set a new password with the one-time token; 400/410 throw typed errors. */
export async function confirmPasswordReset(token: string, password: string): Promise<void> {
  await postJson('/api/auth/password-reset/confirm', { token, password });
}

/** Re-send the verification email to the signed-in user (202). */
export async function requestEmailVerification(): Promise<void> {
  await postJson('/api/auth/email-verification/request', {});
}

/** Confirm an email address with the one-time token. */
export async function confirmEmailVerification(token: string): Promise<void> {
  await postJson('/api/auth/email-verification/confirm', { token });
}

/** Localized message for a typed account-auth failure (password reset). */
export function accountAuthMessage(error: unknown, language: LanguageCode): string {
  if (error instanceof AccountAuthError) {
    if (error.code === 'token_expired' || error.status === 410) {
      return translate(language, 'auth.reset.expired');
    }
    // The merged backend (P2-38) answers 400 both for an invalid token and for a
    // too-short password; the client checks the password first, so the only
    // reachable 400 here is the token one.
    if (error.code === 'token_invalid' || error.status === 400) {
      return translate(language, 'auth.reset.invalid');
    }
    if (error.status === 429) return translate(language, 'auth.error.rateLimited');
    if (error.status === 503) return translate(language, 'auth.recovery.unavailable');
    if (error.message.trim()) return error.message;
  }
  if (error instanceof TypeError) {
    // fetch() rejects with TypeError when the server is unreachable.
    return translate(language, 'auth.recovery.offline');
  }
  return translate(language, 'auth.recovery.failed');
}

/**
 * Localized message for a failed email-verification link. Kept separate from
 * `accountAuthMessage` because a 400/410 here is a verification link problem,
 * never "reset link invalid" copy.
 */
export function emailVerificationMessage(error: unknown, language: LanguageCode): string {
  if (error instanceof AccountAuthError) {
    if (error.status === 400 || error.status === 410) {
      return translate(language, 'auth.verify.error');
    }
    if (error.status === 503) return translate(language, 'auth.recovery.unavailable');
    if (error.status === 429) return translate(language, 'auth.error.rateLimited');
    if (error.message.trim()) return error.message;
  }
  if (error instanceof TypeError) return translate(language, 'auth.recovery.offline');
  return translate(language, 'auth.verify.error');
}
