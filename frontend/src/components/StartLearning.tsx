// "Start learning" link input (P0 IA §3.1 block 3 / §3.2 block 2).
//
// The same paste-a-YouTube-link form serves the Today page (primary action for
// a fresh user, compact one-liner once history exists) and the Content page
// (its main action). Only the presentation differs: the estimate → confirm
// dialog's cost-preview flow is always the one real flow.
import React, { useState } from 'react';
import { ArrowRight, Link2, Loader2, Search } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';

interface StartLearningProps {
  /** `primary` = rounded-full hero input; `compact` = one-line hint input. */
  variant: 'primary' | 'compact';
  /** Hand the trimmed URL to the page's estimate dialog (never process directly). */
  onEstimate: (url: string) => void;
  disabled?: boolean;
  /** Text shown above the compact variant. */
  hint?: string;
  /** Secondary entries rendered under the primary input (发现 / 读文章). */
  children?: React.ReactNode;
}

export function StartLearning({
  variant,
  onEstimate,
  disabled = false,
  hint,
  children,
}: StartLearningProps) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    onEstimate(trimmed);
  };

  if (variant === 'compact') {
    return (
      <div className="rounded-2xl border border-white/5 bg-zinc-900/40 p-3 sm:p-3.5">
        {hint && <p className="mb-2 text-[11px] font-medium text-zinc-500">{hint}</p>}
        <form onSubmit={submit} className="flex items-center gap-2">
          <Link2 className="w-4 h-4 text-zinc-500 shrink-0" />
          <input
            id="video-url"
            name="url"
            type="url"
            required
            disabled={disabled}
            data-testid="video-url-input"
            aria-label={t('today.newContentHint')}
            className="w-full min-w-0 bg-transparent border-none outline-none text-zinc-200 placeholder-zinc-500 px-1 py-1.5 text-sm"
            placeholder={t('today.newContentHint')}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button
            type="submit"
            disabled={disabled || !url.trim()}
            className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 h-8 px-3 rounded-lg bg-zinc-100 text-zinc-900 text-xs font-semibold hover:bg-white transition-colors disabled:opacity-50"
          >
            {disabled ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('home.startLearning')}
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
      <form className="mt-4 w-full" onSubmit={submit}>
        <div className="flex items-center gap-2 rounded-full bg-zinc-900/60 p-1.5 pl-4 sm:pl-5 border border-white/5 focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/15 transition-[border-color,box-shadow] duration-200 ease-apple">
          <Search className="w-4 h-4 text-zinc-400 shrink-0" />
          <input
            id="video-url"
            name="url"
            type="url"
            required
            disabled={disabled}
            data-testid="video-url-input"
            aria-label={t('home.searchPlaceholder')}
            className="w-full min-w-0 bg-transparent border-none outline-none text-zinc-100 placeholder-zinc-500 px-2 py-2.5 text-sm sm:text-base"
            placeholder={t('home.searchPlaceholder')}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button
            type="submit"
            disabled={disabled || !url.trim()}
            className="inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 h-9 px-4 rounded-full bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform,opacity] duration-200 ease-apple disabled:opacity-50"
          >
            {disabled ? <Loader2 className="w-4 h-4 animate-spin" /> : t('home.startLearning')}
            {!disabled && <ArrowRight className="hidden sm:block w-4 h-4" />}
          </button>
        </div>
      </form>
      {children}
    </section>
  );
}
