// Shared pagination for the word book's word lists and phrase list.
// Both lists use the same 50-per-page server contract; one component keeps the
// page-number strip, status text and disabled states identical everywhere.
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';

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

interface VocabPaginationProps {
    /** Test-id prefix: `vocab` or `phrase`. */
    scope: 'vocab' | 'phrase';
    page: number;
    pages: number;
    hasMore: boolean;
    onChange: (page: number) => void;
}

export function VocabPagination({ scope, page, pages, hasMore, onChange }: VocabPaginationProps) {
    const { t, formatNumber } = useI18n();
    return (
        <div
            data-testid={`${scope}-pagination`}
            className="flex flex-wrap items-center justify-between gap-2"
        >
            <span
                data-testid={`${scope}-page-status`}
                className="text-xs text-zinc-500 tabular-nums"
            >
                {t('vocab.page.status', { page: formatNumber(page), pages: formatNumber(pages) })}
            </span>
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto custom-scrollbar">
                <button
                    type="button"
                    data-testid={`${scope}-page-prev`}
                    disabled={page <= 1}
                    onClick={() => onChange(Math.max(1, page - 1))}
                    aria-label={t('vocab.page.prev')}
                    title={t('vocab.page.prev')}
                    className="inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800/60 text-zinc-300 transition-colors hover:bg-zinc-700/60 hover:text-zinc-100 disabled:opacity-40 disabled:pointer-events-none"
                >
                    <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                {paginationTokens(page, pages).map((token, index) => (
                    token === 'ellipsis' ? (
                        <span key={`ellipsis-${index}`} className="px-1 text-xs text-zinc-600">…</span>
                    ) : (
                        <button
                            key={token}
                            type="button"
                            data-testid={`${scope}-page-${token}`}
                            aria-current={token === page ? 'page' : undefined}
                            onClick={() => onChange(token)}
                            className={`inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg px-2 text-xs font-medium tabular-nums transition-colors ${
                                token === page
                                    ? 'bg-white/10 text-zinc-100'
                                    : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
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
                    className="inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800/60 text-zinc-300 transition-colors hover:bg-zinc-700/60 hover:text-zinc-100 disabled:opacity-40 disabled:pointer-events-none"
                >
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            </div>
        </div>
    );
}
