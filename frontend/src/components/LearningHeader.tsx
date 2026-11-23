// Learning view header (P0 IA §3.5 / §5.4). The header itself is the shared
// 48px SubHeader: back + title + feature label. The word-book entry no longer
// lives here — P1-16 moved it to AppShell's top-bar chip so every page has one
// entry.
import { SubHeader } from './ui/SubHeader';

interface LearningHeaderProps {
  title: string;
  featureLabel: string;
  onBack: () => void;
  /** Parent tab name for the back control's aria label (today / content). */
  parentLabel?: string;
}

export function LearningHeader({
  title,
  featureLabel,
  onBack,
  parentLabel,
}: LearningHeaderProps) {
  return (
    <SubHeader
      title={title}
      onBack={onBack}
      parentLabel={parentLabel}
      meta={<span data-testid="learning-feature" className="hidden lg:inline-flex">{featureLabel}</span>}
      testId="learning-header"
      backTestId="learning-back"
      titleTestId="learning-title"
    />
  );
}
