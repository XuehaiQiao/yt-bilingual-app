import { apiFetch } from './api';
import { getRuntimeTargetLang } from '../i18n';
import type { LocalTranscriptBlock } from './localMedia';

export interface LocalVideoProcessedBlock {
    id: number;
    start: number;
    end: number;
    en_text: string;
    zh_text: string;
}

export interface LocalVideoProcessed {
    blocks: LocalVideoProcessedBlock[];
    targetLang: string;
    analysisVersion: string | null;
    analysisLevel: string | null;
    highlights: Record<string, Array<{ en_word: string; zh_word: string; color?: string }>>;
    idioms: Array<{ blockId: number | string; phrase: string; meaning: string; quote?: string }>;
    culture: Array<{ blockId: number | string; term: string; note: string; quote?: string }>;
    analysisError: string | null;
}

/**
 * Failed `/api/local-video/process` call. Carries the HTTP status and stable
 * backend `code` so the UI can map `login_required` / `model_unpriced` /
 * `insufficient_balance` / `quota_exceeded` to localized copy instead of
 * leaking the backend's Chinese detail.
 */
export class LocalVideoApiError extends Error {
    readonly status: number;
    readonly code?: string;

    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = 'LocalVideoApiError';
        this.status = status;
        this.code = code;
    }
}

export async function processLocalVideo(
    blocks: LocalTranscriptBlock[],
    level: string,
    signal?: AbortSignal,
): Promise<LocalVideoProcessed> {
    const response = await apiFetch('/api/local-video/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            blocks: blocks.map((block) => ({
                id: block.id,
                start: block.start,
                end: block.end,
                en: block.en_text,
            })),
            level,
            targetLang: getRuntimeTargetLang(),
        }),
        signal,
    });
    if (!response.ok) {
        let detail = '';
        let code: string | undefined;
        try {
            const payload = await response.json() as { detail?: unknown; code?: unknown };
            detail = typeof payload.detail === 'string' ? payload.detail : '';
            code = typeof payload.code === 'string' ? payload.code : undefined;
        } catch {
            // Keep the status fallback.
        }
        throw new LocalVideoApiError(
            detail || `HTTP ${response.status}`,
            response.status,
            code,
        );
    }
    const data = await response.json() as Partial<LocalVideoProcessed>;
    if (!Array.isArray(data.blocks)) throw new Error('invalid local video response');
    return {
        blocks: data.blocks.map((block) => ({
            id: Number(block.id),
            start: Number(block.start),
            end: Number(block.end),
            en_text: String(block.en_text ?? ''),
            zh_text: String(block.zh_text ?? ''),
        })),
        targetLang: String(data.targetLang ?? getRuntimeTargetLang()),
        analysisVersion: data.analysisVersion ?? null,
        analysisLevel: data.analysisLevel ?? null,
        highlights: data.highlights ?? {},
        idioms: data.idioms ?? [],
        culture: data.culture ?? [],
        analysisError: data.analysisError ?? null,
    };
}
