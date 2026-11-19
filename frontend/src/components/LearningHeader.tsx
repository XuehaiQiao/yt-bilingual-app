// Learning view header (P0 IA §3.5 / §5.4). The old top bar carried the
// word-book and picture-in-picture controls; both move here so the learning
// page stays usable on mobile (where sub views hide the app chrome) and the
// word-book entry is still one click away while watching (§R9). The header
// itself is the shared 48px SubHeader; the controls stay as trailing actions.
import { BookMarked } from 'lucide-react';
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
}

export function LearningHeader({
  title,
  featureLabel,
  onBack,
  parentLabel,
  wordbookCount,
  onOpenWordbook,
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

    </>
  );
}
