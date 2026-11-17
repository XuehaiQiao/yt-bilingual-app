// Learning view header (P0 IA §3.5 / §5.4). The old top bar carried the
// word-book and picture-in-picture controls; both move here so the learning
// page stays usable on mobile (where sub views hide the app chrome) and the
// word-book entry is still one click away while watching (§R9).
import { ArrowLeft, BookMarked, ExternalLink } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';

interface LearningHeaderProps {
  title: string;
  featureLabel: string;
  onBack: () => void;
  wordbookCount: number;
  onOpenWordbook: () => void;
  /** PiP is offered whenever a player is live (the handler explains failures). */
  showPip: boolean;
  pipActive: boolean;
  onTogglePip: () => void;
}

export function LearningHeader({
  title,
  featureLabel,
  onBack,
  wordbookCount,
  onOpenWordbook,
  showPip,
  pipActive,
  onTogglePip,
}: LearningHeaderProps) {
  const { t } = useI18n();
  return (
    <header
      data-testid="learning-header"
      className="flex-none h-12 flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 border-b border-white/5 bg-zinc-950/60 backdrop-blur-xl z-20"
    >
      <button
        type="button"
        data-testid="learning-back"
        onClick={onBack}
        aria-label={t('nav.back')}
        title={t('nav.back')}
        className="inline-flex items-center gap-1.5 h-9 px-2 rounded-lg text-sm font-medium text-zinc-300 hover:text-zinc-100 hover:bg-white/5 transition-colors shrink-0"
      >
        <ArrowLeft className="w-4 h-4" />
        <span className="hidden sm:inline">{t('nav.back')}</span>
      </button>

      <div className="flex-1 min-w-0 flex items-center gap-2">
        <p
          data-testid="learning-title"
          className="min-w-0 truncate text-sm font-medium text-zinc-200"
          title={title}
        >
          {title}
        </p>
        <span className="hidden lg:inline-flex items-center whitespace-nowrap text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-800/50 border border-white/5 text-zinc-400 shrink-0">
          {featureLabel}
        </span>
      </div>

      <button
        type="button"
        data-testid="learning-wordbook"
        onClick={onOpenWordbook}
        aria-label={t('topbar.wordbook', { count: wordbookCount })}
        title={t('topbar.wordbook', { count: wordbookCount })}
        className="inline-flex items-center gap-1.5 h-9 px-2 sm:px-3 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-300 hover:text-zinc-100 transition-colors shrink-0"
      >
        <BookMarked className="w-4 h-4 text-amber-400/90" />
        <span className="hidden sm:inline text-xs font-medium whitespace-nowrap">{t('vocab.title')}</span>
        <span className="text-xs font-medium tabular-nums">{wordbookCount}</span>
      </button>

      {showPip && (
        <button
          type="button"
          data-testid="learning-pip"
          onClick={onTogglePip}
          aria-label={pipActive ? t('topbar.closePopOut') : t('topbar.popOut')}
          title={pipActive ? t('topbar.closePopOut') : t('topbar.popOut')}
          className="inline-flex items-center gap-1.5 h-9 px-2 sm:px-3 rounded-xl bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-blue-400 transition-colors shrink-0"
        >
          <ExternalLink className="w-4 h-4" />
          <span className="hidden sm:inline text-xs font-medium">
            {pipActive ? t('topbar.closePopOut') : t('topbar.popOut')}
          </span>
        </button>
      )}
    </header>
  );
}
