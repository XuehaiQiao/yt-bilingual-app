// Reading analysis loader (specs/039 phase 1).
//
// The two prose readers paint the same language layer — contextual word glosses
// (`wordGlossesByBlock`) and always-visible language-point ruby
// (`languagePointsByBlock`) — but they used to load it in two different ways:
// the article reader refetched `/api/article/{id}?level=` and replaced the whole
// article object, while the free-library reader received maps computed by App
// from the payload analysis. This hook is the single place that decides where
// the layer comes from, so both surfaces can consume the same shape:
//
//   1. `payloadAnalysis` — analysis already delivered with the page payload
//      (article/book endpoints attach it inline; the free library attaches it in
//      App). It always wins and costs no extra request;
//   2. otherwise `load` — the default is `fetchTeachingAnalysis` for content refs
//      the teaching-analysis endpoint can resolve (video / local show). Readers
//      whose endpoint attaches analysis inline pass their own loader;
//   3. guests may still read a cached analysis (the endpoint / payload returns
//      it publicly). A 403 only means "generation needs an account": the hook
//      reports `status: 'login'` instead of throwing, and reading continues;
//   4. a failed lookup is enhancement-only (`status: 'error'`), never an
//      article-level error: words, ruby and the audio bar keep working.
//
// Level switches are handled here: `level` (or `contentRef` / `targetLang`) in
// the dependency list aborts the old request and starts a new one. Stale
// responses are dropped through a generation counter, so an older level can
// never paint over a newer one (interaction-spec IX-06).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LanguageCode } from '../i18n';
import type { InlineLanguagePoint } from '../components/TranscriptBlock';
import {
    fetchTeachingAnalysis,
    type TeachingAnalysis,
    type TeachingAnalysisIssue,
} from './teachingAnalysis';

/** The two per-block maps every reading surface consumes. */
export interface ReadingAnalysisMaps {
    /** Paragraph/block id (as an object key) → language points. */
    languagePointsByBlock: Record<string, InlineLanguagePoint[]>;
    /** Paragraph/block id (as an object key) → lower-case word → gloss. */
    wordGlossesByBlock: Record<string, Record<string, string>>;
}

/** Page-payload analysis or the endpoint response — both normalize to maps. */
export type ReadingAnalysisPayload = ReadingAnalysisMaps | TeachingAnalysis;

export type ReadingAnalysisStatus =
    /** No source yet (no content ref / layer switched off). */
    | 'idle'
    /** Request in flight; the previous level's maps are already cleared. */
    | 'loading'
    /** Analysis resolved (possibly empty: "no points" is not an error). */
    | 'ready'
    /** Signed-out/expired: generation needs an account, reading does not. */
    | 'login'
    /** Enhancement unavailable (network/5xx); never blocks reading. */
    | 'error';

export interface ReadingAnalysisLoadContext {
    contentRef: string;
    level: string;
    targetLang?: LanguageCode;
    signal: AbortSignal;
}

/** Loader used by surfaces whose endpoint attaches analysis inline. */
export type ReadingAnalysisLoader = (
    context: ReadingAnalysisLoadContext,
) => Promise<ReadingAnalysisPayload | null>;

export interface UseReadingAnalysisOptions {
    /** Stable content identity, e.g. `article:<id>` / `library:<id>`. */
    contentRef?: string | null;
    level?: string | null;
    targetLang?: LanguageCode;
    isGuest?: boolean;
    /** Analysis already in the page payload: wins, no request. */
    payloadAnalysis?: ReadingAnalysisPayload | null;
    /** False = the language layer is off; stay idle and request nothing. */
    enabled?: boolean;
    /** Override for content refs the teaching-analysis endpoint cannot load. */
    load?: ReadingAnalysisLoader;
}

export interface ReadingAnalysisResult extends ReadingAnalysisMaps {
    status: ReadingAnalysisStatus;
}

/** Fresh empty maps (never a shared mutable object). */
export function emptyReadingAnalysis(): ReadingAnalysisMaps {
    return { languagePointsByBlock: {}, wordGlossesByBlock: {} };
}

/** True when `value` already has the per-block map shape. */
function isReadingAnalysisMaps(value: ReadingAnalysisPayload): value is ReadingAnalysisMaps {
    return 'languagePointsByBlock' in value || 'wordGlossesByBlock' in value;
}

/**
 * Normalize a `TeachingAnalysis` (endpoint / payload analysis carrying raw
 * `idioms`, `culture` and `highlights`) into the two block maps. This mirrors
 * the video page's ready-made maps so the reading layer cannot drift from the
 * transcript layer.
 */
export function readingAnalysisMapsFromTeachingAnalysis(
    analysis: TeachingAnalysis | null | undefined,
): ReadingAnalysisMaps {
    const maps = emptyReadingAnalysis();
    if (!analysis) return maps;

    const pushPoint = (blockId: number | string, point: InlineLanguagePoint) => {
        if (!point.text.trim()) return;
        const key = String(blockId);
        (maps.languagePointsByBlock[key] ??= []).push(point);
    };
    for (const idiom of analysis.idioms ?? []) {
        pushPoint(idiom.blockId, {
            text: idiom.phrase,
            meaning: idiom.meaning,
            kind: 'idiom',
        });
    }
    for (const culture of analysis.culture ?? []) {
        pushPoint(culture.blockId, {
            text: culture.term,
            meaning: culture.note,
            kind: 'culture',
        });
    }
    for (const [blockId, entries] of Object.entries(analysis.highlights ?? {})) {
        const glosses: Record<string, string> = {};
        for (const entry of entries) {
            const word = entry.en_word?.trim().toLowerCase();
            const gloss = entry.zh_word?.trim();
            if (word && gloss) glosses[word] = gloss;
        }
        if (Object.keys(glosses).length > 0) maps.wordGlossesByBlock[blockId] = glosses;
    }
    return maps;
}

/** Normalize any accepted payload into maps (null when nothing was provided). */
export function normalizeReadingAnalysisPayload(
    payload: ReadingAnalysisPayload | null | undefined,
): ReadingAnalysisMaps | null {
    if (!payload) return null;
    if (isReadingAnalysisMaps(payload)) {
        return {
            languagePointsByBlock: payload.languagePointsByBlock ?? {},
            wordGlossesByBlock: payload.wordGlossesByBlock ?? {},
        };
    }
    return readingAnalysisMapsFromTeachingAnalysis(payload);
}

/** `403` from an inline payload endpoint still means "sign in to generate". */
class ReadingAnalysisLoginRequired extends Error {}

/** The default endpoint loader (video / local-show content refs). */
const loadFromTeachingAnalysis: ReadingAnalysisLoader = async ({
    contentRef,
    level,
    targetLang,
    signal,
}) => {
    let issue: TeachingAnalysisIssue | undefined;
    const analysis = await fetchTeachingAnalysis(contentRef, level, {
        targetLang,
        signal,
        onIssue: (next) => { issue = next; },
    });
    if (analysis) return analysis;
    if (issue === 'forbidden') throw new ReadingAnalysisLoginRequired();
    // `not-found` = this content has no analysis source at all; the layer is
    // simply empty (not an error, never a request loop).
    if (issue === 'not-found') return null;
    throw new Error('reading analysis unavailable');
};

function loginRequired(error: unknown): boolean {
    if (error instanceof ReadingAnalysisLoginRequired) return true;
    return (error as { status?: number } | null)?.status === 403;
}

/**
 * Load the reading language layer for one content/level/target language.
 * Returns the two maps plus a status the shell can use for a sign-in hint.
 *
 * The result is derived, not mirrored: the payload branch renders `ready`
 * directly, an in-flight branch renders `loading` until the effect's promise
 * resolves into `fetched`. That keeps `setState` out of the effect body (no
 * cascading render) and still guarantees the old level's maps never leak into
 * the new level: `fetched.key` is compared with the current request key.
 */
export function useReadingAnalysis({
    contentRef,
    level,
    targetLang,
    isGuest = false,
    payloadAnalysis = null,
    enabled = true,
    load,
}: UseReadingAnalysisOptions): ReadingAnalysisResult {
    const payload = useMemo(
        () => normalizeReadingAnalysisPayload(payloadAnalysis),
        [payloadAnalysis],
    );
    const ref = (contentRef ?? '').trim();
    const stop = (level ?? '').trim();
    // `null` = nothing to request: payload already answers, the layer is off,
    // or there is no content/level yet.
    const requestKey = !payload && enabled && ref && stop
        ? `${isGuest ? 'guest' : 'user'}\u0000${targetLang ?? ''}\u0000${stop}\u0000${ref}`
        : null;

    const [fetched, setFetched] = useState<{
        key: string;
        status: 'ready' | 'login' | 'error';
        maps: ReadingAnalysisMaps;
    } | null>(null);
    // Bumped on every new source; a resolved request only wins when its token
    // is still current, so an older level never paints over a newer one.
    const requestSeq = useRef(0);

    useEffect(() => {
        if (requestKey === null) return;
        const seq = ++requestSeq.current;
        const controller = new AbortController();
        const loader = load ?? loadFromTeachingAnalysis;
        loader({ contentRef: ref, level: stop, targetLang, signal: controller.signal })
            .then((next) => {
                if (seq !== requestSeq.current) return;
                setFetched({
                    key: requestKey,
                    status: 'ready',
                    maps: normalizeReadingAnalysisPayload(next) ?? emptyReadingAnalysis(),
                });
            })
            .catch((error: unknown) => {
                if (seq !== requestSeq.current || controller.signal.aborted) return;
                setFetched({
                    key: requestKey,
                    status: loginRequired(error) ? 'login' : 'error',
                    maps: emptyReadingAnalysis(),
                });
            });
        return () => {
            controller.abort();
            // Some payload clients have no AbortSignal support; invalidate the
            // attempt so a late response cannot paint over the next key.
            if (requestSeq.current === seq) requestSeq.current += 1;
        };
    }, [isGuest, load, ref, requestKey, stop, targetLang]);

    if (payload) {
        return {
            languagePointsByBlock: payload.languagePointsByBlock,
            wordGlossesByBlock: payload.wordGlossesByBlock,
            status: 'ready',
        };
    }
    if (!enabled || requestKey === null) {
        return { ...emptyReadingAnalysis(), status: 'idle' };
    }
    if (fetched && fetched.key === requestKey) {
        return {
            languagePointsByBlock: fetched.maps.languagePointsByBlock,
            wordGlossesByBlock: fetched.maps.wordGlossesByBlock,
            status: fetched.status,
        };
    }
    return { ...emptyReadingAnalysis(), status: 'loading' };
}
