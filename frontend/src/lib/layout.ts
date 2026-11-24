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

// ── Watch mode (specs/044) ─────────────────────────────────────────────────
// 观影模式 is a per-device preference for the video learning view: the media
// becomes the main region, the transcript collapses to a single-sentence
// overlay and the teaching panel is not mounted at all. It is stored
// separately from the transcript placement / split ratio so toggling it never
// resets the two existing layout preferences.
export type WatchMode = 'off' | 'on';

export const WATCH_MODE_KEY = 'yt_bilingual_watch_mode';

export function loadWatchMode(): WatchMode {
    try {
        return localStorage.getItem(WATCH_MODE_KEY) === 'on' ? 'on' : 'off';
    } catch {
        // Private-mode storage failures must never break the learning view.
        return 'off';
    }
}

export function saveWatchMode(mode: WatchMode): void {
    try {
        localStorage.setItem(WATCH_MODE_KEY, mode === 'on' ? 'on' : 'off');
    } catch {
        // Private-mode storage failures must never break the learning view.
    }
}

// ── Watch-mode subtitles (specs/045 §4.2.1) ────────────────────────────────
// Three states, one preference per device:
//   bilingual — English above the Chinese support line (default)
//   english   — English only, still the app's per-sentence overlay
//   off       — the overlay is not rendered at all, so the video's own
//               captions can be used untouched
// The mode is stored beside (not inside) the watch-mode flag: entering /
// leaving 观影模式 never resets a learner's caption preference.
export type WatchSubtitleMode = 'bilingual' | 'english' | 'off';

export const WATCH_SUBTITLE_MODE_KEY = 'yt_bilingual_watch_subtitle_mode';

/** Cycle order used by the `C` shortcut and documented in the CC menu. */
export const WATCH_SUBTITLE_MODES: readonly WatchSubtitleMode[] = ['bilingual', 'english', 'off'];

export function normalizeWatchSubtitleMode(value: string | null | undefined): WatchSubtitleMode {
    return value === 'english' || value === 'off' ? value : 'bilingual';
}

export function loadWatchSubtitleMode(): WatchSubtitleMode {
    try {
        return normalizeWatchSubtitleMode(localStorage.getItem(WATCH_SUBTITLE_MODE_KEY));
    } catch {
        // Private-mode storage failures must never break the learning view.
        return 'bilingual';
    }
}

export function saveWatchSubtitleMode(mode: WatchSubtitleMode): void {
    try {
        localStorage.setItem(WATCH_SUBTITLE_MODE_KEY, normalizeWatchSubtitleMode(mode));
    } catch {
        // Private-mode storage failures must never break the learning view.
    }
}

export function cycleWatchSubtitleMode(mode: WatchSubtitleMode): WatchSubtitleMode {
    const index = WATCH_SUBTITLE_MODES.indexOf(normalizeWatchSubtitleMode(mode));
    return WATCH_SUBTITLE_MODES[(index + 1) % WATCH_SUBTITLE_MODES.length];
}

// ── Desktop sidebar ────────────────────────────────────────────────────────
// The ≥lg navigation rail is 240px expanded and 72px collapsed (icon-only).
// The preference survives reloads; the shell itself stays stateless.
export const SIDEBAR_COLLAPSED_KEY = 'yt_bilingual_sidebar_collapsed';

export function loadSidebarCollapsed(): boolean {
    try {
        return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
    } catch {
        return false;
    }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
    try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
        // Private-mode storage failures must never break the shell.
    }
}
