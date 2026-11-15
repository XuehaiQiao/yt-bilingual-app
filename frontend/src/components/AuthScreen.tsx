import { useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, Loader2, Lock, LogIn, Mail, UserPlus, UserRound } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { describeApiError } from '../lib/toast';
import { useI18n } from '../i18n/I18nProvider';
import { usernameProblem } from '../lib/username';
import { LanguageMenu } from './LanguageMenu';
import { PwaInstallButton } from './PwaInstallButton';

type AuthMode = 'login' | 'signup';

/**
 * Login / signup gate. One page, two tabs, one submit path: the AuthProvider
 * owns the request and flips the shell to the app once the backend answers
 * with `{ user }` and the httpOnly session cookie.
 *
 * Since M1 ⑧ the app can also run in guest mode. When `onGuestContinue` is
 * provided (guest-triggered login), a "keep trying" escape hatch appears so
 * the visitor is never trapped behind the login form.
 */
interface AuthScreenProps {
    onGuestContinue?: () => void;
}

export const AuthScreen = ({ onGuestContinue }: AuthScreenProps) => {
    const { login, signup } = useAuth();
    const { t } = useI18n();
    const [mode, setMode] = useState<AuthMode>('login');
    const [email, setEmail] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [usernameError, setUsernameError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

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
                await signup(trimmedEmail, password, username);
            }
            // Success: the provider switches the shell away from this screen.
        } catch (err) {
            setError(await describeApiError(err));
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div
            data-testid="auth-screen"
            className="relative min-h-screen w-full flex items-center justify-center bg-[#09090b] px-6 py-12 text-zinc-100"
        >
            <div className="absolute top-5 right-5 sm:top-6 sm:right-6 z-20">
                <LanguageMenu />
            </div>
            <div className="w-full max-w-sm">
                <div className="flex flex-col items-center mb-8">
                    <div className="w-12 h-12 rounded-[10px] overflow-hidden shadow-md shadow-black/40 ring-1 ring-white/10">
                        <img src="/hero_icon.png" alt={t('brand.logoAlt')} className="w-full h-full object-cover" />
                    </div>
                    <h1 className="mt-4 text-2xl font-semibold tracking-tight text-zinc-100">{t('brand.fullName')}</h1>
                    <p className="mt-1 text-sm text-zinc-500">{t('auth.subtitle')}</p>
                </div>

                <div className="glass-panel rounded-2xl p-6">
                    {/* 登录 / 注册 分段控件（设计语言「分段控件」配方）。
                        layoutRoot: the card reflows when the inline error or the
                        confirm-password field appears; without it Framer would
                        project the thumb off the tab. */}
                    <motion.div layoutRoot className="inline-flex w-full items-center rounded-lg bg-zinc-800/80 p-0.5 border border-white/5">
                        {([
                            { key: 'login' as const, label: t('auth.tab.login') },
                            { key: 'signup' as const, label: t('auth.tab.signup') },
                        ]).map(option => (
                            <button
                                key={option.key}
                                type="button"
                                data-testid={`auth-tab-${option.key}`}
                                onClick={() => switchMode(option.key)}
                                className={`relative flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                                    mode === option.key
                                        ? 'text-zinc-900'
                                        : 'text-zinc-400 hover:text-zinc-200'
                                }`}
                            >
                                {mode === option.key && (
                                    <motion.span
                                        layoutId="authTabThumb"
                                        data-testid="auth-tab-thumb"
                                        className="absolute inset-0 bg-zinc-100 rounded-md shadow-sm"
                                        transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                                    />
                                )}
                                <span className="relative z-10">{option.label}</span>
                            </button>
                        ))}
                    </motion.div>

                    <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
                        <label className="block">
                            <span className="text-xs font-medium text-zinc-400">{t('auth.email')}</span>
                            <div className="mt-1.5 flex items-center gap-2 h-10 px-3 rounded-xl bg-zinc-800/50 border border-white/5 focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/15 transition-[border-color,box-shadow] duration-200 ease-apple">
                                <Mail className="w-4 h-4 text-zinc-500 shrink-0" />
                                <input
                                    data-testid="auth-email"
                                    name="email"
                                    type="email"
                                    autoComplete="email"
                                    required
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="you@example.com"
                                    className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-zinc-100 placeholder:text-zinc-600"
                                />
                            </div>
                        </label>

                        {mode === 'signup' && (
                            <label className="block">
                                <span className="text-xs font-medium text-zinc-400">{t('auth.username')}</span>
                                <div className="mt-1.5 flex items-center gap-2 h-10 px-3 rounded-xl bg-zinc-800/50 border border-white/5 focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/15 transition-[border-color,box-shadow] duration-200 ease-apple">
                                    <UserRound className="w-4 h-4 text-zinc-500 shrink-0" />
                                    <input
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
                                        className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-zinc-100 placeholder:text-zinc-600"
                                    />
                                </div>
                                {usernameError ? (
                                    <p
                                        id="auth-username-message"
                                        data-testid="auth-username-error"
                                        role="alert"
                                        className="mt-1.5 flex items-start gap-1.5 text-xs text-red-400 leading-relaxed"
                                    >
                                        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                        <span>{usernameError}</span>
                                    </p>
                                ) : (
                                    <p id="auth-username-hint" className="mt-1.5 text-[11px] text-zinc-500 leading-relaxed">
                                        {t('auth.usernameHint')}
                                    </p>
                                )}
                            </label>
                        )}

                        <label className="block">
                            <span className="text-xs font-medium text-zinc-400">{t('auth.password')}</span>
                            <div className="mt-1.5 flex items-center gap-2 h-10 px-3 rounded-xl bg-zinc-800/50 border border-white/5 focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/15 transition-[border-color,box-shadow] duration-200 ease-apple">
                                <Lock className="w-4 h-4 text-zinc-500 shrink-0" />
                                <input
                                    data-testid="auth-password"
                                    name="password"
                                    type="password"
                                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                                    required
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder={mode === 'login' ? t('auth.passwordPlaceholder.login') : t('auth.passwordPlaceholder.signup')}
                                    className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-zinc-100 placeholder:text-zinc-600"
                                />
                            </div>
                        </label>

                        {mode === 'signup' && (
                            <label className="block">
                                <span className="text-xs font-medium text-zinc-400">
                                    {t('auth.confirmPassword')} <span className="text-zinc-600">{t('auth.optional')}</span>
                                </span>
                                <div className="mt-1.5 flex items-center gap-2 h-10 px-3 rounded-xl bg-zinc-800/50 border border-white/5 focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/15 transition-[border-color,box-shadow] duration-200 ease-apple">
                                    <Lock className="w-4 h-4 text-zinc-500 shrink-0" />
                                    <input
                                        data-testid="auth-confirm-password"
                                        name="confirm-password"
                                        type="password"
                                        autoComplete="new-password"
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        placeholder={t('auth.confirmPasswordPlaceholder')}
                                        className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-zinc-100 placeholder:text-zinc-600"
                                    />
                                </div>
                            </label>
                        )}

                        {error && (
                            <p
                                data-testid="auth-error"
                                role="alert"
                                className="flex items-start gap-2 text-sm text-red-400 leading-relaxed"
                            >
                                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                                <span>{error}</span>
                            </p>
                        )}

                        <button
                            type="submit"
                            data-testid="auth-submit"
                            disabled={isSubmitting}
                            className="w-full inline-flex items-center justify-center gap-2 h-10 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform,opacity] duration-200 ease-apple disabled:opacity-50 disabled:pointer-events-none"
                        >
                            {isSubmitting ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : mode === 'login' ? (
                                <LogIn className="w-4 h-4" />
                            ) : (
                                <UserPlus className="w-4 h-4" />
                            )}
                            {mode === 'login' ? t('auth.submit.login') : t('auth.submit.signup')}
                        </button>

                        {onGuestContinue && (
                            <button
                                type="button"
                                data-testid="auth-guest-continue"
                                onClick={onGuestContinue}
                                className="mt-3 w-full text-center text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                            >
                                {t('auth.guestContinue')}
                            </button>
                        )}
                    </form>
                </div>

                {/* On the guest-login overlay the app shell underneath already
                    owns the install entry; showing a second one here would
                    duplicate the test id and the prompt listener. */}
                {!onGuestContinue && (
                    <PwaInstallButton wrapperClassName="mt-6 flex justify-center" />
                )}
            </div>
        </div>
    );
};
