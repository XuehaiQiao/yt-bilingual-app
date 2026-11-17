// Imported public-domain books API client.
//
// A signed-in user pastes a Project Gutenberg / Standard Ebooks link, previews
// the metadata + chapter index, imports it into "My books", then reads one
// chapter at a time. The backend never stores the English source: every chapter
// open refetches it from the public-domain site. AI translations are cached
// per chapter and return as `zh` (the field name is historical; the value is in
// the current target language).
import { apiFetch } from './api';
import { getRuntimeTargetLang } from '../i18n';

export type ImportedSourceType = 'gutenberg' | 'standard_ebooks';

export interface ImportedQuotaInfo {
    feature: string;
    limitPerDay: number;
    usedToday: number | null;
    remainingToday: number | null;
    day: string | null;
}

export interface ImportedChapterIndexEntry {
    n: number;
    title: string;
    translated: boolean;
    translatedParagraphs: number;
}

export interface ImportPreview {
    sourceType: ImportedSourceType;
    source: { provider: string; url: string };
    sourceUrl: string;
    externalId: string;
    title: string;
    author: string | null;
    language: string;
    chapterCount: number;
    chapters: Array<{ n: number; title: string }>;
}

export interface ImportedBookSummary {
    bookId: string;
    sourceType: ImportedSourceType;
    source: { provider: string; url: string };
    sourceUrl: string;
    externalId: string;
    title: string;
    author: string | null;
    language: string;
    chapterCount: number;
    translatedChapters: number;
    targetLang: string;
    createdAt: number;
    updatedAt: number;
    chapters: ImportedChapterIndexEntry[];
    quota?: ImportedQuotaInfo;
    reused?: boolean;
}

export interface ImportedBookDetail extends ImportedBookSummary {
    chapters: ImportedChapterIndexEntry[];
}

export interface ImportedChapterParagraph {
    index: number;
    en: string;
    zh: string | null;
}

export interface ImportedChapter {
    bookId: string;
    title: string;
    author: string | null;
    sourceType: ImportedSourceType;
    source: {
        provider: string;
        url: string;
        fetchedAt: string;
        degraded: boolean;
    };
    sourceUrl: string;
    chapter: number;
    chapterTitle: string;
    chapterCount: number;
    targetLang: string;
    translated: boolean;
    translatedChapters: number;
    missingTranslations: number;
    paragraphs: ImportedChapterParagraph[];
    quota: ImportedQuotaInfo;
}

export interface TranslateChapterResult {
    bookId: string;
    chapter: number;
    targetLang: string;
    status: 'done' | 'cached' | 'partial';
    total: number;
    translated: number;
    failed: number;
    failedIndices: number[];
    model: string | null;
    batches: number;
    quota: ImportedQuotaInfo;
}

export class ImportedBooksApiError extends Error {
    readonly status: number;
    readonly detail: string;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'ImportedBooksApiError';
        this.status = status;
        this.detail = message;
    }
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

async function readError(response: Response): Promise<string> {
    try {
        const data = (await response.json()) as { detail?: unknown };
        if (typeof data?.detail === 'string' && data.detail.trim()) return data.detail;
    } catch {
        // Non-JSON error body: fall through.
    }
    return response.statusText || `HTTP ${response.status}`;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
    return apiFetch(path, init);
}

function parseSourceType(value: unknown): ImportedSourceType | null {
    return value === 'gutenberg' || value === 'standard_ebooks' ? value : null;
}

function parseQuota(value: unknown): ImportedQuotaInfo | undefined {
    if (!isRecord(value)) return undefined;
    const limit = asNumber(value.limitPerDay);
    const feature = asString(value.feature);
    if (limit === null || !feature) return undefined;
    return {
        feature,
        limitPerDay: limit,
        usedToday: asNumber(value.usedToday),
        remainingToday: asNumber(value.remainingToday),
        day: asString(value.day),
    };
}

function parseChapterIndex(value: unknown): ImportedChapterIndexEntry | null {
    if (!isRecord(value)) return null;
    const n = asNumber(value.n);
    const title = asString(value.title);
    if (n === null || !title) return null;
    return {
        n,
        title,
        translated: value.translated === true,
        translatedParagraphs: asNumber(value.translatedParagraphs) ?? 0,
    };
}

function parseSummary(value: unknown, withChapters: boolean): ImportedBookSummary | null {
    if (!isRecord(value)) return null;
    const bookId = asString(value.bookId);
    const sourceType = parseSourceType(value.sourceType);
    const title = asString(value.title);
    const externalId = asString(value.externalId);
    const language = asString(value.language);
    const chapterCount = asNumber(value.chapterCount);
    const translatedChapters = asNumber(value.translatedChapters);
    const targetLang = asString(value.targetLang);
    const source = isRecord(value.source) ? value.source : null;
    const provider = source ? asString(source.provider) : null;
    const sourceUrl = asString(value.sourceUrl);
    if (
        !bookId || !sourceType || !title || !externalId || !language || !source ||
        !provider || !sourceUrl || chapterCount === null || translatedChapters === null ||
        !targetLang
    ) {
        return null;
    }
    const rawChapters = Array.isArray(value.chapters) ? value.chapters : [];
    const chapters = rawChapters.map(parseChapterIndex);
    if (withChapters && chapters.some((entry): entry is null => entry === null)) {
        return null;
    }
    return {
        bookId,
        sourceType,
        source: { provider, url: sourceUrl },
        sourceUrl,
        externalId,
        title,
        author: asString(value.author),
        language,
        chapterCount,
        translatedChapters,
        targetLang,
        createdAt: asNumber(value.createdAt) ?? 0,
        updatedAt: asNumber(value.updatedAt) ?? 0,
        chapters: chapters.filter(
            (entry): entry is ImportedChapterIndexEntry => entry !== null,
        ),
        quota: parseQuota(value.quota),
        reused: value.reused === true,
    };
}

export async function previewImportedBook(url: string): Promise<ImportPreview> {
    const response = await request('/api/books/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
    });
    if (!response.ok) {
        throw new ImportedBooksApiError(await readError(response), response.status);
    }
    const data = (await response.json()) as unknown;
    if (!isRecord(data)) throw new ImportedBooksApiError('预览数据格式不正确', 0);
    const sourceType = parseSourceType(data.sourceType);
    const source = isRecord(data.source) ? data.source : null;
    const title = asString(data.title);
    const chapterCount = asNumber(data.chapterCount);
    const sourceUrl = asString(data.sourceUrl);
    const provider = source ? asString(source.provider) : null;
    if (!sourceType || !source || !provider || !title || !sourceUrl || chapterCount === null) {
        throw new ImportedBooksApiError('预览数据格式不正确', 0);
    }
    const rawChapters = Array.isArray(data.chapters) ? data.chapters : [];
    const chapters: Array<{ n: number; title: string }> = [];
    for (const entry of rawChapters) {
        if (!isRecord(entry)) throw new ImportedBooksApiError('章节数据格式不正确', 0);
        const n = asNumber(entry.n);
        const chapterTitle = asString(entry.title);
        if (n === null || !chapterTitle) {
            throw new ImportedBooksApiError('章节数据格式不正确', 0);
        }
        chapters.push({ n, title: chapterTitle });
    }
    return {
        sourceType,
        source: { provider, url: sourceUrl },
        sourceUrl,
        externalId: asString(data.externalId) ?? '',
        title,
        author: asString(data.author),
        language: asString(data.language) ?? 'en',
        chapterCount,
        chapters,
    };
}

export async function importPublicDomainBook(url: string): Promise<ImportedBookSummary> {
    const response = await request('/api/books/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
    });
    if (!response.ok) {
        throw new ImportedBooksApiError(await readError(response), response.status);
    }
    const payload = parseSummary(await response.json(), true);
    if (!payload) throw new ImportedBooksApiError('导入数据格式不正确', 0);
    return payload;
}

export async function fetchImportedBooks(signal?: AbortSignal): Promise<ImportedBookSummary[]> {
    const lang = getRuntimeTargetLang();
    const response = await request(
        `/api/books/imported?targetLang=${encodeURIComponent(lang)}`,
        { signal },
    );
    if (!response.ok) {
        throw new ImportedBooksApiError(await readError(response), response.status);
    }
    const data = (await response.json()) as unknown;
    if (!isRecord(data) || !Array.isArray(data.books)) {
        throw new ImportedBooksApiError('导入书目数据格式不正确', 0);
    }
    const books = data.books.map((entry) => parseSummary(entry, false));
    if (books.some((entry): entry is null => entry === null)) {
        throw new ImportedBooksApiError('导入书目数据格式不正确', 0);
    }
    return books as ImportedBookSummary[];
}

export async function fetchImportedBook(
    bookId: string,
    signal?: AbortSignal,
): Promise<ImportedBookDetail> {
    const lang = getRuntimeTargetLang();
    const response = await request(
        `/api/books/imported/${encodeURIComponent(bookId)}?targetLang=${encodeURIComponent(lang)}`,
        { signal },
    );
    if (!response.ok) {
        throw new ImportedBooksApiError(await readError(response), response.status);
    }
    const payload = parseSummary(await response.json(), true);
    if (!payload) throw new ImportedBooksApiError('书目数据格式不正确', 0);
    return payload as ImportedBookDetail;
}

export async function fetchImportedChapter(
    bookId: string,
    chapter: number,
    signal?: AbortSignal,
): Promise<ImportedChapter> {
    const lang = getRuntimeTargetLang();
    const response = await request(
        `/api/books/imported/${encodeURIComponent(bookId)}/chapters/${chapter}` +
            `?targetLang=${encodeURIComponent(lang)}`,
        { cache: 'no-store', signal },
    );
    if (!response.ok) {
        throw new ImportedBooksApiError(await readError(response), response.status);
    }
    const data = (await response.json()) as unknown;
    if (!isRecord(data) || !Array.isArray(data.paragraphs) || !isRecord(data.source)) {
        throw new ImportedBooksApiError('章节数据格式不正确', 0);
    }
    const paragraphs: ImportedChapterParagraph[] = [];
    for (const entry of data.paragraphs) {
        if (!isRecord(entry)) throw new ImportedBooksApiError('章节段落格式不正确', 0);
        const index = asNumber(entry.index);
        const en = asString(entry.en);
        const zh = entry.zh === null ? null : asString(entry.zh);
        if (index === null || !en || (entry.zh !== null && typeof zh !== 'string')) {
            throw new ImportedBooksApiError('章节段落格式不正确', 0);
        }
        paragraphs.push({ index, en, zh });
    }
    const source = data.source;
    const quota = parseQuota(data.quota);
    if (!quota) throw new ImportedBooksApiError('配额数据格式不正确', 0);
    return {
        bookId: asString(data.bookId) ?? bookId,
        title: asString(data.title) ?? '',
        author: asString(data.author),
        sourceType: parseSourceType(data.sourceType) ?? 'gutenberg',
        source: {
            provider: asString(source.provider) ?? '',
            url: asString(source.url) ?? '',
            fetchedAt: asString(source.fetchedAt) ?? '',
            degraded: source.degraded === true,
        },
        sourceUrl: asString(data.sourceUrl) ?? '',
        chapter: asNumber(data.chapter) ?? chapter,
        chapterTitle: asString(data.chapterTitle) ?? '',
        chapterCount: asNumber(data.chapterCount) ?? 0,
        targetLang: asString(data.targetLang) ?? getRuntimeTargetLang(),
        translated: data.translated === true,
        translatedChapters: asNumber(data.translatedChapters) ?? 0,
        missingTranslations: asNumber(data.missingTranslations) ?? 0,
        paragraphs,
        quota,
    };
}

export async function translateImportedChapter(
    bookId: string,
    chapter: number,
): Promise<TranslateChapterResult> {
    const response = await request(
        `/api/books/imported/${encodeURIComponent(bookId)}/chapters/${chapter}/translate`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetLang: getRuntimeTargetLang() }),
        },
    );
    if (!response.ok) {
        throw new ImportedBooksApiError(await readError(response), response.status);
    }
    const data = (await response.json()) as unknown;
    if (!isRecord(data)) throw new ImportedBooksApiError('翻译数据格式不正确', 0);
    const quota = parseQuota(data.quota);
    if (!quota) throw new ImportedBooksApiError('配额数据格式不正确', 0);
    const status = data.status;
    if (status !== 'done' && status !== 'cached' && status !== 'partial') {
        throw new ImportedBooksApiError('翻译数据格式不正确', 0);
    }
    const failedIndices = Array.isArray(data.failedIndices)
        ? data.failedIndices.filter((value): value is number => typeof value === 'number')
        : [];
    return {
        bookId: asString(data.bookId) ?? bookId,
        chapter: asNumber(data.chapter) ?? chapter,
        targetLang: asString(data.targetLang) ?? getRuntimeTargetLang(),
        status,
        total: asNumber(data.total) ?? 0,
        translated: asNumber(data.translated) ?? 0,
        failed: asNumber(data.failed) ?? 0,
        failedIndices,
        model: asString(data.model),
        batches: asNumber(data.batches) ?? 0,
        quota,
    };
}

export async function deleteImportedBook(bookId: string): Promise<void> {
    const response = await request(`/api/books/imported/${encodeURIComponent(bookId)}`, {
        method: 'DELETE',
    });
    if (!response.ok) {
        throw new ImportedBooksApiError(await readError(response), response.status);
    }
}

// ---------------------------------------------------------------------------
// Reading progress (local only; imported books are per-account anyway)
// ---------------------------------------------------------------------------

const PROGRESS_KEY = 'yt_bilingual_imported_books_progress';
const MAX_BOOK_ENTRIES = 100;

export interface ImportedBookProgress {
    chapter: number;
    paragraph: number;
    /** Epoch ms; `0` means the stored entry had no usable timestamp. */
    updated: number;
}

/** One localStorage entry plus the imported book id it belongs to. */
export interface ImportedBookProgressEntry extends ImportedBookProgress {
    bookId: string;
}

type ProgressMap = Record<string, ImportedBookProgress>;

function loadProgressMap(): ProgressMap {
    try {
        const parsed = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}') as unknown;
        return isRecord(parsed) ? (parsed as ProgressMap) : {};
    } catch {
        return {};
    }
}

export function getImportedBookProgress(bookId: string): ImportedBookProgress | null {
    const entry = loadProgressMap()[bookId];
    if (!isRecord(entry)) return null;
    const chapter = asNumber(entry.chapter);
    const paragraph = asNumber(entry.paragraph);
    const updated = asNumber(entry.updated);
    if (chapter === null || paragraph === null || updated === null) return null;
    return { chapter, paragraph, updated };
}

/**
 * All imported-book reading positions, newest first. The Today page joins
 * these ids with `GET /api/books/imported` for titles; malformed entries are
 * skipped and a missing timestamp stays `0` (unknown, never 1970).
 */
export function listImportedBookProgress(): ImportedBookProgressEntry[] {
    const entries: ImportedBookProgressEntry[] = [];
    for (const [bookId, entry] of Object.entries(loadProgressMap())) {
        if (!bookId || !isRecord(entry)) continue;
        const chapter = asNumber(entry.chapter);
        const paragraph = asNumber(entry.paragraph);
        if (chapter === null || paragraph === null) continue;
        entries.push({
            bookId,
            chapter,
            paragraph,
            updated: asNumber(entry.updated) ?? 0,
        });
    }
    return entries.sort((left, right) => right.updated - left.updated);
}

export function saveImportedBookProgress(
    bookId: string,
    chapter: number,
    paragraph: number,
): void {
    const map = loadProgressMap();
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
