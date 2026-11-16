// Public-domain book library API client.
//
// The backend stores only book metadata + our Chinese translations. Opening a
// chapter fetches the English source from Project Gutenberg on demand and
// aligns it with the local translation paragraph by paragraph (`zh: null`
// means the translation for that paragraph is still pending). Everything here
// is public and needs no login.
import { apiFetch } from './api';

export type BookLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export type BookStatus = 'available' | 'coming_soon';

export interface BookSummary {
    id: string;
    seriesId: string;
    title: string;
    titleZh: string;
    author: string;
    year: number;
    level: string;
    status: BookStatus;
    source: string;
    license: string;
    sourceUrl: string;
    totalChapters: number;
    readableChapters: number;
    catalogUrl?: string;
    contentNote?: string;
    gutenbergId?: number;
}

export interface BookSeries {
    id: string;
    title: string;
    author: string;
    description: string;
    totalBooks: number;
    availableBooks: number;
    readableChapters: number;
    books: BookSummary[];
}

export interface BooksIndex {
    series: BookSeries[];
    counts: {
        series: number;
        books: number;
        availableBooks: number;
        readableChapters: number;
    };
}

export interface BookChapterIndexEntry {
    n: number;
    title: string;
}

export interface BookDetail extends BookSummary {
    series: BookSeries;
    chapters: BookChapterIndexEntry[];
    message?: string;
}

export interface BookChapterParagraph {
    index: number;
    en: string;
    zh: string | null;
}

export interface BookChapterSource {
    provider: string;
    url: string;
    fetchedAt: string;
    degraded: boolean;
}

export interface BookChapter {
    bookId: string;
    bookTitle: string;
    bookTitleZh: string;
    author: string;
    level: string;
    license: string;
    chapter: number;
    chapterTitle: string;
    sourceTitle: string;
    totalChapters: number;
    importedChapters: number;
    seriesId: string;
    seriesTitle: string;
    contentNote?: string;
    translationMeta?: Record<string, unknown>;
    source: BookChapterSource;
    paragraphs: BookChapterParagraph[];
    missingTranslations: number;
}

export class BooksApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'BooksApiError';
        this.status = status;
    }
}

async function readError(response: Response): Promise<string> {
    try {
        const data = (await response.json()) as { detail?: unknown };
        if (typeof data?.detail === 'string' && data.detail.trim()) return data.detail;
    } catch {
        // Non-JSON error body: fall through to the status text.
    }
    return response.statusText || `HTTP ${response.status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBookSummary(value: unknown): BookSummary | null {
    if (!isRecord(value)) return null;
    const id = asString(value.id);
    const seriesId = asString(value.seriesId);
    const title = asString(value.title);
    const titleZh = asString(value.titleZh);
    const author = asString(value.author);
    const level = asString(value.level);
    const status = asString(value.status);
    const source = asString(value.source);
    const license = asString(value.license);
    const sourceUrl = asString(value.sourceUrl);
    const year = asNumber(value.year);
    const totalChapters = asNumber(value.totalChapters);
    const readableChapters = asNumber(value.readableChapters);
    if (
        !id || !seriesId || !title || !titleZh || !author || !level || !source || !license ||
        !sourceUrl || year === null || totalChapters === null || readableChapters === null ||
        (status !== 'available' && status !== 'coming_soon')
    ) {
        return null;
    }
    return {
        id,
        seriesId,
        title,
        titleZh,
        author,
        year,
        level,
        status,
        source,
        license,
        sourceUrl,
        totalChapters,
        readableChapters,
        catalogUrl: asString(value.catalogUrl) ?? undefined,
        contentNote: asString(value.contentNote) ?? undefined,
        gutenbergId: asNumber(value.gutenbergId) ?? undefined,
    };
}

function asSeries(value: unknown): BookSeries | null {
    if (!isRecord(value) || !Array.isArray(value.books)) return null;
    const id = asString(value.id);
    const title = asString(value.title);
    const author = asString(value.author);
    const description = asString(value.description);
    const totalBooks = asNumber(value.totalBooks);
    const availableBooks = asNumber(value.availableBooks);
    const readableChapters = asNumber(value.readableChapters);
    if (
        !id || !title || !author || !description || totalBooks === null ||
        availableBooks === null || readableChapters === null
    ) {
        return null;
    }
    const books = value.books.map(asBookSummary);
    if (books.some((book): book is null => book === null)) return null;
    return {
        id,
        title,
        author,
        description,
        totalBooks,
        availableBooks,
        readableChapters,
        books: books as BookSummary[],
    };
}

function asIndex(value: unknown): BooksIndex | null {
    if (!isRecord(value) || !Array.isArray(value.series) || !isRecord(value.counts)) return null;
    const series = value.series.map(asSeries);
    if (series.some((item): item is null => item === null)) return null;
    const counts = value.counts;
    const countSeries = asNumber(counts.series);
    const books = asNumber(counts.books);
    const availableBooks = asNumber(counts.availableBooks);
    const readableChapters = asNumber(counts.readableChapters);
    if (countSeries === null || books === null || availableBooks === null || readableChapters === null) {
        return null;
    }
    return {
        series: series as BookSeries[],
        counts: {
            series: countSeries,
            books,
            availableBooks,
            readableChapters,
        },
    };
}

export async function fetchBooksIndex(): Promise<BooksIndex> {
    const response = await apiFetch('/api/books');
    if (!response.ok) throw new BooksApiError(await readError(response), response.status);
    const payload = asIndex(await response.json());
    if (!payload) throw new BooksApiError('公版书数据格式不正确', 0);
    return payload;
}

export async function fetchBook(bookId: string): Promise<BookDetail> {
    const response = await apiFetch(`/api/books/${encodeURIComponent(bookId)}`);
    if (!response.ok) throw new BooksApiError(await readError(response), response.status);
    const data = (await response.json()) as unknown;
    if (!isRecord(data)) throw new BooksApiError('公版书数据格式不正确', 0);
    const summary = asBookSummary(data);
    const series = asSeries(data.series);
    if (!summary || !series || !Array.isArray(data.chapters)) {
        throw new BooksApiError('公版书数据格式不正确', 0);
    }
    const chapters = data.chapters
        .map((entry) => {
            if (!isRecord(entry)) return null;
            const n = asNumber(entry.n);
            const title = asString(entry.title);
            return n === null || !title ? null : { n, title };
        });
    if (chapters.some((entry): entry is null => entry === null)) {
        throw new BooksApiError('公版书章节数据格式不正确', 0);
    }
    return {
        ...summary,
        series,
        chapters: chapters as BookChapterIndexEntry[],
        message: asString(data.message) ?? undefined,
    };
}

export async function fetchBookChapter(bookId: string, n: number): Promise<BookChapter> {
    const response = await apiFetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${n}`, {
        cache: 'no-store',
    });
    if (!response.ok) throw new BooksApiError(await readError(response), response.status);
    const data = (await response.json()) as unknown;
    if (!isRecord(data) || !Array.isArray(data.paragraphs) || !isRecord(data.source)) {
        throw new BooksApiError('章节数据格式不正确', 0);
    }
    const paragraphs = data.paragraphs.map((entry) => {
        if (!isRecord(entry)) return null;
        const index = asNumber(entry.index);
        const en = asString(entry.en);
        const zh = entry.zh === null ? null : asString(entry.zh);
        if (index === null || !en || (entry.zh !== null && typeof zh !== 'string')) return null;
        return { index, en, zh };
    });
    if (paragraphs.some((entry): entry is null => entry === null)) {
        throw new BooksApiError('章节段落数据格式不正确', 0);
    }
    const source = data.source;
    return {
        bookId: String(data.bookId ?? ''),
        bookTitle: String(data.bookTitle ?? ''),
        bookTitleZh: String(data.bookTitleZh ?? ''),
        author: String(data.author ?? ''),
        level: String(data.level ?? ''),
        license: String(data.license ?? ''),
        chapter: asNumber(data.chapter) ?? n,
        chapterTitle: String(data.chapterTitle ?? ''),
        sourceTitle: String(data.sourceTitle ?? ''),
        totalChapters: asNumber(data.totalChapters) ?? 0,
        importedChapters: asNumber(data.importedChapters) ?? 0,
        seriesId: String(data.seriesId ?? ''),
        seriesTitle: String(data.seriesTitle ?? ''),
        contentNote: asString(data.contentNote) ?? undefined,
        translationMeta: isRecord(data.translationMeta) ? data.translationMeta : undefined,
        source: {
            provider: String(source.provider ?? ''),
            url: String(source.url ?? ''),
            fetchedAt: String(source.fetchedAt ?? ''),
            degraded: source.degraded === true,
        },
        paragraphs: paragraphs as BookChapterParagraph[],
        missingTranslations: asNumber(data.missingTranslations) ?? 0,
    };
}

// ---------------------------------------------------------------------------
// Reading progress (local only; guests included)
// ---------------------------------------------------------------------------

const PROGRESS_KEY = 'yt_bilingual_books_progress';
const MAX_BOOK_ENTRIES = 100;

export interface BookProgress {
    chapter: number;
    paragraph: number;
    updated: number;
}

type ProgressMap = Record<string, BookProgress>;

function loadMap(): ProgressMap {
    try {
        const parsed = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}') as unknown;
        return isRecord(parsed) ? (parsed as ProgressMap) : {};
    } catch {
        return {};
    }
}

export function getBookProgress(bookId: string): BookProgress | null {
    const entry = loadMap()[bookId];
    if (!isRecord(entry)) return null;
    const chapter = asNumber(entry.chapter);
    const paragraph = asNumber(entry.paragraph);
    const updated = asNumber(entry.updated);
    if (chapter === null || paragraph === null || updated === null) return null;
    return { chapter, paragraph, updated };
}

export function saveBookProgress(bookId: string, chapter: number, paragraph: number): void {
    const map = loadMap();
    map[bookId] = {
        chapter: Math.max(1, Math.trunc(chapter)),
        paragraph: Math.max(0, Math.trunc(paragraph)),
        updated: Date.now(),
    };
    const ids = Object.keys(map);
    if (ids.length > MAX_BOOK_ENTRIES) {
        ids
            .sort((a, b) => map[a].updated - map[b].updated)
            .slice(0, ids.length - MAX_BOOK_ENTRIES)
            .forEach((id) => delete map[id]);
    }
    try {
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
    } catch {
        // Storage full/blocked: progress is a convenience, never block reading.
    }
}
