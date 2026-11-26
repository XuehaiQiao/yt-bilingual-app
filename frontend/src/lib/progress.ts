// Per-video playback progress, persisted locally for resume & history cards.
//
// P2-50: the map is user-private, so it lives in the identity-scoped namespace
// (`lib/storageScope.ts`) instead of the browser-wide v1 key. The v1 key is
// copied into the first identity's scope by the one-time migration.
import { readScoped, writeScoped, STORAGE_STORES } from './storageScope';

const PROGRESS_STORE = STORAGE_STORES.progress;
const MAX_ENTRIES = 200;

export interface ProgressEntry {
    time: number;      // last playback position (seconds)
    duration: number;  // approx. video duration (last transcript block end)
    updated: number;   // epoch ms
}

type ProgressMap = Record<string, ProgressEntry>;

export function loadProgressMap(): ProgressMap {
    const parsed = readScoped<unknown>(PROGRESS_STORE, null);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as ProgressMap)
        : {};
}

export function getProgress(videoId: string): ProgressEntry | null {
    return loadProgressMap()[videoId] ?? null;
}

export function saveProgress(videoId: string, time: number, duration: number) {
    const map = loadProgressMap();
    map[videoId] = { time, duration, updated: Date.now() };
    // Cap storage: drop the oldest entries beyond the limit
    const ids = Object.keys(map);
    if (ids.length > MAX_ENTRIES) {
        ids.sort((a, b) => map[a].updated - map[b].updated)
            .slice(0, ids.length - MAX_ENTRIES)
            .forEach(id => delete map[id]);
    }
    writeScoped(PROGRESS_STORE, map);
}

export function clearProgress(videoId: string) {
    const map = loadProgressMap();
    if (videoId in map) {
        delete map[videoId];
        writeScoped(PROGRESS_STORE, map);
    }
}

export function progressPercent(videoId: string): number | null {
    const p = getProgress(videoId);
    if (!p || !p.duration || p.duration < 60) return null;
    const pct = Math.round((p.time / p.duration) * 100);
    return pct >= 1 ? Math.min(pct, 99) : null;
}
