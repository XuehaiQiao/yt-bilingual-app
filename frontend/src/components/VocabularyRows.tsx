// Shared word-list table for the word book (specs/005 §v1.1).
//
// One implementation serves two surfaces that must look and behave the same:
//   * the built-in vocabulary lists (CEFR / GRE / CET4 / CET6) — server paged;
//   * 已掌握 — client paged (50/page), fed by `GET /api/review/words?mastered=1`
//     for signed-in users or the local 「我会了」 table for guests, enriched
//     with the favorite's IPA/meaning when one exists.
// Keeping the row markup here is what stops the second table from drifting;
// the `vocab-list-*` selectors stay the established contract for the list tabs
// (only the `testIdPrefix` changes for 已掌握).
//
// Colours are design tokens (brand / warning / fg / line) so the moved markup
// does not add bare `blue-*` / `amber-*` literals to the gate receipt.
import { Eye, EyeOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';

/** Off-list words read `C1+` in 我的单词, so the badge keeps that warning tone. */
function levelBadgeClass(level: string): string {
    return level === 'C1+'
        ? 'border-warning/20 bg-warning/10 text-warning-fg'
        : 'border-brand/20 bg-brand/10 text-brand-300';
}

export function LevelBadge({ level, testId, title }: { level: string; testId?: string; title?: string }) {
    return (
        <span
            data-testid={testId}
            title={title}
            className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-micro font-medium tabular-nums ${levelBadgeClass(level)}`}
        >
            {level}
        </span>
    );
}

/** One row: the same fields for both the server list and the mastered list. */
export interface WordTableRow {
    /** Stable React/test key (word plus an index for duplicates). */
    key: string;
    word: string;
    phonetic?: string | null;
    /** `null` renders `—` (no favorite record for a mastered word). */
    translation?: string | null;
    level?: string | null;
    levelTitle?: string;
    /** True while the translation is temporarily revealed despite hideChinese. */
    revealed?: boolean;
    /** Row click; only passed when hideChinese (tap reveals the translation). */
    onActivate?: () => void;
    /** Trailing control after the level badge (e.g. 取消已掌握). */
    action?: ReactNode;
    /** Row-level write failure, rendered under the row (never a page error). */
    error?: { message: string; testId?: string };
}

export interface WordTableProps {
    rows: readonly WordTableRow[];
    hideChinese: boolean;
    /** Card shell classes from the caller; keeps one card recipe for both tabs. */
    className?: string;
    /** `vocab-word-list` / `vocab-mastered-list`. */
    listTestId: string;
    /** Row test-id prefix; the built-in lists keep `vocab-list`. */
    testIdPrefix?: string;
}

export function WordTable({
    rows,
    hideChinese,
    className,
    listTestId,
    testIdPrefix = 'vocab-list',
}: WordTableProps) {
    const { t } = useI18n();
    return (
        <div data-testid={listTestId} className={`${className ?? ''} overflow-hidden`}>
            <div className="hidden grid-cols-[minmax(0,1.15fr)_minmax(0,1.55fr)_auto] gap-3 border-b border-line-subtle px-4 py-2 text-micro font-medium text-fg-muted md:grid">
                <span>{t('vocab.col.word')}</span>
                <span>{t('vocab.col.translation')}</span>
                <span className="text-right">{t('vocab.col.level')}</span>
            </div>
            <div className="divide-y divide-line-subtle">
                {rows.map((row) => {
                    const translationHidden = hideChinese && !row.revealed;
                    return (
                        <div key={row.key}>
                            <div className="flex items-stretch">
                                <button
                                    type="button"
                                    data-testid={`${testIdPrefix}-row`}
                                    data-word={row.word}
                                    aria-pressed={hideChinese ? Boolean(row.revealed) : undefined}
                                    title={hideChinese
                                        ? (row.revealed ? t('vocab.tapHide') : t('vocab.tapReveal'))
                                        : undefined}
                                    onClick={row.onActivate}
                                    className={`grid w-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-left transition-colors md:grid-cols-[minmax(0,1.15fr)_minmax(0,1.55fr)_auto] md:gap-y-0 ${
                                        hideChinese ? 'cursor-pointer hover:bg-state-hover' : 'cursor-default'
                                    }`}
                                >
                                    <span className="flex min-w-0 items-baseline gap-2">
                                        <span
                                            data-testid={`${testIdPrefix}-word`}
                                            className="min-w-0 truncate text-body-zh font-semibold text-fg-primary"
                                        >
                                            {row.word}
                                        </span>
                                        {row.phonetic && (
                                            <span
                                                data-testid={`${testIdPrefix}-ipa`}
                                                className="min-w-0 truncate text-xs text-fg-muted"
                                            >
                                                {row.phonetic}
                                            </span>
                                        )}
                                    </span>
                                    <span className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:col-start-2 md:row-start-1">
                                        {translationHidden ? null : (
                                            <span
                                                data-testid={`${testIdPrefix}-translation`}
                                                className="block truncate text-sm text-fg-secondary"
                                            >
                                                {row.translation || '—'}
                                            </span>
                                        )}
                                    </span>
                                    <span className="col-start-2 row-start-1 flex items-center justify-end gap-2 md:col-start-3">
                                        {hideChinese && (
                                            row.revealed
                                                ? <Eye className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
                                                : <EyeOff className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
                                        )}
                                        <LevelBadge
                                            testId={`${testIdPrefix}-level`}
                                            level={row.level || '—'}
                                            title={row.levelTitle}
                                        />
                                    </span>
                                </button>
                                {row.action && (
                                    <div className="flex shrink-0 items-center pe-2">
                                        {row.action}
                                    </div>
                                )}
                            </div>
                            {row.error && (
                                <p
                                    data-testid={row.error.testId}
                                    role="alert"
                                    className="px-4 pb-2 text-caption leading-relaxed text-danger-fg"
                                >
                                    {row.error.message}
                                </p>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
