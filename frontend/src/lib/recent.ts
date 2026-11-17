// Recent-learning aggregation (Today page module).
//
// Three independent sources feed one list:
//   - video:   the `/api/history` rows the Today screen already fetched;
//   - article: `GET /api/articles` (signed-in only; guests never call it);
//   - book:    local reading progress for curated public-domain books and
//              imported books, joined with their title indexes.
//
// This module is pure data shaping: no network, no React, no UI copy. The
// component owns the localized labels and the time formatting so a language
// switch re-renders the same rows without a refetch.
import { progressPercent } from './progress';
import type { BookProgressEntry, BooksIndex } from './books';
import type { ImportedBookProgressEntry, ImportedBookSummary } from './importedBooks';
import type { ArticleSummary } from './reading';

/** One row per page. */
export const RECENT_PAGE_SIZE = 10;

export type RecentKind = 'video' | 'article' | 'book';
export type RecentBookSource = 'curated' | 'imported';
export type RecentFilter = 'all' | RecentKind;

interface RecentItemBase {
    /** Stable React key: `video:<filename>`, `article:<id>`, `book:<id>`. */
    key: string;
    title: string;
    /** Channel / site / book title; empty when the source has none. */
    subtitle: string;
    /** Epoch ms; 0 means "unknown" (never rendered as 1970). */
    lastAt: number;
}

export interface RecentVideoItem extends RecentItemBase {
    kind: 'video';
    filename: string;
    progress: { percent: number | null };
}

export interface RecentArticleItem extends RecentItemBase {
    kind: 'article';
    articleId: string;
    progress: { paragraphIdx: number | null };
}

export interface RecentBookItem extends RecentItemBase {
    kind: 'book';
    bookId: string;
    bookSource: RecentBookSource;
    progress: { chapter: number };
}

export type RecentItem = RecentVideoItem | RecentArticleItem | RecentBookItem;

/**
 * Structural slice of `HistoryItem` this module needs. Keeping it here (rather
 * than importing the component type) keeps lib/ free of component imports;
 * `HistoryItem` is assignable to it.
 */
export interface RecentVideoSource {
    filename: string;
    videoId?: string;
    metadata?: { title?: string; channel?: string } | null;
    /** Backend milliseconds (0 = unknown). */
    updatedAt?: number;
    /** Backend legacy field: file mtime in seconds. */
    mtime?: number | null;
}

function positive(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Prefer the backend's `updatedAt`, fall back to the legacy seconds mtime. */
export function historyLastAt(item: RecentVideoSource): number {
    const updatedAt = positive(item.updatedAt);
    if (updatedAt > 0) return updatedAt;
    return positive(item.mtime) * 1000;
}

export function videoRecentItems(history: readonly RecentVideoSource[]): RecentVideoItem[] {
    return history.map((item) => ({
        kind: 'video',
        key: `video:${item.filename}`,
        filename: item.filename,
        title: (item.metadata?.title || item.filename).trim(),
        subtitle: (item.metadata?.channel || '').trim(),
        lastAt: historyLastAt(item),
        progress: { percent: item.videoId ? progressPercent(item.videoId) : null },
    }));
}

export function articleRecentItems(articles: readonly ArticleSummary[]): RecentArticleItem[] {
    return articles.map((article) => {
        const progressUpdatedAt = positive(article.progress?.updatedAt);
        return {
            kind: 'article',
            key: `article:${article.articleId}`,
            articleId: article.articleId,
            title: (article.title || article.articleId).trim(),
            subtitle: (article.site || '').trim(),
            lastAt: progressUpdatedAt || positive(article.createdAt),
            progress: { paragraphIdx: article.progress ? article.progress.paragraphIdx : null },
        };
    });
}

export function curatedBookRecentItems(
    progress: readonly BookProgressEntry[],
    index: BooksIndex,
): RecentBookItem[] {
    const books = new Map(index.series.flatMap((series) => series.books.map((book) => [book.id, book] as const)));
    const items: RecentBookItem[] = [];
    for (const entry of progress) {
        const book = books.get(entry.bookId);
        if (!book) continue; // Stale progress for a book that is no longer in the index.
        items.push({
            kind: 'book',
            key: `book:curated:${entry.bookId}`,
            bookId: entry.bookId,
            bookSource: 'curated',
            title: (book.titleZh || book.title).trim(),
            subtitle: book.title.trim(),
            lastAt: positive(entry.updated),
            progress: { chapter: Math.max(1, Math.trunc(entry.chapter)) },
        });
    }
    return items;
}

export function importedBookRecentItems(
    progress: readonly ImportedBookProgressEntry[],
    books: readonly ImportedBookSummary[],
): RecentBookItem[] {
    const known = new Map(books.map((book) => [book.bookId, book] as const));
    const items: RecentBookItem[] = [];
    for (const entry of progress) {
        const book = known.get(entry.bookId);
        if (!book) continue; // Removed/inaccessible import: no title, so no row.
        items.push({
            kind: 'book',
            key: `book:imported:${entry.bookId}`,
            bookId: entry.bookId,
            bookSource: 'imported',
            title: book.title.trim(),
            subtitle: (book.author || '').trim(),
            lastAt: positive(entry.updated),
            progress: { chapter: Math.max(1, Math.trunc(entry.chapter)) },
        });
    }
    return items;
}

/** Newest first; unknown timestamps (0) sink to the bottom. */
export function sortRecentItems(items: readonly RecentItem[]): RecentItem[] {
    return [...items].sort((left, right) => {
        const delta = positive(right.lastAt) - positive(left.lastAt);
        if (delta !== 0) return delta;
        return left.title.localeCompare(right.title);
    });
}

/** Case-insensitive title/subtitle search plus the type filter. */
export function filterRecentItems(
    items: readonly RecentItem[],
    filter: RecentFilter,
    query: string,
): RecentItem[] {
    const needle = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
        if (filter !== 'all' && item.kind !== filter) return false;
        if (!needle) return true;
        return (
            item.title.toLocaleLowerCase().includes(needle) ||
            item.subtitle.toLocaleLowerCase().includes(needle)
        );
    });
}

export function recentPageCount(items: readonly RecentItem[]): number {
    return Math.max(1, Math.ceil(items.length / RECENT_PAGE_SIZE));
}

export function paginateRecentItems(
    items: readonly RecentItem[],
    page: number,
): { page: number; pageCount: number; items: RecentItem[] } {
    const pageCount = recentPageCount(items);
    const safePage = Math.min(Math.max(1, Math.trunc(page)), pageCount);
    const start = (safePage - 1) * RECENT_PAGE_SIZE;
    return {
        page: safePage,
        pageCount,
        items: items.slice(start, start + RECENT_PAGE_SIZE),
    };
}
