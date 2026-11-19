// Public-domain book library API client.
//
// The backend stores only book metadata + our Chinese translations. Opening a
// chapter fetches the English source from Project Gutenberg on demand and
// aligns it with the local translation paragraph by paragraph (`zh: null`
// means the translation for that paragraph is still pending). Everything here
// is public and needs no login.
import { apiFetch } from './api';
import { getRuntimeTargetLang, type LanguageCode } from '../i18n';

export type BookLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export type BookStatus = 'available' | 'coming_soon';
/** Paragraph completeness of one chapter translation (`missing` is the old default). */
export type BookTranslationStatus = 'cached' | 'partial' | 'missing';

/** Source-site cover for a catalog book, when the provider exposes one. */
export function bookCoverUrl(book: Pick<BookSummary, 'gutenbergId' | 'sourceUrl'>): string | null {
    if (typeof book.gutenbergId === 'number' && book.gutenbergId > 0) {
        return `https://www.gutenberg.org/cache/epub/${book.gutenbergId}/pg${book.gutenbergId}.cover.medium.jpg`;
    }
    const standard = /standardebooks\.org\/ebooks\/([^/]+)\/([^/]+)/i.exec(book.sourceUrl);
    if (standard) {
        return `https://standardebooks.org/ebooks/${standard[1]}/${standard[2]}/downloads/cover.jpg`;
    }
    return null;
}

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
    translatedChapters: number;
    publicDomainBasis: string;
    words?: number;
    catalogUrl?: string;
    contentNote?: string;
    gutenbergId?: number;
}

export interface BookExcluded {
    title: string;
    year: number;
    reason: string;
}

export interface BookSeries {
    id: string;
    title: string;
    author: string;
    description: string;
    totalBooks: number;
    availableBooks: number;
    readableChapters: number;
    translatedChapters: number;
    excluded: BookExcluded[];
    books: BookSummary[];
}

export interface BooksIndex {
    series: BookSeries[];
    counts: {
        series: number;
        books: number;
        availableBooks: number;
        readableChapters: number;
        translatedChapters: number;
    };
}

export interface BookChapterIndexEntry {
    n: number;
    title: string;
    titleZh?: string | null;
    translated: boolean;
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
    /** Contextual glosses from the optional analysis, keyed by lower-case word. */
    glosses: Record<string, string>;
}

export interface BookChapterSource {
    provider: string;
    url: string;
    fetchedAt: string;
    degraded: boolean;
}

export interface BookLanguagePoint {
    blockId: number;
    text: string;
    meaning: string;
    kind: 'idiom' | 'culture';
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
    /** `cached` = every paragraph translated, `partial` = some, `missing` = none. */
    translationStatus: BookTranslationStatus;
    translationSource?: string;
    translationModel?: string | null;
    translationUpdatedAt?: string | null;
    source: BookChapterSource;
    paragraphs: BookChapterParagraph[];
    missingTranslations: number;
    translated: boolean;
    translatedChapters: number;
    languagePoints: BookLanguagePoint[];
    analysisLevel: string | null;
}

/** POST translate response: the full chapter plus the cost/cache metadata. */
export interface BookChapterTranslation extends BookChapter {
    /** True when the chapter already had complete cached translations (no model call). */
    cached: boolean;
    outcome: 'cached' | 'done' | 'partial';
    translatedParagraphs: number;
    failedParagraphs: number;
    failedIndices: number[];
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
    const translatedChapters = asNumber(value.translatedChapters);
    const publicDomainBasis = asString(value.publicDomainBasis);
    if (
        !id || !seriesId || !title || !titleZh || !author || !level || !source || !license ||
        !sourceUrl || !publicDomainBasis || year === null || totalChapters === null ||
        readableChapters === null || translatedChapters === null ||
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
        translatedChapters,
        publicDomainBasis,
        words: asNumber(value.words) ?? undefined,
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
    const translatedChapters = asNumber(value.translatedChapters);
    if (
        !id || !title || !author || !description || totalBooks === null ||
        availableBooks === null || readableChapters === null || translatedChapters === null
    ) {
        return null;
    }
    const books = value.books.map(asBookSummary);
    if (books.some((book): book is null => book === null)) return null;
    const excludedRaw = Array.isArray(value.excluded) ? value.excluded : [];
    const excluded: BookExcluded[] = [];
    for (const entry of excludedRaw) {
        if (!isRecord(entry)) return null;
        const entryTitle = asString(entry.title);
        const entryYear = asNumber(entry.year);
        const reason = asString(entry.reason);
        if (!entryTitle || entryYear === null || !reason) return null;
        excluded.push({ title: entryTitle, year: entryYear, reason });
    }
    return {
        id,
        title,
        author,
        description,
        totalBooks,
        availableBooks,
        readableChapters,
        translatedChapters,
        excluded,
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
    const translatedChapters = asNumber(counts.translatedChapters);
    if (
        countSeries === null || books === null || availableBooks === null ||
        readableChapters === null || translatedChapters === null
    ) {
        return null;
    }
    return {
        series: series as BookSeries[],
        counts: {
            series: countSeries,
            books,
            availableBooks,
            readableChapters,
            translatedChapters,
        },
    };
}

export async function fetchBooksIndex(signal?: AbortSignal): Promise<BooksIndex> {
    const response = await apiFetch('/api/books', signal ? { signal } : undefined);
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
            const titleZh = entry.titleZh === null || entry.titleZh === undefined
                ? null
                : asString(entry.titleZh);
            const translated = entry.translated === true;
            return n === null || !title ? null : { n, title, titleZh, translated };
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

function asTranslationStatus(value: unknown): BookTranslationStatus | null {
    return value === 'cached' || value === 'partial' || value === 'missing' ? value : null;
}

/**
 * Parse one chapter payload. The GET and POST translate endpoints return the
 * same shape, so both go through here; `translationStatus` falls back to a
 * count-derived value when an older backend omits it.
 */
function asBookChapter(data: unknown, fallbackChapter: number): BookChapter {
    if (!isRecord(data) || !Array.isArray(data.paragraphs) || !isRecord(data.source)) {
        throw new BooksApiError('章节数据格式不正确', 0);
    }
    const paragraphs = data.paragraphs.map((entry) => {
        if (!isRecord(entry)) return null;
        const index = asNumber(entry.index);
        const en = asString(entry.en);
        const zh = entry.zh === null ? null : asString(entry.zh);
        if (index === null || !en || (entry.zh !== null && typeof zh !== 'string')) return null;
        const glosses: Record<string, string> = {};
        if (Array.isArray((entry as Record<string, unknown>).highlights)) {
            for (const raw of (entry as Record<string, unknown>).highlights as unknown[]) {
                if (!isRecord(raw)) continue;
                const word = asString(raw.en_word)?.trim().toLowerCase();
                const gloss = asString(raw.zh_word)?.trim();
                if (word && gloss) glosses[word] = gloss;
            }
        }
        return { index, en, zh, glosses };
    });
    if (paragraphs.some((entry): entry is null => entry === null)) {
        throw new BooksApiError('章节段落数据格式不正确', 0);
    }
    const parsed = paragraphs as BookChapterParagraph[];
    const source = data.source;
    const translatedCount = parsed.filter((paragraph) => Boolean(paragraph.zh?.trim())).length;
    const missingTranslations = asNumber(data.missingTranslations)
        ?? parsed.length - translatedCount;
    const languagePoints: BookLanguagePoint[] = [];
    for (const [rawKey, kind] of [['idioms', 'idiom'], ['culture', 'culture']] as const) {
        const raw = data[rawKey];
        if (!Array.isArray(raw)) continue;
        for (const entry of raw) {
            if (!isRecord(entry)) continue;
            const blockId = asNumber(entry.blockId);
            const text = asString(kind === 'idiom' ? entry.phrase : entry.term);
            const meaning = asString(kind === 'idiom' ? entry.meaning : entry.note);
            if (blockId !== null && text?.trim() && meaning?.trim()) {
                languagePoints.push({ blockId, text: text.trim(), meaning: meaning.trim(), kind });
            }
        }
    }
    const derivedStatus: BookTranslationStatus = missingTranslations <= 0
        ? 'cached'
        : translatedCount === 0
            ? 'missing'
            : 'partial';
    return {
        bookId: String(data.bookId ?? ''),
        bookTitle: String(data.bookTitle ?? ''),
        bookTitleZh: String(data.bookTitleZh ?? ''),
        author: String(data.author ?? ''),
        level: String(data.level ?? ''),
        license: String(data.license ?? ''),
        chapter: asNumber(data.chapter) ?? fallbackChapter,
        chapterTitle: String(data.chapterTitle ?? ''),
        sourceTitle: String(data.sourceTitle ?? ''),
        totalChapters: asNumber(data.totalChapters) ?? 0,
        importedChapters: asNumber(data.importedChapters) ?? 0,
        seriesId: String(data.seriesId ?? ''),
        seriesTitle: String(data.seriesTitle ?? ''),
        contentNote: asString(data.contentNote) ?? undefined,
        translationMeta: isRecord(data.translationMeta) ? data.translationMeta : undefined,
        translationStatus: asTranslationStatus(data.translationStatus) ?? derivedStatus,
        translationSource: asString(data.translationSource) ?? undefined,
        translationModel: asString(data.translationModel),
        translationUpdatedAt: asString(data.translationUpdatedAt),
        source: {
            provider: String(source.provider ?? ''),
            url: String(source.url ?? ''),
            fetchedAt: String(source.fetchedAt ?? ''),
            degraded: source.degraded === true,
        },
        paragraphs: parsed,
        missingTranslations,
        translated: data.translated === true,
        translatedChapters: asNumber(data.translatedChapters) ?? 0,
        languagePoints,
        analysisLevel: asString(data.analysisLevel),
    };
}

export async function fetchBookChapter(
    bookId: string,
    n: number,
    targetLang: LanguageCode = getRuntimeTargetLang(),
    level?: string | null,
): Promise<BookChapter> {
    const levelQuery = level ? `&level=${encodeURIComponent(level)}` : '';
    const query = `?targetLang=${encodeURIComponent(targetLang)}${levelQuery}`;
    const response = await apiFetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${n}${query}`, {
        cache: 'no-store',
    });
    if (!response.ok) throw new BooksApiError(await readError(response), response.status);
    return asBookChapter(await response.json(), n);
}

/**
 * Translate the missing paragraphs of one public-domain chapter on demand.
 *
 * Public (guests included); the backend rate-limits per IP and caches globally,
 * so a second call for an already-translated chapter returns `cached: true`
 * without calling a model. The response is the full chapter, ready to render.
 */
export async function translateBookChapter(
    bookId: string,
    n: number,
    targetLang: LanguageCode = getRuntimeTargetLang(),
): Promise<BookChapterTranslation> {
    const response = await apiFetch(
        `/api/books/${encodeURIComponent(bookId)}/chapters/${n}/translate`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetLang }),
            cache: 'no-store',
        },
    );
    if (!response.ok) throw new BooksApiError(await readError(response), response.status);
    const data = (await response.json()) as unknown;
    const chapter = asBookChapter(data, n);
    const record = isRecord(data) ? data : {};
    const rawOutcome = record.status;
    const outcome: BookChapterTranslation['outcome'] =
        rawOutcome === 'done' || rawOutcome === 'partial'
            ? rawOutcome
            : rawOutcome === 'cached' || record.cached === true
                ? 'cached'
                : chapter.translationStatus === 'cached'
                    ? 'cached'
                    : 'done';
    const failedIndices = Array.isArray(record.failedIndices)
        ? record.failedIndices.filter((value): value is number => typeof value === 'number')
        : [];
    return {
        ...chapter,
        cached: record.cached === true,
        outcome,
        translatedParagraphs: asNumber(record.translatedParagraphs)
            ?? chapter.paragraphs.filter((paragraph) => Boolean(paragraph.zh?.trim())).length,
        failedParagraphs: asNumber(record.failedParagraphs) ?? failedIndices.length,
        failedIndices,
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
    /** Epoch ms; `0` means the stored entry had no usable timestamp. */
    updated: number;
}

/** One localStorage entry plus the book id it belongs to. */
export interface BookProgressEntry extends BookProgress {
    bookId: string;
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

/**
 * All curated-book reading positions, newest first. The Today page joins these
 * ids with `/api/books` to recover titles; entries with malformed fields are
 * skipped instead of being guessed. A missing `updated` is kept as `0`
 * (unknown) so the UI can label it honestly.
 */
export function listBookProgress(): BookProgressEntry[] {
    const entries: BookProgressEntry[] = [];
    for (const [bookId, entry] of Object.entries(loadMap())) {
        if (!bookId || !isRecord(entry)) continue;
        const chapter = asNumber(entry.chapter);
        const paragraph = asNumber(entry.paragraph);
        if (chapter === null || paragraph === null) continue;
        entries.push({
            bookId,
            chapter: chapter,
            paragraph: paragraph,
            updated: asNumber(entry.updated) ?? 0,
        });
    }
    return entries.sort((left, right) => right.updated - left.updated);
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
