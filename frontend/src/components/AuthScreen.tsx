import { useEffect, useState, type FormEvent } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertCircle, Lock, LogIn, Mail, Ticket, UserPlus, UserRound } from 'lucide-react';
import {
    AuthRequestError,
    DEFAULT_REGISTRATION_CONFIG,
    fetchRegistrationConfig,
    useAuth,
    type RegistrationConfig,
} from '../lib/auth';
import { describeApiError } from '../lib/toast';
import type { TranslationKey } from '../i18n';
import { useI18n } from '../i18n/I18nProvider';
import { usernameProblem } from '../lib/username';
import { cn } from '../lib/cn';
import { LanguageMenu } from './LanguageMenu';
import { PwaInstallButton } from './PwaInstallButton';
import { Button } from './ui/Button';
import { PublicShell } from './ui/PublicShell';

type AuthMode = 'login' | 'signup';

/**
 * Short, non-legalistic G1 facts shown on the signup tab (M4). They live next to
 * the submit button instead of only inside the privacy policy, because these
 * are the conditions a new account actually accepts: invite-only, no email
 * verification, no self-service reset, the 7-day deletion cooldown and the
 * fact that local-video subtitle text is sent to an AI model.
 */
const SIGNUP_DISCLOSURE_KEYS: readonly TranslationKey[] = [
    'auth.signup.disclosure.invite',
    'auth.signup.disclosure.noEmail',
    'auth.signup.disclosure.noRecovery',
    'auth.signup.disclosure.deletion',
    'auth.signup.disclosure.subtitles',
];

/**
 * Login / signup gate. One page, two tabs, one submit path: the AuthProvider
 * owns the request and flips the shell to the app once the backend answers
 * with `{ user }` and the httpOnly session cookie.
 *
 * Since M1 ⑧ the app can also run in guest mode. When `onGuestContinue` is
 * provided (guest-triggered login), a "keep trying" escape hatch appears so
 * the visitor is never trapped behind the login form.
 *
 * The page sits outside the app shell (navigation-model §8.1) and shares
 * `PublicShell` with the welcome page: one document scroll, dvh viewport,
 * 16/24/32 page padding, one bottom safe-area inset. The login/signup segmented
 * control stays local on purpose: this page must not depend on a shared
 * Tabs/Segmented component, but it uses the segmented tokens.
 */
interface AuthScreenProps {
    onGuestContinue?: () => void;
}

function fieldShell(invalid: boolean) {
    return cn(
        'mt-1.5 flex h-control-lg items-center gap-2 rounded-control-lg border bg-surface-2/60 px-3',
        'border-line-subtle transition-[border-color,box-shadow] duration-200 ease-apple',
        // The visible focus ring is owned by the shell, never by the field.
        'focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/15',
        invalid && 'border-danger/40',
    );
}

const FIELD_INPUT =
    // The field itself is transparent and never draws its own ring: the shell
    // owns the visible focus state (`focus-within` above). The explicit
    // suppression only applies inside that shell (A2 T-12 exception).
    'min-w-0 flex-1 border-none bg-transparent text-body text-fg-primary outline-none focus:outline-none placeholder:text-fg-secondary sm:text-ui';

/** Read `?invite=` from the path query or the hash query (`#/login?invite=`). */
function inviteFromUrl(): string {
    if (typeof window === 'undefined') return '';
    const fromParams = (params: URLSearchParams): string => params.get('invite')?.trim() ?? '';
    const search = fromParams(new URLSearchParams(window.location.search));
    if (search) return search;
    const hash = window.location.hash;
    const queryIndex = hash.indexOf('?');
    if (queryIndex === -1) return '';
    return fromParams(new URLSearchParams(hash.slice(queryIndex + 1)));
}

/** Map a backend signup failure to localized copy (stable codes, not text). */
function authErrorKey(error: AuthRequestError): TranslationKey | null {
    switch (error.code) {
        case 'invite_required':
            return 'auth.error.inviteRequired';
        case 'invite_invalid':
            return 'auth.error.inviteInvalid';
        case 'registration_closed':
            return 'auth.error.registrationClosed';
        case 'registration_unavailable':
            return 'auth.error.registrationUnavailable';
        case 'registration_busy':
            return 'auth.error.registrationBusy';
        default:
            break;
    }
    if (error.status === 409) return 'auth.error.emailTaken';
    if (error.status === 429) return 'auth.error.rateLimited';
    return null;
}

export const AuthScreen = ({ onGuestContinue }: AuthScreenProps) => {
    const { login, signup } = useAuth();
    const { t } = useI18n();
    const reduceMotion = useReducedMotion();
    const [mode, setMode] = useState<AuthMode>('login');
    const [email, setEmail] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [usernameError, setUsernameError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [inviteCode, setInviteCode] = useState('');
    const [registration, setRegistration] = useState<RegistrationConfig>(DEFAULT_REGISTRATION_CONFIG);

    // Public switch + one-time URL prefill (`?invite=...`). The backend remains
    // the authority: the client-side check only avoids a pointless request.
    useEffect(() => {
        let cancelled = false;
        const prefill = inviteFromUrl();
        if (prefill) setInviteCode((current) => (current ? current : prefill));
        void fetchRegistrationConfig().then((next) => {
            if (!cancelled) setRegistration(next);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const switchMode = (next: AuthMode) => {
        if (next === mode) return;
        setMode(next);
        setError(null);
        setUsernameError(null);
        setPassword('');
        setConfirmPassword('');
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (isSubmitting) return;

        const trimmedEmail = email.trim();
        if (!trimmedEmail || !password) {
            setError(t('auth.error.missing'));
            return;
        }
        if (mode === 'signup') {
            if (registration.registrationClosed) {
                setError(t('auth.error.registrationClosed'));
                return;
            }
            if (registration.inviteRequired && !inviteCode.trim()) {
                setError(t('auth.error.inviteRequired'));
                return;
            }
            // The display name is required for new accounts (specs/023); the
            // rule lives here so the error appears under the field instead of
            // only surfacing as a generic server message.
            const problem = usernameProblem(username);
            if (problem) {
                setUsernameError(t(problem));
                return;
            }
            if (confirmPassword && confirmPassword !== password) {
                setError(t('auth.error.mismatch'));
                return;
            }
        }

        setError(null);
        setUsernameError(null);
        setIsSubmitting(true);
        try {
            if (mode === 'login') {
                await login(trimmedEmail, password);
            } else {
                await signup(
                    trimmedEmail,
                    password,
                    username,
                    inviteCode.trim() || undefined,
                );
            }
            // Success: the provider switches the shell away from this screen.
        } catch (err) {
            const key = err instanceof AuthRequestError ? authErrorKey(err) : null;
            setError(key ? t(key) : await describeApiError(err));
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <PublicShell
            testId="auth-screen"
            align="center"
            width="form"
            topRight={<LanguageMenu />}
        >
            <div className="flex flex-col items-center">
                <div className="h-12 w-12 overflow-hidden rounded-control-lg ring-1 ring-line-strong">
                    <img src="/hero_icon.png" alt={t('brand.logoAlt')} className="h-full w-full object-cover" />
                </div>
                <h1 className="mt-4 text-page font-semibold tracking-tight text-fg-primary">{t('brand.fullName')}</h1>
                <p className="mt-1 text-ui text-fg-secondary">{t('auth.subtitle')}</p>
            </div>

            <div className="mt-8 rounded-card border border-line-subtle bg-surface/40 p-5 sm:p-6">
                {/* 登录 / 注册 分段控件（设计语言「分段控件」配方）。
                    layoutRoot: the card reflows when the inline error or the
                    confirm-password field appears; without it Framer would
                    project the thumb off the tab. Kept local on purpose for
                    this public-page migration. */}
                <motion.div
                    layoutRoot
                    className="inline-flex w-full items-center rounded-control border border-line-subtle bg-surface-2/80 p-0.5"
                >
                    {([
                        { key: 'login' as const, label: t('auth.tab.login') },
                        { key: 'signup' as const, label: t('auth.tab.signup') },
                    ]).map(option => (
                        <button
                            key={option.key}
                            type="button"
                            data-testid={`auth-tab-${option.key}`}
                            aria-pressed={mode === option.key}
                            onClick={() => switchMode(option.key)}
                            className={cn(
                                'relative flex-1 rounded-control px-3 py-1.5 text-caption font-medium transition-colors',
                                mode === option.key
                                    ? 'text-fg-inverse'
                                    : 'text-fg-secondary hover:text-fg-primary',
                            )}
                        >
                            {mode === option.key && (
                                <motion.span
                                    layoutId="authTabThumb"
                                    data-testid="auth-tab-thumb"
                                    aria-hidden="true"
                                    className="absolute inset-0 rounded-control bg-control"
                                    transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 36 }}
                                />
                            )}
                            <span className="relative">{option.label}</span>
                        </button>
                    ))}
                </motion.div>

                <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
                    {mode === 'signup' && (
                        <div
                            data-testid={registration.registrationClosed
                                ? 'auth-registration-closed'
                                : 'auth-invite-notice'}
                            className={cn(
                                'flex items-start gap-2 rounded-control-lg border p-3 text-caption leading-relaxed',
                                registration.registrationClosed
                                    ? 'border-danger/25 bg-danger/5 text-danger-fg'
                                    : 'border-line-subtle bg-surface-2/60 text-fg-secondary',
                            )}
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>
                                {registration.registrationClosed
                                    ? t('auth.registrationClosedNotice')
                                    : t('auth.inviteNotice')}
                            </span>
                        </div>
                    )}

                    <div>
                        <label htmlFor="auth-email" className="text-caption font-medium text-fg-secondary">
                            {t('auth.email')}
                        </label>
                        <div className={fieldShell(false)}>
                            <Mail className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
                            <input
                                id="auth-email"
                                data-testid="auth-email"
                                name="email"
                                type="email"
                                autoComplete="email"
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="you@example.com"
                                className={FIELD_INPUT}
                            />
                        </div>
                    </div>

                    {mode === 'signup' && !registration.registrationClosed && (
                        <div>
                            <label htmlFor="auth-invite" className="text-caption font-medium text-fg-secondary">
                                {t('auth.invite')}{' '}
                                <span className="text-fg-muted">
                                    {registration.inviteRequired
                                        ? t('auth.required')
                                        : t('auth.optional')}
                                </span>
                            </label>
                            <div className={fieldShell(false)}>
                                <Ticket className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
                                <input
                                    id="auth-invite"
                                    data-testid="auth-invite"
                                    name="inviteCode"
                                    type="text"
                                    autoComplete="off"
                                    spellCheck={false}
                                    required={registration.inviteRequired}
                                    value={inviteCode}
                                    onChange={(event) => {
                                        setInviteCode(event.target.value.toUpperCase());
                                        if (error) setError(null);
                                    }}
                                    placeholder={t('auth.invitePlaceholder')}
                                    className={FIELD_INPUT}
                                />
                            </div>
                            <p
                                data-testid="auth-invite-hint"
                                className="mt-1.5 text-caption leading-relaxed text-fg-secondary"
                            >
                                {registration.inviteRequired
                                    ? t('auth.inviteHintRequired')
                                    : t('auth.inviteHintOptional')}
                            </p>
                        </div>
                    )}

                    {mode === 'signup' && (
                        <div>
                            <label htmlFor="auth-username" className="text-caption font-medium text-fg-secondary">
                                {t('auth.username')}
                            </label>
                            <div className={fieldShell(Boolean(usernameError))}>
                                <UserRound className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
                                <input
                                    id="auth-username"
                                    data-testid="auth-username"
                                    name="username"
                                    type="text"
                                    autoComplete="nickname"
                                    required
                                    aria-invalid={usernameError ? true : undefined}
                                    aria-describedby={usernameError ? 'auth-username-message' : 'auth-username-hint'}
                                    value={username}
                                    onChange={(e) => {
                                        setUsername(e.target.value);
                                        if (usernameError) setUsernameError(null);
                                    }}
                                    placeholder={t('auth.usernamePlaceholder')}
                                    className={FIELD_INPUT}
                                />
                            </div>
                            {usernameError ? (
                                <p
                                    id="auth-username-message"
                                    data-testid="auth-username-error"
                                    role="alert"
                                    className="mt-1.5 flex items-start gap-1.5 text-caption leading-relaxed text-danger-fg"
                                >
                                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
                                    <span>{usernameError}</span>
                                </p>
                            ) : (
                                <p id="auth-username-hint" className="mt-1.5 text-caption leading-relaxed text-fg-secondary">
                                    {t('auth.usernameHint')}
                                </p>
                            )}
                        </div>
                    )}

                    <div>
                        <label htmlFor="auth-password" className="text-caption font-medium text-fg-secondary">
                            {t('auth.password')}
                        </label>
                        <div className={fieldShell(false)}>
                            <Lock className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
                            <input
                                id="auth-password"
                                data-testid="auth-password"
                                name="password"
                                type="password"
                                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                                required
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder={mode === 'login' ? t('auth.passwordPlaceholder.login') : t('auth.passwordPlaceholder.signup')}
                                className={FIELD_INPUT}
                            />
                        </div>
                    </div>

                    {mode === 'signup' && (
                        <div>
                            <label htmlFor="auth-confirm-password" className="text-caption font-medium text-fg-secondary">
                                {t('auth.confirmPassword')}{' '}
                                <span className="text-fg-muted">{t('auth.optional')}</span>
                            </label>
                            <div className={fieldShell(false)}>
                                <Lock className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
                                <input
                                    id="auth-confirm-password"
                                    data-testid="auth-confirm-password"
                                    name="confirm-password"
                                    type="password"
                                    autoComplete="new-password"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    placeholder={t('auth.confirmPasswordPlaceholder')}
                                    className={FIELD_INPUT}
                                />
                            </div>
                        </div>
                    )}

                    {error && (
                        <p
                            data-testid="auth-error"
                            role="alert"
                            className="flex items-start gap-2 text-caption leading-relaxed text-danger-fg"
                        >
                            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
                            <span>{error}</span>
                        </p>
                    )}

                    {mode === 'signup' && (
                        <section
                            data-testid="auth-signup-disclosure"
                            aria-label={t('auth.signup.disclosure.title')}
                            className="rounded-control-lg border border-line-subtle bg-surface-2/40 p-3 text-caption leading-relaxed text-fg-secondary"
                        >
                            <p className="font-semibold text-fg-primary">
                                {t('auth.signup.disclosure.title')}
                            </p>
                            <ul className="mt-2 space-y-1.5">
                                {SIGNUP_DISCLOSURE_KEYS.map((key) => (
                                    <li key={key} className="flex gap-2">
                                        <span
                                            aria-hidden="true"
                                            className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-fg-muted"
                                        />
                                        <span>{t(key)}</span>
                                    </li>
                                ))}
                            </ul>
                            <p className="mt-2.5">{t('auth.signup.disclosure.legal')}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                                <a
                                    href="#/privacy"
                                    data-testid="auth-privacy-link"
                                    className="font-medium text-brand-300 underline underline-offset-2 transition-colors hover:text-brand-400"
                                >
                                    {t('welcome.footer.privacy')}
                                </a>
                                <a
                                    href="#/terms"
                                    data-testid="auth-terms-link"
                                    className="font-medium text-brand-300 underline underline-offset-2 transition-colors hover:text-brand-400"
                                >
                                    {t('welcome.footer.terms')}
                                </a>
                            </div>
                        </section>
                    )}

                    <Button
                        type="submit"
                        variant="primary"
                        size="lg"
                        fullWidth
                        loading={isSubmitting}
                        disabled={mode === 'signup' && registration.registrationClosed}
                        testId="auth-submit"
                        iconLeft={mode === 'login' ? <LogIn /> : <UserPlus />}
                    >
                        {mode === 'login'
                            ? t('auth.submit.login')
                            : registration.registrationClosed
                                ? t('auth.submit.closed')
                                : t('auth.submit.signup')}
                    </Button>
                </form>

                {onGuestContinue && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        fullWidth
                        testId="auth-guest-continue"
                        onClick={onGuestContinue}
                        className="mt-4 min-h-touch"
                    >
                        {t('auth.guestContinue')}
                    </Button>
                )}
            </div>

            {/* On the guest-login overlay the app shell underneath already
                owns the install entry; showing a second one here would
                duplicate the test id and the prompt listener. */}
            {!onGuestContinue && (
                <PwaInstallButton wrapperClassName="mt-6 flex justify-center" />
            )}
        </PublicShell>
    );
};
