// Shared word-list table for the word book (specs/005 §v1.1 / §v1.2).
//
// One implementation serves three surfaces that must look and behave the same:
//   * the built-in vocabulary lists (CEFR / GRE / CET4 / CET6) — server paged;
//   * 已掌握 — client paged (50/page), fed by `GET /api/review/words?mastered=1`
//     for signed-in users or the local 「我会了」 table for guests, enriched
//     with the favorite's IPA/meaning when one exists;
//   * (rows only) the actions recipe reused by the 我的单词 list.
//
// Since v1.2 every row can additionally carry:
//   * `actions` — trailing row controls (朗读 / 加入我的单词 / 加入复习 / 撤销…),
//     rendered on their own line on phones and inline from `sm` up. Labels are
//     always visible on the word lists, so 已加入 / 已在复习 never degrade to an
//     icon-only state;
//   * `selection` — the leading multi-select checkbox used by 批量操作.
//
// Keeping the row markup here is what stops the second table from drifting;
// the `vocab-list-*` selectors stay the established contract for the list tabs
// (only the `testIdPrefix` changes for 已掌握).
//
// Colours are design tokens (brand / warning / fg / line) so the moved markup
// does not add bare `blue-*` / `amber-*` literals to the gate receipt.
import { Eye, EyeOff, type LucideIcon } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { Button, IconButton } from './ui/Button';
import { Checkbox } from './ui/Checkbox';

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

/**
 * One trailing row control. `text` keeps a visible label (grammar: the label is
 * also the accessible name); without it the control is icon-only and `label`
 * alone names it. `done` renders the completed state (已加入 / 已在复习) with the
 * success tone and `aria-pressed`.
 */
export interface WordRowAction {
    key: string;
    /** Accessible name and tooltip; never empty. */
    label: string;
    /** Visible label; omit for an icon-only control. */
    text?: string;
    icon: LucideIcon;
    onClick: () => void;
    testId?: string;
    disabled?: boolean;
    /** Request in flight: spinner + disabled (no double submit). */
    busy?: boolean;
    /** Completed state (success tone + pressed). */
    done?: boolean;
}

/** Leading multi-select control (批量操作). */
export interface WordRowSelection {
    checked: boolean;
    onChange: (checked: boolean) => void;
    /** Accessible name, e.g. 「选择 abundant」. */
    label: string;
    disabled?: boolean;
    testId?: string;
}

/** One row: the same fields for the server list and the mastered list. */
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
    /** Trailing controls (朗读 / 加入我的单词 / 加入复习 / 取消已掌握…). */
    actions?: readonly WordRowAction[];
    /** Leading multi-select checkbox. */
    selection?: WordRowSelection;
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

export function WordRowActionButton({ action }: { action: WordRowAction }) {
    const Icon = action.icon;
    // The wrapper carries the tooltip so a disabled control (朗读 without an
    // English voice) still explains itself on hover; buttons have no `title`.
    return (
        <span
            className="inline-flex"
            title={action.label}
            // The control is a sibling of the row button today, but a future
            // caller may nest it: never let a click also toggle the row.
            onClick={(event) => event.stopPropagation()}
        >
            {action.text ? (
                <Button
                    size="sm"
                    variant="ghost"
                    iconLeft={<Icon />}
                    ariaLabel={action.label}
                    testId={action.testId}
                    disabled={action.disabled}
                    loading={action.busy}
                    onClick={action.onClick}
                    className={action.done ? 'text-success-fg' : undefined}
                >
                    {action.text}
                </Button>
            ) : (
                <IconButton
                    size="sm"
                    ariaLabel={action.label}
                    testId={action.testId}
                    disabled={action.disabled}
                    loading={action.busy}
                    onClick={action.onClick}
                    className={action.done ? 'text-success-fg' : undefined}
                >
                    <Icon className={action.done ? undefined : 'text-fg-muted'} aria-hidden="true" />
                </IconButton>
            )}
        </span>
    );
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
                        <div key={row.key} data-word={row.word}>
                            {/* Mobile: the action line takes its own row; from `sm`
                                up it sits inline after the row content. */}
                            <div className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-0">
                                <div className="flex min-w-0 flex-1 items-stretch">
                                    {row.selection && (
                                        <div className="flex shrink-0 items-center ps-2">
                                            <Checkbox
                                                checked={row.selection.checked}
                                                onChange={row.selection.onChange}
                                                ariaLabel={row.selection.label}
                                                disabled={row.selection.disabled}
                                                testId={row.selection.testId}
                                            />
                                        </div>
                                    )}
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
                                </div>
                                {row.actions && row.actions.length > 0 && (
                                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 px-3 pb-2 sm:flex-nowrap sm:px-0 sm:pe-2 sm:pb-0">
                                        {row.actions.map((action) => (
                                            <WordRowActionButton key={action.key} action={action} />
                                        ))}
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
