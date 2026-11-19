// Browser-local video session: the file never leaves the tab. The video is
// played from an object URL; SRT/VTT is parsed client-side into the same
// transcript-block shape the streaming player uses.
export interface LocalCue {
    start: number;
    end: number;
    en: string;
    zh: string;
}

export interface LocalTranscriptBlock {
    id: number;
    start: number;
    end: number;
    en_text: string;
    zh_text: string;
    highlights: [];
}

const TIMESTAMP_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function seconds(h: string, m: string, s: string, ms: string): number {
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

function stripMarkup(text: string): string {
    return text
        .replace(/<[^>]+>/g, '')
        .replace(/\{\\[^}]+\}/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim();
}

function splitBilingual(lines: string[]): { en: string; zh: string } {
    const clean = lines.map(stripMarkup).filter(Boolean);
    if (clean.length === 0) return { en: '', zh: '' };
    if (clean.length === 1) {
        return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(clean[0])
            ? { en: '', zh: clean[0] }
            : { en: clean[0], zh: '' };
    }
    const chinese = clean.filter(line => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(line));
    const english = clean.filter(line => !/[\u3400-\u4dbf\u4e00-\u9fff]/.test(line));
    return {
        en: english.join(' ').trim(),
        zh: chinese.join(' ').trim(),
    };
}

/** Parse SRT/VTT text into sequential cues. Malformed cues are skipped. */
export function parseSubtitle(text: string): LocalCue[] {
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const blocks = normalized.split(/\n{2,}/);
    const cues: LocalCue[] = [];
    for (const block of blocks) {
        const lines = block.split('\n').filter(line => line.trim().length > 0);
        if (lines.length === 0) continue;
        if (/^WEBVTT\b/i.test(lines[0]) || /^NOTE\b/i.test(lines[0])) continue;
        const timeIndex = lines.findIndex(line => TIMESTAMP_RE.test(line));
        if (timeIndex === -1) continue;
        const match = TIMESTAMP_RE.exec(lines[timeIndex]);
        if (!match) continue;
        const start = seconds(match[1], match[2], match[3], match[4]);
        const end = seconds(match[5], match[6], match[7], match[8]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const { en, zh } = splitBilingual(lines.slice(timeIndex + 1));
        if (!en && !zh) continue;
        cues.push({ start, end, en, zh });
    }
    return cues.sort((a, b) => a.start - b.start);
}

/** Build the block list consumed by TranscriptView. Cues without English are dropped. */
export function buildLocalTranscript(text: string): LocalTranscriptBlock[] {
    return parseSubtitle(text)
        .filter(cue => cue.en.trim().length > 0)
        .map((cue, index) => ({
            id: index,
            start: cue.start,
            end: cue.end,
            en_text: cue.en,
            zh_text: cue.zh,
            highlights: [] as [],
        }));
}

/** A subtitle file the user picked after the video was already playing. */
export type LocalSubtitleFileError = 'format' | 'read' | 'empty';

export type LocalSubtitleFileResult =
    // `text` is the raw SRT/VTT, persisted so a saved episode can rebuild the
    // transcript next time without asking for the file again.
    | { ok: true; transcript: LocalTranscriptBlock[]; text: string }
    | { ok: false; reason: LocalSubtitleFileError };

const SUBTITLE_EXTENSION_RE = /\.(srt|vtt)$/i;

/**
 * Read an SRT/VTT the user picked inside the player. Everything stays in the
 * tab (`File.text()`); the caller only swaps the transcript, never the video.
 */
export async function readLocalSubtitleFile(file: File): Promise<LocalSubtitleFileResult> {
    if (!SUBTITLE_EXTENSION_RE.test(file.name)) return { ok: false, reason: 'format' };
    let text: string;
    try {
        text = await file.text();
    } catch {
        return { ok: false, reason: 'read' };
    }
    const transcript = buildLocalTranscript(text);
    if (transcript.length === 0) return { ok: false, reason: 'empty' };
    return { ok: true, transcript, text };
}
