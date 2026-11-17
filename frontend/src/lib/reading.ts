// Reading client (specs/019-reading, frontend).
//
// The backend owns URL fetching/extraction, dedupe, paragraph limits, the
// per-language translation cache and the progress row. This module only
// mirrors the frozen HTTP contract and keeps the honesty rules:
//   - fields are rendered as the backend sent them; a malformed payload is
//     rejected, never filled with invented article content;
//   - no local "translated" state: the translate call returns what the
//     backend actually wrote (partial failures are reported per index);
//   - the current translation target language is explicit on every call
//     (`?targetLang=` for reads, `targetLang` in the body for translate) so
//     switching the target can never mix languages.
import { apiFetch } from './api';
import type { LanguageCode } from '../i18n';

export interface ArticleProgress {
    /** 0-based paragraph index of the last reading position. */
    paragraphIdx: number;
    /** Server milliseconds UTC. */
    updatedAt: number;
}

/** One row of `GET /api/articles`. */
export interface ArticleSummary {
    articleId: string;
    title: string;
    site: string | null;
    sourceUrl: string | null;
    lang: string;
    wordCount: number;
    createdAt: number;
    paragraphCount: number;
    progress: ArticleProgress | null;
}

/** One paragraph of `GET /api/article/{id}`. */
export interface ArticleParagraph {
    idx: number;
    text: string;
    /** `null` until the paragraph has been translated into `targetLang`. */
    translation: string | null;
    /** Catalog id of the model that produced the translation, if any. */
    translationModel: string | null;
    /** True when the backend stored `[未翻译]` for this paragraph. */
    translationFailed: boolean;
}

export interface ArticleStats {
    total: number;
    translated: number;
    untranslated: number;
}

/** Full payload of `GET /api/article/{id}?targetLang=`. */
export interface ArticleDetail {
    articleId: string;
    title: string;
    site: string | null;
    sourceUrl: string | null;
    lang: string;
    wordCount: number;
    createdAt: number;
    targetLang: string;
    paragraphs: ArticleParagraph[];
    progress: ArticleProgress | null;
    stats: ArticleStats;
}

/** `POST /api/article/import` — URL or pasted body, exactly one of them. */
export interface ImportedArticle {
    articleId: string;
    title: string;
    site: string | null;
    sourceUrl: string | null;
    lang: string;
    wordCount: number;
    createdAt: number;
    paragraphs: Array<{ idx: number; text: string }>;
    /** True when the same URL already existed and was reused. */
    reused: boolean;
}

export type TranslateStatus = 'cached' | 'done' | 'partial';

/** `POST /api/article/{id}/translate`. */
export interface TranslateResult {
    articleId: string;
    targetLang: string;
    status: TranslateStatus;
    total: number;
    translated: number;
    failed: number;
    failedIndices: number[];
    model: string | null;
    batches: number;
}

export interface ImportArticleInput {
    url?: string;
    text?: string;
    title?: string;
}

export interface SavedProgress {
    articleId: string;
    paragraphIdx: number;
    updatedAt: number;
}

export interface ReadingApiErrorOptions {
    status: number;
    detail?: string | null;
    retryAfterSeconds?: number | null;
}

/**
 * A failed reading request. `status` is the HTTP status, `0` for a network
 * failure and `-1` for a 2xx response whose shape is unusable. The UI maps
 * the status to localized copy; `detail` stays for diagnostics.
 */
export class ReadingApiError extends Error {
    readonly status: number;
    readonly detail: string | null;
    readonly retryAfterSeconds: number | null;

    constructor(message: string, options: ReadingApiErrorOptions) {
        super(message);
        this.name = 'ReadingApiError';
        this.status = options.status;
        this.detail = options.detail ?? null;
        this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNullableText(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function parseProgress(value: unknown): ArticleProgress | null {
    if (!isRecord(value)) return null;
    const paragraphIdx = value.paragraphIdx;
    if (typeof paragraphIdx !== 'number' || !Number.isInteger(paragraphIdx) || paragraphIdx < 0) {
        return null;
    }
    return { paragraphIdx, updatedAt: asNumber(value.updatedAt) };
}

function parseSummary(value: unknown): ArticleSummary | null {
    if (!isRecord(value)) return null;
    const articleId = asText(value.articleId).trim();
    if (!articleId) return null;
    return {
        articleId,
        title: asText(value.title),
        site: asNullableText(value.site),
        sourceUrl: asNullableText(value.sourceUrl),
        lang: asText(value.lang),
        wordCount: asNumber(value.wordCount),
        createdAt: asNumber(value.createdAt),
        paragraphCount: asNumber(value.paragraphCount),
        progress: parseProgress(value.progress),
    };
}

function parseParagraph(value: unknown): ArticleParagraph | null {
    if (!isRecord(value)) return null;
    const idx = value.idx;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) return null;
    return {
        idx,
        text: asText(value.text),
        translation: asNullableText(value.translation),
        translationModel: asNullableText(value.translationModel),
        translationFailed: value.translationFailed === true,
    };
}

function parseArticleDetail(value: unknown): ArticleDetail {
    if (!isRecord(value)) {
        throw new ReadingApiError('article response is not an object', { status: -1 });
    }
    const articleId = asText(value.articleId).trim();
    if (!articleId || !Array.isArray(value.paragraphs)) {
        throw new ReadingApiError('article response is missing articleId/paragraphs', { status: -1 });
    }
    const paragraphs = value.paragraphs
        .map(parseParagraph)
        .filter((paragraph): paragraph is ArticleParagraph => paragraph !== null);
    // `stats` is part of the contract. If it is missing, derive the counts from
    // the paragraphs we actually received (derived, never invented content).
    const derivedTranslated = paragraphs.filter(
        (paragraph) => !paragraph.translationFailed && typeof paragraph.translation === 'string'
            && paragraph.translation.trim() !== '',
    ).length;
    const rawStats = isRecord(value.stats) ? value.stats : null;
    const stats: ArticleStats = rawStats
        ? {
            total: asNumber(rawStats.total, paragraphs.length),
            translated: asNumber(rawStats.translated, derivedTranslated),
            untranslated: asNumber(rawStats.untranslated, Math.max(0, paragraphs.length - derivedTranslated)),
        }
        : {
            total: paragraphs.length,
            translated: derivedTranslated,
            untranslated: Math.max(0, paragraphs.length - derivedTranslated),
        };
    return {
        articleId,
        title: asText(value.title),
        site: asNullableText(value.site),
        sourceUrl: asNullableText(value.sourceUrl),
        lang: asText(value.lang),
        wordCount: asNumber(value.wordCount),
        createdAt: asNumber(value.createdAt),
        targetLang: asText(value.targetLang),
        paragraphs,
        progress: parseProgress(value.progress),
        stats,
    };
}

function parseImportedArticle(value: unknown): ImportedArticle {
    if (!isRecord(value) || !Array.isArray(value.paragraphs)) {
        throw new ReadingApiError('import response is missing paragraphs', { status: -1 });
    }
    const articleId = asText(value.articleId).trim();
    if (!articleId) {
        throw new ReadingApiError('import response is missing articleId', { status: -1 });
    }
    const paragraphs = value.paragraphs
        .map((paragraph) => {
            if (!isRecord(paragraph)) return null;
            const idx = paragraph.idx;
            if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) return null;
            return { idx, text: asText(paragraph.text) };
        })
        .filter((paragraph): paragraph is { idx: number; text: string } => paragraph !== null);
    return {
        articleId,
        title: asText(value.title),
        site: asNullableText(value.site),
        sourceUrl: asNullableText(value.sourceUrl),
        lang: asText(value.lang),
        wordCount: asNumber(value.wordCount),
        createdAt: asNumber(value.createdAt),
        paragraphs,
        reused: value.reused === true,
    };
}

const TRANSLATE_STATUSES: readonly TranslateStatus[] = ['cached', 'done', 'partial'];

function parseTranslateResult(value: unknown): TranslateResult {
    if (!isRecord(value) || typeof value.status !== 'string'
        || !(TRANSLATE_STATUSES as readonly string[]).includes(value.status)) {
        throw new ReadingApiError('translate response has an unknown status', { status: -1 });
    }
    return {
        articleId: asText(value.articleId),
        targetLang: asText(value.targetLang),
        status: value.status as TranslateStatus,
        total: asNumber(value.total),
        translated: asNumber(value.translated),
        failed: asNumber(value.failed),
        failedIndices: Array.isArray(value.failedIndices)
            ? value.failedIndices.filter((idx): idx is number => typeof idx === 'number' && Number.isInteger(idx))
            : [],
        model: asNullableText(value.model),
        batches: asNumber(value.batches),
    };
}

async function errorDetail(response: Response): Promise<string | null> {
    try {
        const body = (await response.json()) as { detail?: unknown };
        return typeof body?.detail === 'string' ? body.detail : null;
    } catch {
        // Non-JSON error body: status-based copy still works.
        return null;
    }
}

function retryAfterSeconds(response: Response): number | null {
    const raw = response.headers.get('Retry-After');
    if (!raw) return null;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

async function requestJson<T>(
    path: string,
    init: RequestInit | undefined,
    parse: (body: unknown) => T,
): Promise<T> {
    let response: Response;
    try {
        response = await apiFetch(path, init);
    } catch {
        throw new ReadingApiError('reading request failed', { status: 0 });
    }

    if (!response.ok) {
        throw new ReadingApiError(`reading request failed with HTTP ${response.status}`, {
            status: response.status,
            detail: await errorDetail(response),
            retryAfterSeconds: retryAfterSeconds(response),
        });
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new ReadingApiError('reading response is not JSON', { status: -1 });
    }
    return parse(body);
}

const jsonHeaders = { 'Content-Type': 'application/json' };

/** Import an article from a URL or pasted body (the backend accepts one). */
export function importArticle(input: ImportArticleInput): Promise<ImportedArticle> {
    const body: Record<string, string> = {};
    const url = input.url?.trim();
    const text = input.text;
    const title = input.title?.trim();
    if (url) body.url = url;
    if (text && text.trim()) body.text = text;
    if (title) body.title = title;
    return requestJson('/api/article/import', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
    }, parseImportedArticle);
}

/** Article detail for one target language, including existing translations. */
export function getArticle(articleId: string, targetLang: LanguageCode | string): Promise<ArticleDetail> {
    const path = `/api/article/${encodeURIComponent(articleId)}?targetLang=${encodeURIComponent(targetLang)}`;
    return requestJson(path, undefined, parseArticleDetail);
}

/**
 * Translate the paragraphs that have no usable translation yet. Safe to call
 * again after a partial failure: the backend only fills missing paragraphs.
 */
export function translateArticle(
    articleId: string,
    targetLang: LanguageCode | string,
): Promise<TranslateResult> {
    return requestJson(`/api/article/${encodeURIComponent(articleId)}/translate`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ targetLang }),
    }, parseTranslateResult);
}

/**
 * The current user's articles, newest first (with paragraph count/progress).
 * An optional `signal` lets callers drop the request when they unmount.
 */
export function listArticles(signal?: AbortSignal): Promise<ArticleSummary[]> {
    return requestJson('/api/articles', signal ? { signal } : undefined, (body) => {
        if (!isRecord(body) || !Array.isArray(body.articles)) {
            throw new ReadingApiError('articles response is missing articles', { status: -1 });
        }
        return body.articles
            .map(parseSummary)
            .filter((article): article is ArticleSummary => article !== null);
    });
}

/** Delete an article; paragraphs, translations and progress cascade server-side. */
export async function deleteArticle(articleId: string): Promise<void> {
    await requestJson(`/api/article/${encodeURIComponent(articleId)}`, { method: 'DELETE' }, () => undefined);
}

/** Persist the current paragraph (0-based). Out-of-range values are a 400. */
export function saveProgress(
    articleId: string,
    paragraphIdx: number,
): Promise<SavedProgress> {
    return requestJson(`/api/article/${encodeURIComponent(articleId)}/progress`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ paragraphIdx }),
    }, (body) => {
        if (!isRecord(body)) {
            throw new ReadingApiError('progress response is not an object', { status: -1 });
        }
        return {
            articleId: asText(body.articleId, articleId),
            paragraphIdx: asNumber(body.paragraphIdx, paragraphIdx),
            updatedAt: asNumber(body.updatedAt),
        };
    });
}
