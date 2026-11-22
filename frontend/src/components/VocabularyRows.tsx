// Shared word-list row + toolbar for the word book (specs/005 §统一词表 UI).
//
// One row and one toolbar serve all five surfaces: 我的单词 / 已掌握 / 内置词表
// (CEFR·GRE·CET4·CET6) / 自定义词表 / 短语. The contract is one line on desktop
// and two internal lines at 375px:
//
//   原词 / 音标（统一 /…/）/ 释义（左对齐、单行省略）/ 发音 / LevelBadge /
//   收藏星标（实心=已收藏）/ ×N 见过次数（仅我的单词）/ 展开箭头
//
// The expanded area carries the full meaning, provenance and the row actions
// (加入我的单词 / 已掌握 / 取消收藏…). Expansion animates its own height, so the
// table never reflows column widths when a row opens.
//
// Colour and space come from the design tokens; no new literals are added for
// rows, star, toolbar or expansion.
import { type ReactNode } from 'react';
import {
    ChevronDown,
    ListFilter,
    Search,
    Star,
    Volume2,
    ArrowUpDown,
    X,
    type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useI18n } from '../i18n/I18nProvider';
import { cn } from '../lib/cn';
import { Button, IconButton } from './ui/Button';
import { Checkbox } from './ui/Checkbox';
import { Menu, type MenuItem } from './ui/Menu';

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
 * One phonetic string in the single house format `/…/`. Existing wrappers
 * (`/…/`, `[…]`, `—`) are normalized so every list renders the same style; an
 * unknown phonetic renders empty instead of a placeholder (spec: 无则留空).
 */
export function normalizePhonetic(raw: string | null | undefined): string {
    const value = (raw ?? '').trim();
    if (!value || /^[—–-]$/.test(value)) return '';
    let core = value;
    if (core.startsWith('/') && core.endsWith('/') && core.length > 1) {
        core = core.slice(1, -1).trim();
    } else if (core.startsWith('[') && core.endsWith(']') && core.length > 1) {
        core = core.slice(1, -1).trim();
    }
    return core ? `/${core}/` : '';
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

/** Leading multi-select control (custom-wordlist edit mode only). */
export interface WordRowSelection {
    checked: boolean;
    onChange: (checked: boolean) => void;
    /** Accessible name, e.g. 「选择 abundant」. */
    label: string;
    disabled?: boolean;
    testId?: string;
}

/** Exact legacy test hooks for one row; omitted entries fall back to the prefix. */
export interface WordRowTestIds {
    row?: string;
    word?: string;
    phonetic?: string;
    translation?: string;
    level?: string;
    speak?: string;
    star?: string;
    seen?: string;
    expand?: string;
    detail?: string;
}

/** One row: the same fields for every word list and the phrase list. */
export interface WordTableRow {
    /** Stable React/test key (word plus an index for duplicates). */
    key: string;
    word: string;
    /** Raw phonetic; `WordTable` normalizes it to `/…/`. */
    phonetic?: string | null;
    /** `null` renders `—` (missing meaning); hidden while hideChinese. */
    translation?: string | null;
    level?: string | null;
    levelTitle?: string;
    /** Optional extra badge next to the headword (phrase type). */
    badge?: ReactNode;
    /** True while the translation is temporarily revealed despite hideChinese. */
    revealed?: boolean;
    /** Row click (reveal Chinese while hidden, or expand on the phrase list). */
    onActivate?: () => void;
    /** `×N` seen count — only 我的单词 passes this. */
    seenText?: string;
    seenTitle?: string;
    /** Filled star = already saved. */
    favored: boolean;
    favoriteLabel: string;
    onToggleFavorite?: () => void;
    favoriteBusy?: boolean;
    speakLabel: string;
    onSpeak?: () => void;
    speakDisabled?: boolean;
    expandLabel: string;
    expanded?: boolean;
    onToggleExpand?: () => void;
    /** Expanded content above the action row. */
    detail?: ReactNode;
    /** Actions rendered inside the expanded area. */
    actions?: readonly WordRowAction[];
    /** Leading checkbox (custom-wordlist edit mode only). */
    selection?: WordRowSelection;
    /** Row-level write failure, rendered under the row (never a page error). */
    error?: { message: string; testId?: string };
    testIds?: WordRowTestIds;
}

export interface WordTableProps {
    rows: readonly WordTableRow[];
    hideChinese: boolean;
    /** Card shell classes from the caller; keeps one card recipe for all tabs. */
    className?: string;
    /** `vocab-word-list` / `vocab-mastered-list` / … */
    listTestId: string;
    /** Row test-id prefix; the built-in lists keep `vocab-list`. */
    testIdPrefix?: string;
    /** Render the ×N column (我的单词 only). */
    showSeen?: boolean;
    /** Render the leading checkbox column (custom-wordlist edit mode). */
    selectable?: boolean;
    /** Accessible name of the list. */
    ariaLabel?: string;
}

export function WordRowActionButton({ action }: { action: WordRowAction }) {
    const Icon = action.icon;
    // The wrapper carries the tooltip so a disabled control (朗读 without an
    // English voice) still explains itself on hover; buttons have no `title`.
    return (
        <span
            className="inline-flex"
            title={action.label}
            // Never let a control click also toggle the row.
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

const MOBILE_GRID = 'grid-cols-[minmax(0,1fr)_auto]';
/** Desktop columns: word · phonetic · meaning · speak · level · star · [seen] · expand. */
const DESKTOP_GRID_8 =
    'md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.8fr)_minmax(0,1.7fr)_2.25rem_auto_2.25rem_2.75rem_2.25rem]';
const DESKTOP_GRID_7 =
    'md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.8fr)_minmax(0,1.7fr)_2.25rem_auto_2.25rem_2.25rem]';

/** Static class strings (Tailwind only sees literals) for each control column. */
function controlColumns(showSeen: boolean) {
    return {
        speak: 'md:col-start-4 md:row-start-1',
        level: 'md:col-start-5 md:row-start-1',
        star: 'md:col-start-6 md:row-start-1',
        seen: showSeen ? 'md:col-start-7 md:row-start-1' : '',
        expand: showSeen ? 'md:col-start-8 md:row-start-1' : 'md:col-start-7 md:row-start-1',
    };
}

export function WordTable({
    rows,
    hideChinese,
    className,
    listTestId,
    testIdPrefix = 'vocab-list',
    showSeen = false,
    selectable = false,
    ariaLabel,
}: WordTableProps) {
    const { t } = useI18n();
    const reduceMotion = useReducedMotion() ?? false;
    const desktopGrid = showSeen ? DESKTOP_GRID_8 : DESKTOP_GRID_7;
    const cols = controlColumns(showSeen);

    return (
        <div
            data-testid={listTestId}
            role="group"
            aria-label={ariaLabel}
            className={cn(className, 'overflow-hidden')}
        >
            <div
                data-testid={`${testIdPrefix}-header`}
                className="hidden border-b border-line-subtle bg-surface-2/30 md:flex"
            >
                {selectable && <span aria-hidden="true" className="w-11 shrink-0" />}
                <div className={cn('grid flex-1 items-center gap-x-3 px-3 py-2 text-micro font-medium text-fg-muted', desktopGrid)}>
                    <span>{t('vocab.col.word')}</span>
                    <span>{t('vocab.col.phonetic')}</span>
                    <span>{t('vocab.col.translation')}</span>
                    <span aria-hidden="true" />
                    <span>{t('vocab.col.level')}</span>
                    <span aria-hidden="true" />
                    {showSeen && <span className="text-right">{t('vocab.col.seen')}</span>}
                    <span aria-hidden="true" />
                </div>
            </div>
            <div className="divide-y divide-line-subtle">
                {rows.map((row) => (
                    <WordTableRowView
                        key={row.key}
                        row={row}
                        hideChinese={hideChinese}
                        showSeen={showSeen}
                        testIdPrefix={testIdPrefix}
                        desktopGrid={desktopGrid}
                        cols={cols}
                        reduceMotion={reduceMotion}
                    />
                ))}
            </div>
        </div>
    );
}

function WordTableRowView({
    row,
    hideChinese,
    showSeen,
    testIdPrefix,
    desktopGrid,
    cols,
    reduceMotion,
}: {
    row: WordTableRow;
    hideChinese: boolean;
    showSeen: boolean;
    testIdPrefix: string;
    desktopGrid: string;
    cols: ReturnType<typeof controlColumns>;
    reduceMotion: boolean;
}) {
    const { t } = useI18n();
    const ids = {
        row: row.testIds?.row ?? `${testIdPrefix}-row`,
        word: row.testIds?.word ?? `${testIdPrefix}-word`,
        phonetic: row.testIds?.phonetic ?? `${testIdPrefix}-ipa`,
        translation: row.testIds?.translation ?? `${testIdPrefix}-translation`,
        level: row.testIds?.level ?? `${testIdPrefix}-level`,
        speak: row.testIds?.speak ?? `${testIdPrefix}-speak`,
        star: row.testIds?.star ?? `${testIdPrefix}-star`,
        seen: row.testIds?.seen ?? `${testIdPrefix}-seen`,
        expand: row.testIds?.expand ?? `${testIdPrefix}-expand`,
        detail: row.testIds?.detail ?? `${testIdPrefix}-detail-${row.key}`,
    };
    const translationHidden = hideChinese && !row.revealed;
    const phonetic = normalizePhonetic(row.phonetic);
    const translation = (row.translation ?? '').trim();
    const expandable = Boolean(row.onToggleExpand);

    return (
        <div data-word={row.word}>
            <div className="flex items-stretch">
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
                <div
                    data-testid={ids.row}
                    data-word={row.word}
                    role={row.onActivate ? 'button' : undefined}
                    tabIndex={row.onActivate ? 0 : undefined}
                    aria-pressed={hideChinese ? Boolean(row.revealed) : undefined}
                    aria-label={row.onActivate
                        ? (row.revealed ? t('vocab.tapHide') : t('vocab.tapReveal'))
                        : undefined}
                    title={row.onActivate
                        ? (row.revealed ? t('vocab.tapHide') : t('vocab.tapReveal'))
                        : undefined}
                    onClick={row.onActivate}
                    onKeyDown={row.onActivate
                        ? (event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            row.onActivate?.();
                        }
                        : undefined}
                    className={cn(
                        'grid min-w-0 flex-1 items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left transition-colors',
                        'md:min-h-12 md:gap-x-3 md:py-0',
                        MOBILE_GRID,
                        desktopGrid,
                        row.onActivate ? 'cursor-pointer hover:bg-state-hover' : 'cursor-default',
                    )}
                >
                    {/* Word + phonetic: inline on phones, own columns from md up. */}
                    <div className="col-start-1 row-start-1 flex min-w-0 items-baseline gap-1.5 md:contents">
                        <span className="flex min-w-0 items-baseline gap-2 md:col-start-1 md:row-start-1">
                            <span
                                data-testid={ids.word}
                                className="min-w-0 truncate text-body-zh font-semibold text-fg-primary"
                            >
                                {row.word}
                            </span>
                            {row.badge && <span className="shrink-0">{row.badge}</span>}
                        </span>
                        <span
                            data-testid={ids.phonetic}
                            className="min-w-0 max-w-[45%] truncate text-caption tabular-nums text-fg-muted md:col-start-2 md:row-start-1 md:max-w-none"
                        >
                            {phonetic || '\u00A0'}
                        </span>
                    </div>

                    {/* Meaning: left aligned, one line with ellipsis + title. */}
                    <span
                        data-testid={translationHidden ? undefined : ids.translation}
                        title={!translationHidden && translation ? translation : undefined}
                        className="col-start-1 row-start-2 min-w-0 truncate text-left text-ui text-fg-secondary md:col-start-3 md:row-start-1"
                    >
                        {translationHidden ? '\u00A0' : (translation || '—')}
                    </span>

                    {/* Speak · level · seen: second control line on phones. */}
                    <div className="col-start-2 row-start-2 flex items-center justify-self-end gap-1 md:contents">
                        <span
                            className={cn('inline-flex', cols.speak)}
                            title={row.speakLabel}
                            onClick={(event) => event.stopPropagation()}
                        >
                            <IconButton
                                size="sm"
                                ariaLabel={row.speakLabel}
                                testId={ids.speak}
                                disabled={row.speakDisabled}
                                onClick={row.onSpeak}
                            >
                                <Volume2 className="h-4 w-4 text-fg-muted" aria-hidden="true" />
                            </IconButton>
                        </span>
                        <span className={cn('inline-flex', cols.level)}>
                            <LevelBadge
                                testId={ids.level}
                                level={row.level || '—'}
                                title={row.levelTitle}
                            />
                        </span>
                        {showSeen && (
                            <span
                                data-testid={ids.seen}
                                title={row.seenTitle}
                                className={cn('text-right text-caption tabular-nums text-fg-muted', cols.seen)}
                            >
                                {row.seenText || '\u00A0'}
                            </span>
                        )}
                    </div>

                    {/* Star + expand: first control line on phones. */}
                    <div className="col-start-2 row-start-1 flex items-center justify-self-end gap-1 md:contents">
                        <span
                            className={cn('inline-flex', cols.star)}
                            title={row.favoriteLabel}
                            onClick={(event) => event.stopPropagation()}
                        >
                            <IconButton
                                size="sm"
                                ariaLabel={row.favoriteLabel}
                                ariaPressed={row.favored}
                                testId={ids.star}
                                disabled={row.favoriteBusy}
                                loading={row.favoriteBusy}
                                onClick={row.onToggleFavorite}
                            >
                                <Star
                                    className={cn(
                                        'h-4 w-4',
                                        row.favored
                                            ? 'fill-warning-fg text-warning-fg'
                                            : 'text-fg-muted',
                                    )}
                                    aria-hidden="true"
                                />
                            </IconButton>
                        </span>
                        {expandable && (
                            <span
                                className={cn('inline-flex', cols.expand)}
                                onClick={(event) => event.stopPropagation()}
                            >
                                <IconButton
                                    size="sm"
                                    ariaLabel={row.expandLabel}
                                    testId={ids.expand}
                                    ariaExpanded={row.expanded}
                                    ariaControls={ids.detail}
                                    onClick={row.onToggleExpand}
                                >
                                    <ChevronDown
                                        className={cn(
                                            'h-4 w-4 text-fg-muted transition-transform duration-200 ease-apple motion-reduce:transition-none',
                                            row.expanded && 'rotate-180',
                                        )}
                                        aria-hidden="true"
                                    />
                                </IconButton>
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {row.error && (
                <p
                    data-testid={row.error.testId}
                    role="alert"
                    className="px-3 pb-2 text-caption leading-relaxed text-danger-fg md:px-4"
                >
                    {row.error.message}
                </p>
            )}

            {expandable && (
                <AnimatePresence initial={false}>
                    {row.expanded && (
                        <motion.div
                            key="body"
                            id={ids.detail}
                            data-testid={ids.detail}
                            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                            transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.25, 1, 0.5, 1] }}
                            className="overflow-hidden"
                        >
                            <div className="border-t border-line-subtle px-3 pb-3.5 pt-3 md:px-4">
                                {row.detail}
                                {row.actions && row.actions.length > 0 && (
                                    <div className={cn('flex flex-wrap items-center gap-1.5', row.detail && 'mt-3')}>
                                        {row.actions.map((action) => (
                                            <WordRowActionButton key={action.key} action={action} />
                                        ))}
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            )}
        </div>
    );
}

// ── Toolbar: search + sort selector + filter selector ────────────────────────

export interface SortOption {
    value: string;
    label: string;
    /** Optional legacy test hook (e.g. `vocab-sort-alpha`). */
    testId?: string;
}

export interface FilterOption {
    value: string;
    label: string;
    checked: boolean;
    testId?: string;
}

export interface FilterGroup {
    /** Stable group id (也用作菜单项的 section 名). */
    id: string;
    label: string;
    options: readonly FilterOption[];
}

export interface WordbookToolbarProps {
    search: {
        value: string;
        onChange: (value: string) => void;
        placeholder: string;
        ariaLabel: string;
        testId: string;
        clearTestId: string;
        clearLabel: string;
    };
    sort: {
        value: string;
        /** Current value label shown on the trigger. */
        label: string;
        options: readonly SortOption[];
        onChange: (value: string) => void;
        testId: string;
        menuTestId?: string;
    };
    filter: {
        groups: readonly FilterGroup[];
        activeCount: number;
        onChange: (value: string) => void;
        onClear: () => void;
        testId: string;
        clearTestId: string;
        menuTestId?: string;
    };
    /** Extra controls (e.g. the hide-Chinese switch) rendered after the filters. */
    extra?: ReactNode;
}

const TOOLBAR_BUTTON =
    'inline-flex h-control-md shrink-0 items-center gap-1.5 rounded-control border border-line-subtle bg-surface-2/60 px-2.5 text-caption font-medium text-fg-strong transition-colors hover:bg-surface-3/60 hover:text-fg-primary';

/** Search + 排序 + 筛选, identical on every word list. */
export function WordbookToolbar({ search, sort, filter, extra }: WordbookToolbarProps) {
    const { t } = useI18n();

    const filterItems: MenuItem[] = [];
    for (const group of filter.groups) {
        for (const option of group.options) {
            filterItems.push({
                id: `${group.id}:${option.value}`,
                section: group.label,
                label: option.label,
                checked: option.checked,
                keepOpen: true,
                testId: option.testId,
                onSelect: () => filter.onChange(`${group.id}:${option.value}`),
            });
        }
    }
    const activeFilterLabels = filter.groups.flatMap((group) => (
        group.options
            .filter((option) => option.checked && option.value !== '')
            .map((option) => option.label)
    ));
    const filterTriggerLabel = filter.activeCount === 0
        ? t('vocab.toolbar.filterLabel')
        : t('vocab.toolbar.filterValue', {
            values: activeFilterLabels.slice(0, 2).join(' · ')
                + (activeFilterLabels.length > 2 ? ` +${activeFilterLabels.length - 2}` : ''),
        });

    filterItems.push({
        id: 'filter-clear',
        label: t('vocab.filter.clear'),
        icon: <X />,
        disabled: filter.activeCount === 0,
        testId: `${filter.clearTestId}-menu`,
        onSelect: filter.onClear,
    });

    return (
        <div className="flex flex-col gap-2 rounded-card border border-line-subtle bg-surface-2/40 px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative min-w-0 flex-1">
                <Search
                    className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
                    aria-hidden="true"
                />
                <input
                    type="search"
                    data-testid={search.testId}
                    value={search.value}
                    onChange={(event) => search.onChange(event.target.value)}
                    placeholder={search.placeholder}
                    aria-label={search.ariaLabel}
                    className="h-control-md w-full min-w-0 rounded-control border border-line-subtle bg-surface-2/60 ps-9 pe-9 text-ui text-fg-primary placeholder:text-fg-muted [&::-webkit-search-cancel-button]:hidden"
                />
                {search.value && (
                    <button
                        type="button"
                        data-testid={search.clearTestId}
                        onClick={() => search.onChange('')}
                        aria-label={search.clearLabel}
                        title={search.clearLabel}
                        className="absolute end-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-state-hover hover:text-fg-primary"
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
                <Menu
                    ariaLabel={t('vocab.toolbar.sortLabel')}
                    align="start"
                    compact
                    menuTestId={sort.menuTestId}
                    trigger={({ triggerRef, triggerProps }) => (
                        <button
                            {...triggerProps}
                            ref={triggerRef}
                            type="button"
                            data-testid={sort.testId}
                            className={TOOLBAR_BUTTON}
                        >
                            <ArrowUpDown className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
                            {t('vocab.toolbar.sortValue', { value: sort.label })}
                        </button>
                    )}
                    items={sort.options.map((option) => ({
                        id: `sort:${option.value}`,
                        label: option.label,
                        checked: option.value === sort.value,
                        testId: option.testId,
                        onSelect: () => sort.onChange(option.value),
                    }))}
                />

                <Menu
                    ariaLabel={t('vocab.toolbar.filterLabel')}
                    align="start"
                    compact
                    menuTestId={filter.menuTestId}
                    trigger={({ triggerRef, triggerProps }) => (
                        <button
                            {...triggerProps}
                            ref={triggerRef}
                            type="button"
                            data-testid={filter.testId}
                            className={cn(
                                TOOLBAR_BUTTON,
                                filter.activeCount > 0 && 'border-brand/30 bg-brand/10 text-brand-300',
                            )}
                        >
                            <ListFilter className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="max-w-40 truncate">{filterTriggerLabel}</span>
                        </button>
                    )}
                    items={filterItems}
                />

                {filter.activeCount > 0 && (
                    <button
                        type="button"
                        data-testid={filter.clearTestId}
                        onClick={filter.onClear}
                        className="inline-flex h-control-md items-center rounded-control px-2 text-caption font-medium text-fg-muted transition-colors hover:bg-state-hover hover:text-fg-primary"
                    >
                        {t('vocab.filter.clear')}
                    </button>
                )}

                {extra}
            </div>
        </div>
    );
}
