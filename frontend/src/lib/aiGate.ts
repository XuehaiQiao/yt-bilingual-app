// Account-only AI entry guard (M7b).
//
// Guests may keep reading cached/public content, but every AI call is an
// account feature: the backend answers 403 `{code:"login_required"}` and the
// frontend must not even start the request. This module is the one place that
// turns "a guest clicked an AI entry" into the app's existing login flow
// (the `onRequestLogin` callback the shell already owns), so every screen
// shows the same prompt and a new auth surface is never invented.
import { t } from '../i18n';
import { toast } from './toast';

/**
 * Returns true when the caller may run an AI request.
 *
 * `blocked` is passed in (instead of the full auth status) so screens that only
 * know `isGuest` can use the same helper as code that reads `useAuth()`.
 * On a guest it opens the existing auth overlay and returns false, letting call
 * sites guard with a single `if (!allowAi(...))`. The overlay is itself the
 * prompt, so no toast is stacked on top of it; a call site with no login entry
 * (defensive) still gets the unified readable toast.
 */
export function allowAi(blocked: boolean, onRequestLogin?: () => void): boolean {
    if (!blocked) return true;
    if (onRequestLogin) {
        onRequestLogin();
    } else {
        toast.info(t('guest.aiLoginRequired'));
    }
    return false;
}
