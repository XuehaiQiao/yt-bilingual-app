// The single sub-view header (design-system/components.md C12, layout.md
// §6.1): fixed 48px, back on the left, 17px title, optional meta and at most
// one primary trailing action. Toolbars never live here — they sit in the
// content area's second row, so the header never wraps (L-12).
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { BackButton } from './BackButton';

export interface SubHeaderProps {
  title: string;
  /** Navigation action fired by the left back control. */
  onBack: () => void;
  /** Parent screen name used by the back control's aria label. */
  parentLabel?: string;
  /** Overrides the composed "返回<父级>" aria label. */
  backAriaLabel?: string;
  /** Overrides the visible back text (defaults to the localized "返回"). */
  backLabel?: string;
  /** Optional 11px source/level badge next to the title. */
  meta?: ReactNode;
  /** At most one primary action; the layout keeps it on a single line. */
  actions?: ReactNode;
  /** Header testid, kept from the screen's existing contract when available. */
  testId?: string;
  backTestId?: string;
  titleTestId?: string;
  /** Reader screens already render the article title as the page h1. */
  titleAs?: 'h1' | 'p';
  className?: string;
}

export function SubHeader({
  title,
  onBack,
  parentLabel,
  backAriaLabel,
  backLabel,
  meta,
  actions,
  testId,
  backTestId,
  titleTestId,
  titleAs = 'h1',
  className,
}: SubHeaderProps) {
  return (
    <header
      data-testid={testId}
      className={cn(
        'relative z-chrome flex h-12 flex-none items-center gap-1.5 overflow-hidden',
        'border-b border-line-subtle bg-app/60 px-3 backdrop-blur-xl sm:gap-2 sm:px-4',
        className,
      )}
    >
      <BackButton
        onBack={onBack}
        parentLabel={parentLabel}
        ariaLabel={backAriaLabel}
        label={backLabel}
        testId={backTestId}
        className="-ml-2"
      />

      <div className="flex min-w-0 flex-1 items-center gap-2">
        {titleAs === 'h1' ? (
          <>
            {/* Mobile: the sub-view title is the only in-page h1; desktop:
                the TopBar owns the page h1, so the same text is a <p> (V-15). */}
            <h1
              data-testid={titleTestId}
              title={title}
              className="min-w-0 truncate text-section font-semibold text-fg-primary lg:hidden"
            >
              {title}
            </h1>
            <p
              title={title}
              className="hidden min-w-0 truncate text-section font-semibold text-fg-primary lg:block"
            >
              {title}
            </p>
          </>
        ) : (
          <p
            data-testid={titleTestId}
            title={title}
            className="min-w-0 truncate text-section font-semibold text-fg-primary"
          >
            {title}
          </p>
        )}
        {meta && (
          <span className="inline-flex max-w-[45%] shrink-0 items-center gap-1 truncate whitespace-nowrap text-micro font-medium text-fg-muted">
            {meta}
          </span>
        )}
      </div>

      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}

export default SubHeader;
