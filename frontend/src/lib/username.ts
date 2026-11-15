// Display-name rules shared by signup (AuthScreen) and the account page.
//
// The backend (`backend/account.py:validate_username`) is the source of truth;
// this mirror exists so the form can point at the exact broken rule before a
// round trip. Keep the two in sync: 2–24 Unicode characters, Chinese (basic +
// extension A) / Latin letters / digits / `_` / `-`, no leading/trailing space.
import type { TranslationKey } from '../i18n';

export const USERNAME_MIN_LENGTH = 2;
export const USERNAME_MAX_LENGTH = 24;
export const USERNAME_PATTERN = /^[A-Za-z0-9_\-\u3400-\u4dbf\u4e00-\u9fff]+$/;

export type UsernameProblem = Extract<
    TranslationKey,
    | 'auth.error.usernameRequired'
    | 'auth.error.usernameWhitespace'
    | 'auth.error.usernameTooShort'
    | 'auth.error.usernameTooLong'
    | 'auth.error.usernameInvalid'
>;

/** First rule the typed display name breaks, or null when it is valid. */
export function usernameProblem(raw: string): UsernameProblem | null {
    if (raw.trim().length === 0) return 'auth.error.usernameRequired';
    if (raw !== raw.trim()) return 'auth.error.usernameWhitespace';
    // Count Unicode code points, not UTF-16 units, so an emoji-free name with
    // non-BMP characters would still be measured the way Python measures it.
    const length = Array.from(raw).length;
    if (length < USERNAME_MIN_LENGTH) return 'auth.error.usernameTooShort';
    if (length > USERNAME_MAX_LENGTH) return 'auth.error.usernameTooLong';
    if (!USERNAME_PATTERN.test(raw)) return 'auth.error.usernameInvalid';
    return null;
}

/**
 * What the UI calls the current user: the display name, else the email prefix
 * (the backend backfills old accounts the same way).
 */
export function displayUsername(
    username: string | null | undefined,
    email: string | null | undefined,
): string {
    const name = (username ?? '').trim();
    if (name) return name;
    const prefix = (email ?? '').split('@')[0]?.trim();
    return prefix || (email ?? '').trim();
}

/** First visible character for the avatar placeholder. */
export function usernameInitial(value: string): string {
    return Array.from(value.trim())[0]?.toUpperCase() ?? '';
}
