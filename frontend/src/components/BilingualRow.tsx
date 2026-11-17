// Shared bilingual reading row for the article and book readers.
//
// Desktop (≥lg): one paragraph per row — English source on the left, the
// translation on the right, in the SAME row (a separate scroll container per
// column would let the two sides drift apart). Below lg everything stays in
// the existing stacked order: English first, translation under it.
//
// The readers keep one scroll container around all rows; this component only
// owns the column switch, so scroll restoration, progress saving and the
// paragraph menus stay untouched.
import type { ReactNode } from 'react';
import { cn } from './TranscriptBlock';

/** Reading width: wide enough for two comfortable columns, never a hard cap
 *  that would produce a horizontal scrollbar below the breakpoint. */
export const bilingualReadingWidth = (twoColumn: boolean) =>
    twoColumn ? 'max-w-5xl xl:max-w-6xl' : 'max-w-3xl';

interface BilingualRowProps {
    /** True when the translation column is displayed. */
    twoColumn: boolean;
    english: ReactNode;
    /** `undefined`/`null` = nothing to show on the right (e.g. no translation). */
    translation?: ReactNode;
    className?: string;
    englishClassName?: string;
    translationClassName?: string;
    /** Root hook (keeps the existing paragraph test ids where they were). */
    testId?: string;
    /** Test hook for the translation cell, independent of its content. */
    translationTestId?: string;
}

export const BilingualRow: React.FC<BilingualRowProps> = ({
    twoColumn,
    english,
    translation,
    className,
    englishClassName,
    translationClassName,
    testId,
    translationTestId,
}) => (
    <div
        data-testid={testId}
        data-bilingual={twoColumn ? 'two-column' : 'single-column'}
        className={cn(
            twoColumn && 'lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-10 xl:gap-x-14',
            className,
        )}
    >
        <div className={cn('min-w-0', englishClassName)}>{english}</div>
        {translation !== undefined && translation !== null && (
            <div
                data-testid={translationTestId}
                className={cn(
                    'min-w-0 mt-2',
                    twoColumn && 'lg:mt-0',
                    translationClassName,
                )}
            >
                {translation}
            </div>
        )}
    </div>
);
