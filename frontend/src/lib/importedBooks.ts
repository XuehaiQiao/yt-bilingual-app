// Imported books API client.
//
// Two import paths share the same shelf + reader:
//   - public-domain link (Project Gutenberg / Standard Ebooks): the backend
//     stores only metadata/translations and refetches the English source on
//     every chapter open;
//   - local EPUB (specs/031): the user uploads a DRM-free file they own the
//     rights to; it is stored privately per account and chapter text is served
//     by the same chapter endpoint.
// AI translations are cached per chapter and return as `zh` (the field name is
// historical; the value is in the current target language).
import { api, apiFetch } from './api';
import { getRuntimeTargetLang } from '../i18n';

export type ImportedSourceType = 'gutenberg' | 'standard_ebooks' | 'local_epub';

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
    /** Local EPUB cover endpoint (`/api/books/imported/<id>/cover`) or null. */
    coverUrl?: string | null;
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

// ── Local EPUB upload (specs/031) ─────────────────────────────────────────
//
// The upload endpoints are multipart and slow enough that the dialog needs an
// explicit upload → parse phase plus cancellation. `LocalEpubError.code` is the
// transport-independent contract: the dialog maps it to a localized message,
// so a backend that only returns `{detail}` still produces an actionable error.

/** Hard limit from the product spec; also enforced server-side. */
export const LOCAL_EPUB_MAX_BYTES = 30 * 1024 * 1024;
const EPUB_MIME = 'application/epub+zip';

export type LocalEpubErrorCode =
    | 'notEpub'
    | 'drm'
    | 'tooLarge'
    | 'corrupt'
    | 'noChapters'
    | 'unsupportedLanguage'
    | 'rateLimited'
    | 'unauthorized'
    | 'network'
    | 'cancelled'
    | 'failed';

export class LocalEpubError extends Error {
    readonly code: LocalEpubErrorCode;
    readonly status: number;

    constructor(code: LocalEpubErrorCode, status = 0, message = '') {
        super(message || code);
        this.name = 'LocalEpubError';
        this.code = code;
        this.status = status;
    }
}

export interface LocalEpubPreviewChapter {
    n: number;
    title: string;
}

/** Result of `POST /api/books/upload/preview` (file parsed, not stored yet). */
export interface LocalEpubPreview {
    uploadToken: string;
    fileName: string;
    title: string;
    author: string | null;
    language: string;
    chapterCount: number;
    chapters: LocalEpubPreviewChapter[];
    coverDataUrl: string | null;
    sizeBytes: number;
}

export interface LocalEpubUploadResult {
    bookId: string;
    title: string;
    author: string | null;
    chapterCount: number;
    sourceType: 'local_epub';
    existing: boolean;
}

export interface LocalEpubPreviewOptions {
    signal?: AbortSignal;
    /** XHR upload body finished → the server is now parsing, not receiving. */
    onPhase?: (phase: 'uploading' | 'parsing') => void;
}

/** Extension first (some browsers report an empty MIME for `.epub`). */
export function isEpubFile(file: Pick<File, 'name' | 'type'>): boolean {
    return /\.epub$/i.test(file.name) || file.type === EPUB_MIME;
}

function localEpubCodeFromStatus(status: number, detail: string): LocalEpubErrorCode {
    // M7a: account-only entry points answer 403 `login_required` (401 is
    // reserved for a genuinely missing session). Both mean "go log in".
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 413) return 'tooLarge';
    if (status === 415) return 'notEpub';
    if (status === 429) return 'rateLimited';
    const text = detail.toLowerCase();
    if (/(drm|encrypt|protected|加密|版权保护)/.test(text)) return 'drm';
    if (/(too large|file size|exceed|30\s*mb|超过|上限|过大)/.test(text)) return 'tooLarge';
    if (/(没有可读正文|可读正文|no readable|no chapters|empty book|章节|spine)/.test(text)) {
        return 'noChapters';
    }
    // File-format rejections before language: the backend says
    // "只支持 .epub 格式的英文电子书" for a wrong file, which also contains 英文.
    if (
        /(只支持\s*\.?epub|not an? (valid )?epub|only epub|epub only|mime|extension|扩展名|格式)/.test(
            text,
        )
    ) {
        return 'notEpub';
    }
    if (/(只支持英文|non-english|unsupported language|检测到语言|language|英文\s*epub|语言)/.test(text)) {
        return 'unsupportedLanguage';
    }
    if (/(zip|corrupt|damaged|broken|损坏|无法读取)/.test(text)) return 'corrupt';
    // Expired upload tokens / previews: retryable, but not a corrupt file.
    if (/(凭证|过期|失效|重新选择|请重试|使用权|授权)/.test(text)) return 'failed';
    if (status === 400) return 'corrupt';
    return 'failed';
}

function localEpubErrorFromResponse(status: number, payload: unknown): LocalEpubError {
    let detail = '';
    if (isRecord(payload)) {
        detail = asString(payload.detail) ?? asString(payload.message) ?? '';
    }
    return new LocalEpubError(localEpubCodeFromStatus(status, detail), status, detail);
}

interface FormPostOptions {
    signal?: AbortSignal;
    onPhase?: (phase: 'uploading' | 'parsing') => void;
}

/**
 * POST a FormData body with XHR (fetch cannot report the upload phase) while
 * keeping the same abort + status mapping contract as the JSON endpoints.
 */
function postForm(path: string, form: FormData, options: FormPostOptions = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(new LocalEpubError('cancelled', 0));
            return;
        }
        const xhr = new XMLHttpRequest();
        let settled = false;
        const onAbort = () => {
            try {
                xhr.abort();
            } catch {
                // Already finished: onabort/onload settles the promise.
            }
        };
        const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
        const finish = (run: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            run();
        };

        options.signal?.addEventListener('abort', onAbort, { once: true });
        xhr.open('POST', api(path));
        xhr.withCredentials = true;
        // Mirror apiFetch's optional deployment guard (VITE_API_KEY).
        const apiKey = import.meta.env.VITE_API_KEY as string | undefined;
        if (apiKey) xhr.setRequestHeader('X-API-Key', apiKey);
        xhr.responseType = 'text';
        xhr.upload.onload = () => options.onPhase?.('parsing');
        xhr.onload = () => {
            let payload: unknown = null;
            try {
                payload = xhr.responseText ? (JSON.parse(xhr.responseText) as unknown) : null;
            } catch {
                payload = null;
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                finish(() => resolve(payload));
            } else {
                finish(() => reject(localEpubErrorFromResponse(xhr.status, payload)));
            }
        };
        xhr.onerror = () => finish(() => reject(new LocalEpubError('network', 0)));
        xhr.onabort = () => finish(() => reject(new LocalEpubError('cancelled', 0)));
        xhr.ontimeout = () => finish(() => reject(new LocalEpubError('network', 0)));
        options.onPhase?.('uploading');
        xhr.send(form);
    });
}

/** Upload one EPUB for parsing only (the backend keeps it for `uploadToken`). */
export async function previewLocalEpub(
    file: File,
    options: LocalEpubPreviewOptions = {},
): Promise<LocalEpubPreview> {
    if (!isEpubFile(file)) throw new LocalEpubError('notEpub', 0);
    if (file.size > LOCAL_EPUB_MAX_BYTES) throw new LocalEpubError('tooLarge', 0);

    const form = new FormData();
    form.append('file', file, file.name);
    const data = await postForm('/api/books/upload/preview', form, options);
    if (!isRecord(data)) throw new LocalEpubError('failed', 0);

    const uploadToken = asString(data.uploadToken);
    const title = asString(data.title);
    const chapterCount = asNumber(data.chapterCount);
    if (!uploadToken || !title || chapterCount === null) {
        throw new LocalEpubError('failed', 0);
    }
    const rawChapters = Array.isArray(data.chapters) ? data.chapters : [];
    const chapters: LocalEpubPreviewChapter[] = [];
    for (const entry of rawChapters) {
        if (!isRecord(entry)) throw new LocalEpubError('failed', 0);
        const n = asNumber(entry.n);
        const chapterTitle = asString(entry.title);
        if (n === null || !chapterTitle) throw new LocalEpubError('failed', 0);
        chapters.push({ n, title: chapterTitle });
    }
    const cover = data.coverDataUrl;
    return {
        uploadToken,
        fileName: asString(data.fileName) ?? file.name,
        title,
        author: asString(data.author),
        language: asString(data.language) ?? 'en',
        chapterCount,
        chapters,
        coverDataUrl: cover === null || cover === undefined ? null : asString(cover),
        sizeBytes: asNumber(data.sizeBytes) ?? file.size,
    };
}

/** Confirm a parsed upload; the backend returns the shelf entry (idempotent). */
export async function uploadLocalEpub(
    uploadToken: string,
    signal?: AbortSignal,
): Promise<LocalEpubUploadResult> {
    const token = uploadToken.trim();
    if (!token) throw new LocalEpubError('failed', 0);
    const form = new FormData();
    form.append('uploadToken', token);
    form.append('rightsAccepted', 'true');
    const data = await postForm('/api/books/upload', form, { signal });
    if (!isRecord(data)) throw new LocalEpubError('failed', 0);
    const bookId = asString(data.bookId);
    const title = asString(data.title);
    const chapterCount = asNumber(data.chapterCount);
    if (!bookId || !title || chapterCount === null) {
        throw new LocalEpubError('failed', 0);
    }
    return {
        bookId,
        title,
        author: asString(data.author),
        chapterCount,
        sourceType: 'local_epub',
        existing: data.existing === true,
    };
}

/**
 * Resolve the shelf cover URL. The backend may answer with an absolute URL or
 * a path on its own origin (`/api/books/imported/<id>/cover`); a bare path must
 * be pinned to the API origin or the browser would request the Vite dev server.
 */
export function importedBookCoverUrl(coverUrl: string | null | undefined): string | null {
    const value = typeof coverUrl === 'string' ? coverUrl.trim() : '';
    if (!value) return null;
    if (/^(?:https?:|data:|blob:)/i.test(value)) return value;
    return api(value.startsWith('/') ? value : `/${value}`);
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

export function parseSourceType(value: unknown): ImportedSourceType | null {
    return value === 'gutenberg' || value === 'standard_ebooks' || value === 'local_epub'
        ? value
        : null;
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
    // Local EPUB entries deliberately have no external URL (`sourceUrl: null`);
    // the two link sources still require one.
    const sourceUrl = asString(value.sourceUrl) ?? '';
    if (
        !bookId || !sourceType || !title || !externalId || !language || !source ||
        !provider || (sourceType !== 'local_epub' && !sourceUrl) || chapterCount === null ||
        translatedChapters === null || !targetLang
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
        coverUrl: asString(value.coverUrl),
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
