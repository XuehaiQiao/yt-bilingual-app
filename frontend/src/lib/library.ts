// Local free library API client (user request #11).
//
// The backend reads `content/library/*.json` directly — no database, no LLM.
// Videos carry pre-generated bilingual subtitle blocks (playback still uses the
// YouTube embed); articles are original English texts with a Chinese
// translation per paragraph. Everything here is public and needs no login.
import { apiFetch } from './api';

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
    paragraphs: LibraryArticleParagraph[];
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
    return {
        videos: videos as LibraryVideoSummary[],
        articles: articles as LibraryArticleSummary[],
    };
}

export async function fetchLibraryVideo(id: string): Promise<LibraryVideo> {
    const response = await apiFetch(`/api/library/videos/${encodeURIComponent(id)}`);
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
    return {
        ...summary,
        youtubeId: typeof data.youtubeId === 'string' ? data.youtubeId : '',
        free: data.free === true,
        source: typeof data.source === 'string' ? data.source : 'youtube',
        thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : undefined,
        license: typeof data.license === 'string' ? data.license : undefined,
        blocks: blocks as LibraryBlock[],
    };
}

export async function fetchLibraryArticle(id: string): Promise<LibraryArticle> {
    const response = await apiFetch(`/api/library/articles/${encodeURIComponent(id)}`);
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
    return {
        ...summary,
        author: typeof data.author === 'string' ? data.author : '',
        license: typeof data.license === 'string' ? data.license : '',
        topic: typeof data.topic === 'string' ? data.topic : undefined,
        summary: typeof data.summary === 'string' ? data.summary : undefined,
        paragraphs: paragraphs as LibraryArticleParagraph[],
    };
}
