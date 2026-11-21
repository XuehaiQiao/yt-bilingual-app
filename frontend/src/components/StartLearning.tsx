// "Start learning" input (P0 IA §3.1 block 3 / §3.2 block 2).
//
// The same form serves the Today page (primary action for a fresh user,
// compact one-liner once history exists) and the Content page (its main
// action). One compact mode picker chooses what the single text field means:
//   youtube → paste a YouTube link → the existing estimate dialog
//   search  → natural-language topic → discovery view auto-runs the search
//   read    → article URL or body → reader imports it immediately
// Only the presentation differs between the two variants; the mode, submit
// and keyboard behaviour are shared.
import React, { useState } from 'react';
import { ArrowRight, BookOpen, ChevronDown, Link2, Loader2, Lock, Search } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';

export type StartMode = 'youtube' | 'search' | 'read';

interface StartLearningProps {
  /** `primary` = rounded-full hero input; `compact` = one-line hint input. */
  variant: 'primary' | 'compact';
  /** Hand the trimmed YouTube URL to the page's estimate dialog. */
  onEstimate: (url: string) => void;
  /** Hand a natural-language query to the discovery view (auto-search). */
  onSearch: (query: string) => void;
  /** Hand an article URL or body to the reader (auto-import). */
  onRead: (value: string) => void;
  disabled?: boolean;
  /** Text shown above the compact variant. */
  hint?: string;
  /** Initial mode; YouTube is the documented default. */
  defaultMode?: StartMode;
  /** Guest pre-hint: tell visitors AI needs an account *before* they press it. */
  isGuest?: boolean;
  /** Opens the app's existing login overlay from that pre-hint. */
  onRequestLogin?: () => void;
  /** Secondary entries rendered under the primary input (发现 / 读文章). */
  children?: React.ReactNode;
}

interface ModeMeta {
  icon: React.ReactNode;
  labelKey: TranslationKey;
  placeholderKey: TranslationKey;
  ariaKey: TranslationKey;
  submitKey: TranslationKey;
}

const MODES: Record<StartMode, ModeMeta> = {
  youtube: {
    icon: <Link2 className="w-3.5 h-3.5" />,
    labelKey: 'start.mode.youtube',
    placeholderKey: 'start.placeholder.youtube',
    ariaKey: 'start.aria.youtube',
    submitKey: 'home.startLearning',
  },
  search: {
    icon: <Search className="w-3.5 h-3.5" />,
    labelKey: 'start.mode.search',
    placeholderKey: 'start.placeholder.search',
    ariaKey: 'start.aria.search',
    submitKey: 'start.submit.search',
  },
  read: {
    icon: <BookOpen className="w-3.5 h-3.5" />,
    labelKey: 'start.mode.read',
    placeholderKey: 'start.placeholder.read',
    ariaKey: 'start.aria.read',
    submitKey: 'start.submit.read',
  },
};

const MODE_ORDER: StartMode[] = ['youtube', 'search', 'read'];

export function StartLearning({
  variant,
  onEstimate,
  onSearch,
  onRead,
  disabled = false,
  hint,
  defaultMode = 'youtube',
  isGuest = false,
  onRequestLogin,
  children,
}: StartLearningProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<StartMode>(defaultMode);
  // One draft shared by all modes: switching never loses what was typed. The
  // placeholder/type/submit action changes, the text stays put.
  const [value, setValue] = useState('');

  const meta = MODES[mode];
  const placeholder = t(meta.placeholderKey);
  const submitLabel = t(meta.submitKey);
  const isRead = mode === 'read';

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    if (mode === 'youtube') onEstimate(trimmed);
    else if (mode === 'search') onSearch(trimmed);
    else onRead(trimmed);
  };

  const modePicker = (
    <div className="mb-2.5 flex items-center gap-2 min-w-0">
      <span className="shrink-0 text-[11px] font-medium text-zinc-500">{t('start.modeLabel')}</span>
      <div className="relative inline-flex min-w-0 items-center">
        <span className="pointer-events-none absolute left-2.5 text-zinc-500">{meta.icon}</span>
        <select
          data-testid="start-mode-select"
          aria-label={t('start.modeLabel')}
          disabled={disabled}
          value={mode}
          onChange={(event) => setMode(event.target.value as StartMode)}
          className="appearance-none h-8 max-w-full pl-8 pr-8 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-xs font-medium text-zinc-300 outline-none focus:border-brand/60 focus:ring-2 focus:ring-brand/15 transition-[background-color,border-color,box-shadow,color] duration-200 ease-apple cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {MODE_ORDER.map((item) => (
            <option key={item} value={item}>{t(MODES[item].labelKey)}</option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 w-3.5 h-3.5 text-zinc-500" />
      </div>
    </div>
  );

  // Report 1.1.2: a guest should learn that AI needs an account before typing
  // and pressing the button — not after the request is refused. This is a
  // notice, not a gate: the input stays usable and public/cached content is
  // still browsable. Clicking the entry opens the existing login overlay.
  const guestNotice = isGuest ? (
    <div
      data-testid="guest-ai-notice"
      role="note"
      className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90"
    >
      <Lock className="w-3.5 h-3.5 shrink-0 text-amber-300" aria-hidden="true" />
      <span className="min-w-0 flex-1">{t('guest.aiEntryNotice')}</span>
      {onRequestLogin && (
        <button
          type="button"
          data-testid="guest-ai-login"
          onClick={onRequestLogin}
          className="inline-flex shrink-0 items-center gap-1 h-6 px-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-[11px] font-medium text-amber-100 transition-colors"
        >
          {t('guest.aiEntryLogin')}
          <ArrowRight className="w-3 h-3" />
        </button>
      )}
    </div>
  ) : null;

  const field = (extraClassName: string) =>
    isRead ? (
      <textarea
        id="video-url"
        name="url"
        rows={variant === 'compact' ? 2 : 3}
        required
        disabled={disabled}
        data-testid="video-url-input"
        aria-label={t(meta.ariaKey)}
        className={`w-full min-w-0 resize-y bg-transparent border-none outline-none text-zinc-200 placeholder-zinc-500 px-1 py-1.5 text-sm leading-relaxed ${extraClassName}`}
        placeholder={placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    ) : (
      <input
        id="video-url"
        name="url"
        type={mode === 'youtube' ? 'url' : 'text'}
        required
        disabled={disabled}
        maxLength={mode === 'search' ? 200 : undefined}
        data-testid="video-url-input"
        aria-label={t(meta.ariaKey)}
        className={`w-full min-w-0 bg-transparent border-none outline-none text-zinc-200 placeholder-zinc-500 px-1 py-1.5 text-sm ${extraClassName}`}
        placeholder={placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    );

  if (variant === 'compact') {
    return (
      <div className="rounded-2xl border border-white/5 bg-zinc-900/40 p-3 sm:p-3.5">
        {hint && <p className="mb-2 text-[11px] font-medium text-zinc-500">{hint}</p>}
        {modePicker}
        {guestNotice}
        <form onSubmit={submit} className="flex items-start gap-2">
          <span className="mt-2 text-zinc-500 shrink-0">{meta.icon}</span>
          {field('')}
          <button
            type="submit"
            disabled={disabled || !value.trim()}
            className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 h-8 px-3 mt-0.5 rounded-lg bg-zinc-100 text-zinc-900 text-xs font-semibold hover:bg-white transition-colors disabled:opacity-50"
          >
            {disabled ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : submitLabel}
          </button>
        </form>
      </div>
    );
  }

  return (
    <section
      data-testid="start-learning"
      className="rounded-3xl border border-white/5 bg-zinc-900/40 p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-[17px] font-semibold tracking-tight text-zinc-100">
          {t('content.startTitle')}
        </h3>
        <p className="text-xs leading-relaxed text-zinc-500">{t('content.startHint')}</p>
      </div>
      <div className="mt-4 w-full">
        {modePicker}
        {guestNotice}
        <form onSubmit={submit}>
          <div
            className={`flex gap-2 bg-zinc-900/60 p-1.5 pl-4 sm:pl-5 border border-white/5 focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/15 transition-[border-color,box-shadow] duration-200 ease-apple ${
              isRead ? 'items-end rounded-2xl' : 'items-center rounded-full'
            }`}
          >
            <span className={`text-zinc-400 shrink-0 ${isRead ? 'mb-2' : ''}`}>{meta.icon}</span>
            {field('sm:text-base')}
            <button
              type="submit"
              data-testid="start-submit"
              disabled={disabled || !value.trim()}
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 h-9 px-4 rounded-full bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform,opacity] duration-200 ease-apple disabled:opacity-50"
            >
              {disabled ? <Loader2 className="w-4 h-4 animate-spin" /> : submitLabel}
              {!disabled && !isRead && <ArrowRight className="hidden sm:block w-4 h-4" />}
            </button>
          </div>
        </form>
      </div>
      {children}
    </section>
  );
}
