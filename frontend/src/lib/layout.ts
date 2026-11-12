// Persistent layout preferences for the 看视频 (video) view.
//
// The video view is a two-column layout whose left column width is a user
// preference, plus one of two transcript placements:
//   stacked — transcript sits under the video; summary/vocabulary in the
//             right sidebar (the default)
//   split   — transcript docks to the right sidebar; summary/vocabulary sits
//             under the video
// Both choices survive reloads; the ratio is clamped so neither pane can be
// dragged into uselessness.

export type TranscriptLayout = 'stacked' | 'split';

export const TRANSCRIPT_LAYOUT_KEY = 'yt_bilingual_transcript_layout';

/** Left column width, as a percentage of the learning viewport. */
export const SPLIT_RATIO_KEY = 'yt_bilingual_split_ratio';

export const DEFAULT_SPLIT_RATIO = 56;
export const MIN_SPLIT_RATIO = 45;
export const MAX_SPLIT_RATIO = 80;

export function clampSplitRatio(percent: number): number {
    if (!Number.isFinite(percent)) return DEFAULT_SPLIT_RATIO;
    const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, percent));
    // Keep sub-percent precision so dragging feels continuous, not steppy.
    return Math.round(clamped * 100) / 100;
}

export function loadSplitRatio(): number {
    const raw = localStorage.getItem(SPLIT_RATIO_KEY);
    if (raw == null) return DEFAULT_SPLIT_RATIO;
    return clampSplitRatio(Number.parseFloat(raw));
}

export function saveSplitRatio(percent: number): void {
    localStorage.setItem(SPLIT_RATIO_KEY, String(clampSplitRatio(percent)));
}

export function loadTranscriptLayout(): TranscriptLayout {
    return localStorage.getItem(TRANSCRIPT_LAYOUT_KEY) === 'split' ? 'split' : 'stacked';
}

export function saveTranscriptLayout(layout: TranscriptLayout): void {
    localStorage.setItem(TRANSCRIPT_LAYOUT_KEY, layout);
}
