// Learning view header (P0 IA §3.5 / §5.4). The old top bar carried the
// word-book and picture-in-picture controls; both move here so the learning
// page stays usable on mobile (where sub views hide the app chrome) and the
// word-book entry is still one click away while watching (§R9). The header
// itself is the shared 48px SubHeader; the controls stay as trailing actions.
import { BookMarked, ExternalLink } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { SubHeader } from './ui/SubHeader';

interface LearningHeaderProps {
  title: string;
  featureLabel: string;
  onBack: () => void;
  /** Parent tab name for the back control's aria label (today / content). */
  parentLabel?: string;
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
  parentLabel,
  wordbookCount,
  onOpenWordbook,
  showPip,
  pipActive,
  onTogglePip,
}: LearningHeaderProps) {
  const { t } = useI18n();

  const actions = (
    <button
      type="button"
      data-testid="learning-wordbook"
      onClick={onOpenWordbook}
      aria-label={t('topbar.wordbook', { count: wordbookCount })}
      title={t('topbar.wordbook', { count: wordbookCount })}
      className="inline-flex items-center gap-1.5 h-9 px-2 sm:px-3 rounded-control bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-300 hover:text-zinc-100 transition-colors shrink-0"
    >
      <BookMarked className="w-4 h-4 text-amber-400/90" />
      <span className="hidden sm:inline text-xs font-medium whitespace-nowrap">{t('vocab.title')}</span>
      <span className="text-xs font-medium tabular-nums">{wordbookCount}</span>
    </button>
  );

  return (
    <>
      <SubHeader
        title={title}
        onBack={onBack}
        parentLabel={parentLabel}
        meta={<span data-testid="learning-feature" className="hidden lg:inline-flex">{featureLabel}</span>}
        actions={actions}
        testId="learning-header"
        backTestId="learning-back"
        titleTestId="learning-title"
      />

      {/* PiP is a tool, not page chrome (A2 §6.3): it sits in the content's
          second row, so the 48px header stays back + title + word book. */}
      {showPip && (
        <div
          data-testid="learning-toolbar"
          className="flex flex-none items-center justify-end gap-2 border-b border-white/5 bg-zinc-950/40 px-4 py-2"
        >
          <button
            type="button"
            data-testid="learning-pip"
            onClick={onTogglePip}
            aria-label={pipActive ? t('topbar.closePopOut') : t('topbar.popOut')}
            title={pipActive ? t('topbar.closePopOut') : t('topbar.popOut')}
            className="inline-flex h-9 items-center gap-1.5 rounded-control border border-brand/20 bg-brand/10 px-3 text-xs font-medium text-brand-300 transition-colors hover:bg-brand/15 shrink-0"
          >
            <ExternalLink className="w-4 h-4" />
            {pipActive ? t('topbar.closePopOut') : t('topbar.popOut')}
          </button>
        </div>
      )}
    </>
  );
}
