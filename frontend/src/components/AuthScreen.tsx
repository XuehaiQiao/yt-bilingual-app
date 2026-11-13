import { useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, Loader2, Lock, LogIn, Mail, UserPlus } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { describeApiError } from '../lib/toast';

type AuthMode = 'login' | 'signup';

/**
 * Login / signup gate. One page, two tabs, one submit path: the AuthProvider
 * owns the request and flips the shell to the app once the backend answers
 * with `{ user }` and the httpOnly session cookie.
 */
export const AuthScreen = () => {
    const { login, signup } = useAuth();
    const [mode, setMode] = useState<AuthMode>('login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const switchMode = (next: AuthMode) => {
        if (next === mode) return;
        setMode(next);
        setError(null);
        setPassword('');
        setConfirmPassword('');
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (isSubmitting) return;

        const trimmedEmail = email.trim();
        if (!trimmedEmail || !password) {
            setError('请输入邮箱和密码。');
            return;
        }
        if (mode === 'signup' && confirmPassword && confirmPassword !== password) {
            setError('两次输入的密码不一致。');
            return;
        }

        setError(null);
        setIsSubmitting(true);
        try {
            if (mode === 'login') {
                await login(trimmedEmail, password);
            } else {
                await signup(trimmedEmail, password);
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
            className="min-h-screen w-full flex items-center justify-center bg-[#09090b] px-6 py-12 text-zinc-100"
        >
            <div className="w-full max-w-sm">
                <div className="flex flex-col items-center mb-8">
                    <div className="w-12 h-12 rounded-[10px] overflow-hidden shadow-md shadow-black/40 ring-1 ring-white/10">
                        <img src="/hero_icon.png" alt="Lingua Nova" className="w-full h-full object-cover" />
                    </div>
                    <h1 className="mt-4 text-2xl font-semibold tracking-tight text-zinc-100">Lingua Nova</h1>
                    <p className="mt-1 text-sm text-zinc-500">登录后继续你的英语学习</p>
                </div>

                <div className="glass-panel rounded-2xl p-6">
                    {/* 登录 / 注册 分段控件（设计语言「分段控件」配方）。
                        layoutRoot: the card reflows when the inline error or the
                        confirm-password field appears; without it Framer would
                        project the thumb off the tab. */}
                    <motion.div layoutRoot className="inline-flex w-full items-center rounded-lg bg-zinc-800/80 p-0.5 border border-white/5">
                        {([
                            { key: 'login' as const, label: '登录' },
                            { key: 'signup' as const, label: '注册' },
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
                            <span className="text-xs font-medium text-zinc-400">邮箱</span>
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

                        <label className="block">
                            <span className="text-xs font-medium text-zinc-400">密码</span>
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
                                    placeholder={mode === 'login' ? '输入密码' : '设置密码'}
                                    className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-zinc-100 placeholder:text-zinc-600"
                                />
                            </div>
                        </label>

                        {mode === 'signup' && (
                            <label className="block">
                                <span className="text-xs font-medium text-zinc-400">
                                    确认密码 <span className="text-zinc-600">（可选）</span>
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
                                        placeholder="再次输入密码"
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
                            {mode === 'login' ? '登录' : '创建账号'}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};
