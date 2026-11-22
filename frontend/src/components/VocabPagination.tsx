// Shared pagination for the word book's five lists (specs/005 §统一词表 UI).
//
// One component keeps the page strip, the page-size selector (20/50/100), the
// status text and the "jump to page" input identical everywhere. Client-paged
// lists (我的单词 / 已掌握 / 自定义词表) and server-paged lists (内置词表 /
// 短语) pass the same props; only `page`/`pages` differ in where they come from.
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { Button } from './ui/Button';
import { Menu } from './ui/Menu';

/** Per-page choices offered by every list (specs/005 §统一词表 UI). */
export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

export function paginationTokens(current: number, total: number): Array<number | 'ellipsis'> {
    if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
    const start = Math.max(2, Math.min(current - 1, total - 4));
    const end = Math.min(total - 1, Math.max(current + 1, 5));
    const tokens: Array<number | 'ellipsis'> = [1];
    if (start > 2) tokens.push('ellipsis');
    for (let page = start; page <= end; page += 1) tokens.push(page);
    if (end < total - 1) tokens.push('ellipsis');
    tokens.push(total);
    return tokens;
}

function clampPage(value: number, pages: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.min(Math.max(1, Math.trunc(value)), Math.max(1, pages));
}

interface VocabPaginationProps {
    /** Test-id prefix: `vocab` or `phrase`. */
    scope: 'vocab' | 'phrase';
    page: number;
    pages: number;
    hasMore: boolean;
    onChange: (page: number) => void;
    /** Current per-page count. Omit to hide the size selector. */
    pageSize?: number;
    onPageSizeChange?: (size: number) => void;
}

export function VocabPagination({
    scope,
    page,
    pages,
    hasMore,
    onChange,
    pageSize,
    onPageSizeChange,
}: VocabPaginationProps) {
    const { t, formatNumber } = useI18n();
    const [jumpValue, setJumpValue] = useState(String(page));
    const showSizes = typeof pageSize === 'number' && typeof onPageSizeChange === 'function';

    // Keep the jump field honest when paging happens through the arrows /
    // number strip instead of the input.
    useEffect(() => {
        setJumpValue(String(page));
    }, [page]);

    const submitJump = () => {
        const next = clampPage(Number(jumpValue), pages);
        setJumpValue(String(next));
        if (next !== page) onChange(next);
    };

    return (
        <div
            data-testid={`${scope}-pagination`}
            className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
        >
            <span
                data-testid={`${scope}-page-status`}
                className="text-caption tabular-nums text-fg-muted"
            >
                {t('vocab.page.status', { page: formatNumber(page), pages: formatNumber(pages) })}
            </span>
            <div className="flex flex-wrap items-center gap-1">
                {showSizes && (
                    <Menu
                        ariaLabel={t('vocab.page.sizeLabel')}
                        align="start"
                        menuTestId={`${scope}-page-size-menu`}
                        trigger={({ triggerRef, triggerProps }) => (
                            <button
                                {...triggerProps}
                                ref={triggerRef}
                                type="button"
                                data-testid={`${scope}-page-size`}
                                className="inline-flex h-control-sm shrink-0 items-center gap-1 rounded-control border border-line-subtle bg-surface-2/60 px-2.5 text-caption font-medium text-fg-strong transition-colors hover:bg-surface-3/60 hover:text-fg-primary"
                            >
                                {t('vocab.page.size', { count: formatNumber(pageSize) })}
                                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        )}
                        items={PAGE_SIZE_OPTIONS.map((size) => ({
                            id: `size-${size}`,
                            label: t('vocab.page.size', { count: formatNumber(size) }),
                            checked: size === pageSize,
                            testId: `${scope}-page-size-${size}`,
                            onSelect: () => {
                                if (size !== pageSize) onPageSizeChange(size);
                            },
                        }))}
                    />
                )}
                <button
                    type="button"
                    data-testid={`${scope}-page-prev`}
                    disabled={page <= 1}
                    onClick={() => onChange(Math.max(1, page - 1))}
                    aria-label={t('vocab.page.prev')}
                    title={t('vocab.page.prev')}
                    className="inline-flex h-control-sm min-w-8 shrink-0 items-center justify-center rounded-control bg-surface-2/60 text-fg-strong transition-colors hover:bg-surface-3/60 hover:text-fg-primary disabled:pointer-events-none disabled:opacity-40"
                >
                    <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                {paginationTokens(page, pages).map((token, index) => (
                    token === 'ellipsis' ? (
                        <span key={`ellipsis-${index}`} className="px-1 text-caption text-fg-muted">…</span>
                    ) : (
                        <button
                            key={token}
                            type="button"
                            data-testid={`${scope}-page-${token}`}
                            aria-current={token === page ? 'page' : undefined}
                            onClick={() => onChange(token)}
                            className={`inline-flex h-control-sm min-w-8 shrink-0 items-center justify-center rounded-control px-2 text-caption font-medium tabular-nums transition-colors ${
                                token === page
                                    ? 'bg-state-selected text-fg-primary'
                                    : 'text-fg-muted hover:bg-state-hover hover:text-fg-strong'
                            }`}
                        >
                            {formatNumber(token)}
                        </button>
                    )
                ))}
                <button
                    type="button"
                    data-testid={`${scope}-page-next`}
                    disabled={!hasMore}
                    onClick={() => onChange(page + 1)}
                    aria-label={t('vocab.page.next')}
                    title={t('vocab.page.next')}
                    className="inline-flex h-control-sm min-w-8 shrink-0 items-center justify-center rounded-control bg-surface-2/60 text-fg-strong transition-colors hover:bg-surface-3/60 hover:text-fg-primary disabled:pointer-events-none disabled:opacity-40"
                >
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <div className="ms-1 flex items-center gap-1">
                    <label
                        htmlFor={`${scope}-page-jump-input`}
                        className="text-caption text-fg-muted"
                    >
                        {t('vocab.page.jump')}
                    </label>
                    <input
                        id={`${scope}-page-jump-input`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={Math.max(1, pages)}
                        value={jumpValue}
                        data-testid={`${scope}-page-jump`}
                        aria-label={t('vocab.page.jumpLabel')}
                        onChange={(event) => setJumpValue(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key !== 'Enter') return;
                            event.preventDefault();
                            submitJump();
                        }}
                        className="h-control-sm w-14 rounded-control border border-line-subtle bg-surface-2/60 px-2 text-center text-caption tabular-nums text-fg-primary"
                    />
                    <Button
                        size="sm"
                        variant="secondary"
                        testId={`${scope}-page-jump-go`}
                        onClick={submitJump}
                        className="h-control-sm px-2"
                    >
                        {t('vocab.page.jumpGo')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
