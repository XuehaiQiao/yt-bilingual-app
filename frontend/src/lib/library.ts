// Local free library API client (user request #11).
//
// The backend reads `content/library/*.json` directly — no database, no LLM.
// Videos carry pre-generated bilingual subtitle blocks (playback still uses the
// YouTube embed); articles are original English texts with a Chinese
// translation per paragraph. Everything here is public and needs no login.
import { apiFetch } from './api';
import {
    teachingAnalysisFromPayload,
    type TeachingAnalysis,
    type TeachingHighlight,
} from './teachingAnalysis';

/** Optional analysis request (specs/028 × 024). Omitting it keeps the old call. */
export interface LibraryFetchOptions {
    /** CEFR highlight level (`liftoff`…`supernova`, specs/028 enum). */
    level?: string;
    /** Target language of the analysis cache (e.g. `zh-CN`, `vi-VN`). */
    targetLang?: string;
    signal?: AbortSignal;
}

export interface LibraryVideoSummary {
    id: string;
    title: string;
    channel: string;
    /** Seconds, as reported by YouTube. */
    duration: number;
    level: string;
}

export interface LibraryArticleSummary {
    id: string;
    title: string;
    level: string;
    wordCount: number;
}

export interface LibraryIndex {
    videos: LibraryVideoSummary[];
    articles: LibraryArticleSummary[];
    /** Server-computed totals (the UI still derives chips from `videos`). */
    counts?: { videos: number; articles: number };
    /** Server-computed CEFR distribution for the video tab chips. */
    videoLevels?: Record<string, number>;
}

export interface LibraryHighlight {
    en_word: string;
    zh_word: string;
    color: string;
}

export interface LibraryBlock {
    id: number;
    start: number;
    end: number;
    en_text: string;
    zh_text: string;
    highlights: LibraryHighlight[];
}

export interface LibraryVideo extends LibraryVideoSummary {
    youtubeId: string;
    free: boolean;
    source: string;
    thumbnail?: string;
    license?: string;
    blocks: LibraryBlock[];
    /**
     * Merged teaching analysis (specs/028) when the backend attached one to the
     * payload. `null` = no cached analysis (guest cache miss / generation
     * failed); the page treats that as "enhancement unavailable", never an
     * error.
     */
    analysis?: TeachingAnalysis | null;
}

export interface LibraryArticleParagraph {
    en: string;
    zh: string;
}

export interface LibraryArticle extends LibraryArticleSummary {
    author: string;
    license: string;
    topic?: string;
    summary?: string;
    /** `original` (in-house) or `public-domain` (Project Gutenberg). */
    source?: 'original' | 'public-domain';
    /** Gutenberg ebook number + canonical link for public-domain articles. */
    gutenbergId?: number;
    sourceUrl?: string;
    publicDomainBasis?: string;
    paragraphs: LibraryArticleParagraph[];
    /** See `LibraryVideo.analysis`; highlights are keyed by paragraph index. */
    analysis?: TeachingAnalysis | null;
}

export class LibraryApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'LibraryApiError';
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

function asVideoSummary(value: unknown): LibraryVideoSummary | null {
    if (!isRecord(value)) return null;
    const { id, title, channel, duration, level } = value;
    if (
        typeof id !== 'string' ||
        typeof title !== 'string' ||
        typeof channel !== 'string' ||
        typeof duration !== 'number' ||
        !Number.isFinite(duration) ||
        typeof level !== 'string'
    ) {
        return null;
    }
    return { id, title, channel, duration, level };
}

function asArticleSummary(value: unknown): LibraryArticleSummary | null {
    if (!isRecord(value)) return null;
    const { id, title, level, wordCount } = value;
    if (
        typeof id !== 'string' ||
        typeof title !== 'string' ||
        typeof level !== 'string' ||
        typeof wordCount !== 'number' ||
        !Number.isFinite(wordCount)
    ) {
        return null;
    }
    return { id, title, level, wordCount };
}

function asHighlight(value: unknown): LibraryHighlight | null {
    if (!isRecord(value)) return null;
    const { en_word, zh_word, color } = value;
    if (typeof en_word !== 'string' || typeof zh_word !== 'string' || typeof color !== 'string') {
        return null;
    }
    return { en_word, zh_word, color };
}

function asBlock(value: unknown): LibraryBlock | null {
    if (!isRecord(value)) return null;
    const { id, start, end, en_text, zh_text, highlights } = value;
    if (
        typeof id !== 'number' ||
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        typeof en_text !== 'string' ||
        typeof zh_text !== 'string' ||
        !Array.isArray(highlights)
    ) {
        return null;
    }
    const parsed = highlights.map(asHighlight);
    if (parsed.some((item): item is null => item === null)) return null;
    return {
        id,
        start,
        end,
        en_text,
        zh_text,
        highlights: parsed as LibraryHighlight[],
    };
}

function asParagraph(value: unknown): LibraryArticleParagraph | null {
    if (!isRecord(value)) return null;
    const { en, zh } = value;
    if (typeof en !== 'string' || typeof zh !== 'string') return null;
    return { en, zh };
}

// ── Teaching analysis attached to a free-library payload (specs/028 × 024) ──
//
// With `?level=` the backend merges the cached (or on-demand generated)
// analysis into the same payload: highlights per block + top-level
// idioms/culture. The client keeps that merged copy so the page can paint the
// language-point panel and the contextual ruby without a second request.
// Payloads without analysis fields produce `null` (an enhancement miss, not an
// error).

function asTeachingHighlight(value: unknown): TeachingHighlight | null {
    const highlight = asHighlight(value);
    if (!highlight) return null;
    return { en_word: highlight.en_word, zh_word: highlight.zh_word, color: highlight.color };
}

function highlightEntries(value: unknown): TeachingHighlight[] {
    if (!Array.isArray(value)) return [];
    return value
        .map(asTeachingHighlight)
        .filter((item): item is TeachingHighlight => item !== null);
}

function videoAnalysis(raw: Record<string, unknown>, video: LibraryVideo): TeachingAnalysis | null {
    const fromPayload = teachingAnalysisFromPayload(raw);
    if (!fromPayload) return null;
    const highlights: Record<string, TeachingHighlight[]> = {};
    for (const block of video.blocks) {
        const entries = highlightEntries(block.highlights);
        if (entries.length > 0) highlights[String(block.id)] = entries;
    }
    return {
        ...fromPayload,
        contentRef: fromPayload.contentRef || video.id,
        highlights,
    };
}

/**
 * Article analysis keyed by paragraph index (0-based), matching both the
 * backend merge contract (`paragraphs[i].highlights`, `blockId` = paragraph
 * index) and how `LibraryArticleReader` addresses its paragraphs.
 */
function articleAnalysis(raw: Record<string, unknown>, article: LibraryArticle): TeachingAnalysis | null {
    const fromPayload = teachingAnalysisFromPayload(raw);
    if (!fromPayload) return null;
    const rawParagraphs = Array.isArray(raw.paragraphs) ? raw.paragraphs : [];
    const highlights: Record<string, TeachingHighlight[]> = {};
    rawParagraphs.forEach((item, index) => {
        if (!isRecord(item)) return;
        const entries = highlightEntries(item.highlights);
        if (entries.length > 0) highlights[String(index)] = entries;
    });
    return {
        ...fromPayload,
        contentRef: fromPayload.contentRef || article.id,
        level: typeof raw.analysisLevel === 'string' ? raw.analysisLevel : fromPayload.level,
        highlights,
    };
}

function libraryQuery(options?: LibraryFetchOptions): string {
    if (!options) return '';
    const params = new URLSearchParams();
    if (options.level) params.set('level', options.level);
    if (options.targetLang) params.set('targetLang', options.targetLang);
    const query = params.toString();
    return query ? `?${query}` : '';
}

/**
 * `init` for the optional analysis request. A `level` request may generate and
 * bill server-side, so it must not be served from the browser's HTTP cache: a
 * guest visit can otherwise pin the analysis-less 200 for an hour. Without
 * options the call keeps the old shape (no query, default fetch init).
 */
function libraryInit(options?: LibraryFetchOptions): RequestInit | undefined {
    if (!options) return undefined;
    const init: RequestInit = {};
    if (options.signal) init.signal = options.signal;
    if (options.level || options.targetLang) init.cache = 'no-store';
    return Object.keys(init).length > 0 ? init : undefined;
}

export async function fetchLibraryIndex(): Promise<LibraryIndex> {
    const response = await apiFetch('/api/library');
    if (!response.ok) throw new LibraryApiError(await readError(response), response.status);
    const data = (await response.json()) as unknown;
    if (!isRecord(data) || !Array.isArray(data.videos) || !Array.isArray(data.articles)) {
        throw new LibraryApiError('免费资源数据格式不正确', 0);
    }
    const videos = data.videos.map(asVideoSummary);
    const articles = data.articles.map(asArticleSummary);
    if (videos.some((item): item is null => item === null) || articles.some((item): item is null => item === null)) {
        throw new LibraryApiError('免费资源数据格式不正确', 0);
    }
    const counts = isRecord(data.counts)
        ? {
              videos: typeof data.counts.videos === 'number' ? data.counts.videos : videos.length,
              articles: typeof data.counts.articles === 'number' ? data.counts.articles : articles.length,
          }
        : undefined;
    const videoLevels = isRecord(data.videoLevels)
        ? Object.fromEntries(
              Object.entries(data.videoLevels).filter(
                  (entry): entry is [string, number] => typeof entry[1] === 'number',
              ),
          )
        : undefined;
    return {
        videos: videos as LibraryVideoSummary[],
        articles: articles as LibraryArticleSummary[],
        counts,
        videoLevels,
    };
}

export async function fetchLibraryVideo(
    id: string,
    options?: LibraryFetchOptions,
): Promise<LibraryVideo> {
    const response = await apiFetch(
        `/api/library/videos/${encodeURIComponent(id)}${libraryQuery(options)}`,
        libraryInit(options),
    );
    if (!response.ok) throw new LibraryApiError(await readError(response), response.status);
    const data = (await response.json()) as unknown;
    const summary = asVideoSummary(data);
    if (!isRecord(data) || !summary || !Array.isArray(data.blocks)) {
        throw new LibraryApiError('视频数据格式不正确', 0);
    }
    const blocks = data.blocks.map(asBlock);
    if (blocks.some((item): item is null => item === null)) {
        throw new LibraryApiError('视频字幕数据格式不正确', 0);
    }
    const video: LibraryVideo = {
        ...summary,
        youtubeId: typeof data.youtubeId === 'string' ? data.youtubeId : '',
        free: data.free === true,
        source: typeof data.source === 'string' ? data.source : 'youtube',
        thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : undefined,
        license: typeof data.license === 'string' ? data.license : undefined,
        blocks: blocks as LibraryBlock[],
    };
    return { ...video, analysis: videoAnalysis(data, video) };
}

export async function fetchLibraryArticle(
    id: string,
    options?: LibraryFetchOptions,
): Promise<LibraryArticle> {
    const response = await apiFetch(
        `/api/library/articles/${encodeURIComponent(id)}${libraryQuery(options)}`,
        libraryInit(options),
    );
    if (!response.ok) throw new LibraryApiError(await readError(response), response.status);
    const data = (await response.json()) as unknown;
    const summary = asArticleSummary(data);
    if (!isRecord(data) || !summary || !Array.isArray(data.paragraphs)) {
        throw new LibraryApiError('文章数据格式不正确', 0);
    }
    const paragraphs = data.paragraphs.map(asParagraph);
    if (paragraphs.some((item): item is null => item === null)) {
        throw new LibraryApiError('文章段落数据格式不正确', 0);
    }
    const article: LibraryArticle = {
        ...summary,
        author: typeof data.author === 'string' ? data.author : '',
        license: typeof data.license === 'string' ? data.license : '',
        topic: typeof data.topic === 'string' ? data.topic : undefined,
        summary: typeof data.summary === 'string' ? data.summary : undefined,
        source:
            data.source === 'public-domain'
                ? 'public-domain'
                : data.source === 'original'
                  ? 'original'
                  : undefined,
        gutenbergId: typeof data.gutenbergId === 'number' ? data.gutenbergId : undefined,
        sourceUrl: typeof data.sourceUrl === 'string' ? data.sourceUrl : undefined,
        publicDomainBasis: typeof data.publicDomainBasis === 'string' ? data.publicDomainBasis : undefined,
        paragraphs: paragraphs as LibraryArticleParagraph[],
    };
    return { ...article, analysis: articleAnalysis(data, article) };
}
