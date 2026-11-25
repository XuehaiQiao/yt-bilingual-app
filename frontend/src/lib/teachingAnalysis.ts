// AI 教学分析（specs/028）的只读客户端。
//
// The backend caches teaching analysis by `content_hash + level + target_lang`
// and exposes it at GET /api/teaching-analysis/{content_ref}; authenticated
// users only (guests get 403). The video page has two sources of truth:
//
//   1. a freshly merged history payload (top-level `idioms` / `culture`), and
//   2. this endpoint, whose `highlights` override the legacy per-block
//      highlights baked into older translation payloads.
//
// Failures are deliberately silent at this layer: the player, transcript,
// dictionary and favorites must keep working even when analysis is unavailable.
import { apiFetch } from './api';
import { getRuntimeTargetLang, type LanguageCode } from '../i18n';
import type { VocabLevelId } from './settings';

/** Frozen backend recipe (backend/translate.py HIGHLIGHT_COLOR). */
export const TEACHING_HIGHLIGHT_COLOR =
    'bg-amber-400/[0.08] underline decoration-amber-400/50 decoration-dotted decoration-1 underline-offset-[3px]';

export interface TeachingHighlight {
    en_word: string;
    zh_word: string;
    color: string;
}

export interface TeachingIdiom {
    blockId: number | string;
    phrase: string;
    meaning: string;
    quote: string;
}

export interface TeachingCulture {
    blockId: number | string;
    term: string;
    note: string;
    quote: string;
}

/** Response of GET /api/teaching-analysis/{content_ref}. */
export interface TeachingAnalysis {
    contentRef: string;
    level: string;
    targetLang: string;
    contentHash: string;
    analysisVersion: string;
    /** Block id (as a JSON object key) → highlight entries. */
    highlights: Record<string, TeachingHighlight[]>;
    idioms: TeachingIdiom[];
    culture: TeachingCulture[];
    model?: string | null;
    createdAt?: number | string | null;
}

/** Why an analysis request produced no data (for the panel's empty states). */
export type TeachingAnalysisIssue = 'forbidden' | 'not-found' | 'error';

export interface FetchTeachingAnalysisOptions {
    signal?: AbortSignal;
    /** Defaults to the runtime target language; the page passes its state. */
    targetLang?: LanguageCode;
    /** Called when the backend explicitly refused / failed the request. */
    onIssue?: (issue: TeachingAnalysisIssue) => void;
}

const analysisCache = new Map<string, TeachingAnalysis>();

interface PendingFetch {
    controller: AbortController;
    outcome: Promise<FetchOutcome>;
    consumers: number;
    abortTimer: ReturnType<typeof setTimeout> | null;
    settled: boolean;
}

interface FetchOutcome {
    analysis: TeachingAnalysis | null;
    issue?: TeachingAnalysisIssue;
}

const pendingFetches = new Map<string, PendingFetch>();

// StrictMode mounts effects twice: the first consumer unsubscribes a tick
// before the second one subscribes. Holding the network request for a short
// grace period keeps that from turning one analysis request into two (and,
// more importantly, one AI generation into two).
const ABORT_GRACE_MS = 250;

export function teachingAnalysisCacheKey(
    contentRef: string,
    level: VocabLevelId | string,
    targetLang: LanguageCode | string,
): string {
    return `${targetLang}::${level}::${contentRef}`;
}

// ── Parsing helpers ───────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function blockIdOf(value: unknown): number | string | null {
    return typeof value === 'number' || typeof value === 'string' ? value : null;
}

function normalizeIdioms(raw: unknown): TeachingIdiom[] {
    if (!Array.isArray(raw)) return [];
    const items: TeachingIdiom[] = [];
    for (const entry of raw) {
        const record = asRecord(entry);
        if (!record) continue;
        const blockId = blockIdOf(record.blockId);
        const phrase = text(record.phrase);
        const meaning = text(record.meaning);
        if (blockId === null || !phrase.trim() || !meaning.trim()) continue;
        items.push({ blockId, phrase, meaning, quote: text(record.quote) });
    }
    return items;
}

function normalizeCulture(raw: unknown): TeachingCulture[] {
    if (!Array.isArray(raw)) return [];
    const items: TeachingCulture[] = [];
    for (const entry of raw) {
        const record = asRecord(entry);
        if (!record) continue;
        const blockId = blockIdOf(record.blockId);
        const term = text(record.term);
        const note = text(record.note);
        if (blockId === null || !term.trim() || !note.trim()) continue;
        items.push({ blockId, term, note, quote: text(record.quote) });
    }
    return items;
}

function normalizeHighlights(raw: unknown): Record<string, TeachingHighlight[]> {
    const result: Record<string, TeachingHighlight[]> = {};
    const record = asRecord(raw);
    if (!record) return result;
    for (const [blockId, value] of Object.entries(record)) {
        if (!Array.isArray(value)) continue;
        const entries: TeachingHighlight[] = [];
        for (const item of value) {
            const highlight = asRecord(item);
            if (!highlight) continue;
            const enWord = text(highlight.en_word);
            if (!enWord.trim()) continue;
            entries.push({
                en_word: enWord,
                zh_word: text(highlight.zh_word),
                // Ignore cached/server colours: the teaching-highlight recipe is frozen
                // and must match the reading difficulty mark.
                color: TEACHING_HIGHLIGHT_COLOR,
            });
        }
        if (entries.length > 0) result[blockId] = entries;
    }
    return result;
}

function normalizeResponse(
    raw: unknown,
    contentRef: string,
    level: string,
    targetLang: string,
): TeachingAnalysis | null {
    const record = asRecord(raw);
    if (!record) return null;
    return {
        contentRef: text(record.contentRef) || contentRef,
        level: text(record.level) || level,
        targetLang: text(record.targetLang) || targetLang,
        contentHash: text(record.contentHash),
        analysisVersion: text(record.analysisVersion),
        highlights: normalizeHighlights(record.highlights),
        idioms: normalizeIdioms(record.idioms),
        culture: normalizeCulture(record.culture),
        model: typeof record.model === 'string' ? record.model : null,
        createdAt:
            typeof record.createdAt === 'number' || typeof record.createdAt === 'string'
                ? record.createdAt
                : null,
    };
}

/**
 * Read the analysis fields the backend attaches to a cached video payload
 * (`idioms` / `culture` / `analysisVersion`). Payloads without them return
 * null, which tells the page to call the endpoint instead.
 */
export function teachingAnalysisFromPayload(payload: unknown): TeachingAnalysis | null {
    const record = asRecord(payload);
    if (!record) return null;
    const hasIdioms = Array.isArray(record.idioms);
    const hasCulture = Array.isArray(record.culture);
    if (!hasIdioms && !hasCulture) return null;
    return {
        contentRef: text(record.videoId) || text(record.contentRef),
        level: '',
        targetLang: text(record.targetLang),
        contentHash: '',
        analysisVersion: text(record.analysisVersion),
        // Block highlights are already merged into the payload transcript.
        highlights: {},
        idioms: normalizeIdioms(record.idioms),
        culture: normalizeCulture(record.culture),
        model: null,
        createdAt: null,
    };
}

/** Blocks shaped like the video page's TranscriptItem (timing preserved). */
export interface HighlightableBlock {
    id: number;
    start: number;
    end: number;
    en_text: string;
    zh_text: string;
    highlights: TeachingHighlight[];
}

function sameHighlights(
    a: TeachingHighlight[] | undefined | null,
    b: TeachingHighlight[],
): boolean {
    // v1.0 history payloads can carry blocks without a `highlights` key at
    // all. Treat that as an empty list, not a crash: analysis overlays are
    // allowed to replace legacy highlights, but the absence of the field is
    // a valid legacy shape.
    const left = Array.isArray(a) ? a : [];
    return left.length === b.length
        && left.every((entry, index) => (
            entry.en_word === b[index].en_word
            && entry.zh_word === b[index].zh_word
            && entry.color === b[index].color
        ));
}

/**
 * Overlay endpoint highlights on the transcript. The analysis owns every
 * block (blocks without entries become empty), matching the backend's
 * `merge_into_payload` semantics: a level change must not leave old-level
 * highlights behind. Blocks/text/timing are untouched. Callers keep the
 * payload transcript as the fallback when no analysis is available.
 */
export function applyTeachingAnalysisHighlights<T extends HighlightableBlock>(
    transcript: T[],
    highlights: Record<string, TeachingHighlight[]>,
): T[] {
    let changed = false;
    const next = transcript.map((block) => {
        const raw = highlights[String(block.id)];
        const mapped = Array.isArray(raw)
            ? raw
                .filter((entry) => entry && typeof entry.en_word === 'string' && entry.en_word.trim().length > 0)
                .map((entry) => ({
                    en_word: entry.en_word,
                    zh_word: typeof entry.zh_word === 'string' ? entry.zh_word : '',
                    color: TEACHING_HIGHLIGHT_COLOR,
                }))
            : [];
        const current = Array.isArray(block.highlights) ? block.highlights : [];
        if (sameHighlights(current, mapped)) return block;
        changed = true;
        return { ...block, highlights: mapped };
    });
    return changed ? next : transcript;
}

// ── Endpoint client ───────────────────────────────────────────────────────

async function requestTeachingAnalysis(
    contentRef: string,
    level: string,
    targetLang: string,
    signal: AbortSignal,
): Promise<FetchOutcome> {
    const query = new URLSearchParams({ level, targetLang });
    try {
        const response = await apiFetch(
            `/api/teaching-analysis/${encodeURIComponent(contentRef)}?${query.toString()}`,
            { signal },
        );
        if (response.status === 403) return { analysis: null, issue: 'forbidden' };
        if (response.status === 404) return { analysis: null, issue: 'not-found' };
        if (!response.ok) return { analysis: null, issue: 'error' };
        const data: unknown = await response.json().catch(() => null);
        const analysis = normalizeResponse(data, contentRef, level, targetLang);
        return analysis
            ? { analysis }
            : { analysis: null, issue: 'error' };
    } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError') {
            return { analysis: null };
        }
        return { analysis: null, issue: 'error' };
    }
}

function ensurePendingFetch(
    key: string,
    contentRef: string,
    level: string,
    targetLang: string,
): PendingFetch {
    const existing = pendingFetches.get(key);
    if (existing) return existing;

    const controller = new AbortController();
    const entry: PendingFetch = {
        controller,
        outcome: Promise.resolve({ analysis: null }),
        consumers: 0,
        abortTimer: null,
        settled: false,
    };
    entry.outcome = requestTeachingAnalysis(contentRef, level, targetLang, controller.signal)
        .then((outcome) => {
            if (outcome.analysis) analysisCache.set(key, outcome.analysis);
            return outcome;
        });
    pendingFetches.set(key, entry);
    void entry.outcome.finally(() => {
        entry.settled = true;
        if (pendingFetches.get(key) === entry) pendingFetches.delete(key);
    });
    return entry;
}

/**
 * Fetch (or reuse) the teaching analysis for one content/level/language key.
 *
 * Resolves to null for 403/404/network failures — never throws, so callers can
 * paint the video first and treat analysis as an enhancement. `onIssue`
 * carries the *reason* so the panel can distinguish "sign in" from
 * "no language points yet" without inspecting a response.
 */
export async function fetchTeachingAnalysis(
    contentRef: string,
    level: VocabLevelId | string,
    options: FetchTeachingAnalysisOptions = {},
): Promise<TeachingAnalysis | null> {
    const ref = String(contentRef || '').trim();
    if (!ref) return null;
    const targetLang = options.targetLang ?? getRuntimeTargetLang();
    const key = teachingAnalysisCacheKey(ref, level, targetLang);

    const cached = analysisCache.get(key);
    if (cached) return cached;

    const signal = options.signal;
    if (signal?.aborted) return null;

    const entry = ensurePendingFetch(key, ref, String(level), String(targetLang));
    entry.consumers += 1;
    if (entry.abortTimer !== null) {
        clearTimeout(entry.abortTimer);
        entry.abortTimer = null;
    }

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        entry.consumers = Math.max(0, entry.consumers - 1);
        if (entry.consumers > 0 || entry.settled) return;
        entry.abortTimer = setTimeout(() => {
            entry.abortTimer = null;
            if (entry.consumers === 0 && !entry.settled && pendingFetches.get(key) === entry) {
                entry.controller.abort();
            }
        }, ABORT_GRACE_MS);
    };

    const onAbort = () => release();
    signal?.addEventListener('abort', onAbort, { once: true });
    const aborted = signal
        ? new Promise<FetchOutcome>((resolve) => {
            if (signal.aborted) {
                resolve({ analysis: null });
                return;
            }
            signal.addEventListener('abort', () => resolve({ analysis: null }), { once: true });
        })
        : null;

    try {
        const outcome = aborted
            ? await Promise.race([entry.outcome, aborted])
            : await entry.outcome;
        if (!outcome.analysis && outcome.issue) options.onIssue?.(outcome.issue);
        return outcome.analysis;
    } finally {
        signal?.removeEventListener('abort', onAbort);
        release();
    }
}
