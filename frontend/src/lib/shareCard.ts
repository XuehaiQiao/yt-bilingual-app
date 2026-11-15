// Share card (计划 D-6 · 分享卡 P1) — renders a 1080×1440 PNG entirely on the
// client with Canvas. No network font, no image host, no backend: the card is
// drawn from the text the user already has on screen, and nothing is uploaded.
//
// The module is deliberately UI-free (lib convention). It exposes:
//   - drawShareCard(canvas, data)        draw into a caller-owned <canvas>;
//   - createShareCardCanvas(data)        offscreen convenience for tests;
//   - canvasToPngBlob(canvas)            PNG encode through canvas.toBlob;
//   - downloadShareCard / copyShareText  save/copy helpers;
//   - buildShareText(data)               the text version of the card;
//   - wrapText / truncateLine            layout primitives (exported for tests).
//
// Constraints baked in here:
//   - system font stack only (SF Pro / PingFang on Apple, graceful fallbacks);
//   - English body wraps by word, CJK/Vietnamese by word-or-character;
//   - at most 6 body lines with an ellipsis on overflow (vocabulary cards use
//     4 for the context quote, because the headword block sits above it);
//   - every drawn block is guarded against an empty/oversized input so a bad
//     favorite can never produce a half-painted card.

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1440;

export type ShareCardKind = 'sentence' | 'vocabulary' | 'article' | 'selection';

/** Everything the card needs. All prose is rendered as-is (no client rewrite). */
export interface ShareCardData {
    kind: ShareCardKind;
    /** Original (English) text: the sentence, paragraph, or vocabulary context. */
    text: string;
    /** Translation in the current target language. Omit when unknown. */
    translation?: string;
    /** Provenance shown near the footer: video/time or article title. */
    source?: string;
    /** Vocabulary headword; when present the card switches to word layout. */
    word?: string;
    /** Vocabulary definition/translation shown under the headword. */
    wordTranslation?: string;
    /** Localized small label above the body (e.g. 收藏句子). */
    label?: string;
}

export interface ShareCardDrawOptions {
    /** Localized footer line; defaults to the Chinese tagline. */
    tagline?: string;
    /** Footer brand word; defaults to "LinguaTrek". */
    footerBrand?: string;
}

export interface ShareCardMeta {
    empty: boolean;
    quoteLines: number;
    quoteTruncated: boolean;
    translationLines: number;
    translationTruncated: boolean;
    quoteFontSize: number;
}

export interface ShareTextOptions {
    translationLabel?: string;
    sourceLabel?: string;
    footer?: string;
}

// Apple platforms get SF Pro, Chinese falls back to PingFang, Vietnamese tone
// marks are covered by Segoe UI / Noto Sans on Windows/Linux. No @font-face, no
// webfont request: canvas renders immediately in any browser.
const FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", "Noto Sans", ' +
    '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Inter, system-ui, sans-serif';

const PADDING = 96;
const CONTENT_WIDTH = CARD_WIDTH - PADDING * 2;
const QUOTE_X = 140;
const QUOTE_WIDTH = CARD_WIDTH - PADDING - QUOTE_X;
const LABEL_TOP = 372;
const SOURCE_TOP = 1220;
const FOOTER_RULE_Y = 1300;
const DEFAULT_TAGLINE = '用真实内容学英语';
const DEFAULT_FOOTER = '— 语途 LinguaTrek · 用真实内容学英语';

const isCjk = (ch: string): boolean => {
    const cp = ch.codePointAt(0) ?? 0;
    return (
        (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals, punctuation, kana, han
        (cp >= 0xac00 && cp <= 0xd7af) || // hangul
        (cp >= 0xf900 && cp <= 0xfaff) || // compatibility ideographs
        (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
        (cp >= 0xff00 && cp <= 0xffef) // fullwidth forms
    );
};

// Punctuation that should stay glued to the preceding token so a line never
// starts with a comma/period (common with Chinese translations).
const CLOSING_PUNCT = new Set(['，', '。', '！', '？', '；', '：', '、', '）', '》', '」', '』', '】', '…', '’', '”']);
const OPENING_PUNCT = new Set(['（', '《', '「', '『', '【', '‘', '“']);

function setFont(ctx: CanvasRenderingContext2D, size: number, weight = '600'): void {
    ctx.font = `${weight} ${size}px ${FONT_STACK}`;
}

/**
 * Greedy word wrap, CJK-aware, capped at `maxLines`. The ellipsis is added to
 * the last visible line only when more text exists, so short input is never
 * decorated with a false truncation marker.
 */
export function wrapText(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    maxLines: number,
): { lines: string[]; truncated: boolean } {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) return { lines: [], truncated: false };
    if (maxLines <= 0) return { lines: [], truncated: true };

    // Split into breakable atoms: Latin words keep their spaces, CJK breaks
    // between characters, closing punctuation sticks to the previous atom.
    const tokens: string[] = [];
    let buffer = '';
    const flush = () => {
        if (buffer) {
            tokens.push(buffer);
            buffer = '';
        }
    };
    for (const ch of normalized) {
        if (ch === ' ') {
            flush();
            tokens.push(' ');
            continue;
        }
        if (isCjk(ch)) {
            flush();
            tokens.push(ch);
            continue;
        }
        if (CLOSING_PUNCT.has(ch)) {
            if (buffer) buffer += ch;
            else if (tokens.length > 0 && tokens[tokens.length - 1] !== ' ') tokens[tokens.length - 1] += ch;
            else buffer = ch;
            continue;
        }
        if (OPENING_PUNCT.has(ch)) {
            flush();
            buffer = ch;
            continue;
        }
        buffer += ch;
    }
    flush();

    const allLines: string[] = [];
    let line = '';
    const pushLine = () => {
        const trimmed = line.trimEnd();
        if (trimmed.trim()) allLines.push(trimmed.trimStart());
        line = '';
    };
    const splitLongToken = (token: string): string => {
        // A single unbreakable word wider than the card (URLs, no-space CJK
        // runs after normalization) is split by character as a last resort.
        let chunk = '';
        for (const ch of token) {
            if (chunk && ctx.measureText(chunk + ch).width > maxWidth) {
                allLines.push(chunk);
                chunk = ch;
            } else {
                chunk += ch;
            }
        }
        return chunk;
    };

    for (const token of tokens) {
        if (token === ' ') {
            if (line && !line.endsWith(' ')) line += ' ';
            continue;
        }
        if (!line.trim()) {
            line = ctx.measureText(token).width > maxWidth ? splitLongToken(token) : token;
            continue;
        }
        const candidate = line + token;
        if (ctx.measureText(candidate).width <= maxWidth) {
            line = candidate;
            continue;
        }
        pushLine();
        line = ctx.measureText(token).width > maxWidth ? splitLongToken(token) : token;
    }
    pushLine();

    if (allLines.length <= maxLines) return { lines: allLines, truncated: false };

    const lines = allLines.slice(0, maxLines);
    let last = lines[maxLines - 1].trimEnd();
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
        last = last.slice(0, -1).trimEnd();
    }
    lines[maxLines - 1] = `${last}…`;
    return { lines, truncated: true };
}

/** Truncate a single line to `maxWidth`, appending an ellipsis if needed. */
export function truncateLine(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
): string {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized || ctx.measureText(normalized).width <= maxWidth) return normalized;
    let out = normalized;
    while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
        out = out.slice(0, -1).trimEnd();
    }
    return `${out}…`;
}

function roundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
): void {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function quoteFontSize(text: string, hasWord: boolean): number {
    if (hasWord) return 42;
    const length = text.length;
    if (length <= 48) return 84;
    if (length <= 110) return 72;
    if (length <= 220) return 62;
    return 54;
}

/** Paint the card into an existing canvas and report what happened to the text. */
export function drawShareCard(
    canvas: HTMLCanvasElement,
    data: ShareCardData,
    options: ShareCardDrawOptions = {},
): ShareCardMeta {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('share-card: 2d canvas context unavailable');

    if (canvas.width !== CARD_WIDTH) canvas.width = CARD_WIDTH;
    if (canvas.height !== CARD_HEIGHT) canvas.height = CARD_HEIGHT;
    ctx.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

    // ── Background: near-black with a single blue glow (brand accent only) ──
    const bg = ctx.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT);
    bg.addColorStop(0, '#131318');
    bg.addColorStop(0.55, '#0c0c0f');
    bg.addColorStop(1, '#08080a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

    const glow = ctx.createRadialGradient(880, 110, 30, 880, 110, 780);
    glow.addColorStop(0, 'rgba(10,132,255,0.22)');
    glow.addColorStop(0.42, 'rgba(10,132,255,0.07)');
    glow.addColorStop(1, 'rgba(10,132,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

    const lowerGlow = ctx.createRadialGradient(90, 1400, 20, 90, 1400, 560);
    lowerGlow.addColorStop(0, 'rgba(64,156,255,0.05)');
    lowerGlow.addColorStop(1, 'rgba(64,156,255,0)');
    ctx.fillStyle = lowerGlow;
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

    roundedRect(ctx, 28, 28, CARD_WIDTH - 56, CARD_HEIGHT - 56, 54);
    ctx.strokeStyle = 'rgba(255,255,255,0.075)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // ── Brand header ───────────────────────────────────────────────────────
    const logoX = PADDING;
    const logoY = 88;
    const logoSize = 84;
    const logoGradient = ctx.createLinearGradient(logoX, logoY, logoX + logoSize, logoY + logoSize);
    logoGradient.addColorStop(0, '#409CFF');
    logoGradient.addColorStop(1, '#0A84FF');
    roundedRect(ctx, logoX, logoY, logoSize, logoSize, 22);
    ctx.fillStyle = logoGradient;
    ctx.fill();
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    setFont(ctx, 46, '600');
    ctx.fillText('语', logoX + logoSize / 2, logoY + 58);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fafafa';
    setFont(ctx, 46, '600');
    ctx.fillText('语途', logoX + 108, logoY + 42);
    ctx.fillStyle = '#71717a';
    setFont(ctx, 24, '500');
    ctx.fillText('LinguaTrek', logoX + 108, logoY + 78);

    ctx.fillStyle = '#52525b';
    setFont(ctx, 22, '500');
    ctx.textAlign = 'right';
    ctx.fillText('SHARE CARD', CARD_WIDTH - PADDING, logoY + 38);
    ctx.textAlign = 'left';

    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(PADDING, 296, CONTENT_WIDTH, 1);

    // ── Content ────────────────────────────────────────────────────────────
    const word = (data.word ?? '').trim();
    const bodyText = (data.text ?? '').trim();
    const translation = (data.translation ?? '').trim();
    const label = (data.label ?? '').trim();
    const source = (data.source ?? '').trim();
    const empty = !word && !bodyText;

    const meta: ShareCardMeta = {
        empty,
        quoteLines: 0,
        quoteTruncated: false,
        translationLines: 0,
        translationTruncated: false,
        quoteFontSize: 0,
    };

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // Two-pass layout: measure every block first, then centre the whole stack
    // in the space above the source line. A three-word sentence then sits in
    // the visual middle of the card instead of hugging the top; long quotes
    // simply fill the space and get truncated by wrapText.
    const wordSize = word.length > 22 ? 64 : 92;
    const wordLineHeight = wordSize * 1.12;
    let wordLines: string[] = [];
    let defLines: string[] = [];
    const defLineHeight = 38 * 1.45;
    const wordTranslation = (data.wordTranslation ?? '').trim();
    if (word) {
        setFont(ctx, wordSize, '600');
        wordLines = wrapText(ctx, word, QUOTE_WIDTH, 2).lines;
        if (wordTranslation) {
            setFont(ctx, 38, '400');
            defLines = wrapText(ctx, wordTranslation, QUOTE_WIDTH, 3).lines;
        }
    }
    const wordPart = word ? wordLines.length * wordLineHeight : 0;
    const defPart = defLines.length > 0 ? 16 + defLines.length * defLineHeight : 0;
    const gapBeforeQuote = word && bodyText ? 44 : 0;

    const quoteSize = bodyText ? quoteFontSize(bodyText, Boolean(word)) : 0;
    const quoteLineHeight = quoteSize * 1.3;
    let quoteLines: string[] = [];
    let quoteTruncated = false;
    if (bodyText) {
        setFont(ctx, quoteSize, '600');
        const block = wrapText(ctx, bodyText, QUOTE_WIDTH, word ? 4 : 6);
        quoteLines = block.lines;
        quoteTruncated = block.truncated;
    }
    const quotePart = quoteLines.length * quoteLineHeight;

    const translationLineHeight = 38 * 1.5;
    const contentTop = LABEL_TOP + (label ? 52 + 38 : 0);
    const available = SOURCE_TOP - 60 - contentTop;
    const nonTranslationHeight = wordPart + defPart + gapBeforeQuote + quotePart;
    let translationLimit = translation ? 4 : 0;
    while (translationLimit > 0 && nonTranslationHeight + 54 + translationLimit * translationLineHeight > available) {
        translationLimit -= 1;
    }
    let translationLines: string[] = [];
    let translationTruncated = false;
    if (translation && translationLimit > 0) {
        setFont(ctx, 38, '400');
        const block = wrapText(ctx, translation, QUOTE_WIDTH, translationLimit);
        translationLines = block.lines;
        translationTruncated = block.truncated;
    }
    const translationPart = translationLines.length * translationLineHeight;
    const contentHeight = nonTranslationHeight + (translationLines.length > 0 ? 54 + translationPart : 0);
    const totalHeight = (label ? 52 + 38 : 0) + contentHeight;
    const centreOffset = Math.max(0, Math.round((SOURCE_TOP - 60 - LABEL_TOP - totalHeight) / 2));
    let y = LABEL_TOP + centreOffset;

    if (label) {
        setFont(ctx, 24, '500');
        const labelWidth = Math.min(CONTENT_WIDTH, ctx.measureText(label).width + 44);
        roundedRect(ctx, PADDING, y, labelWidth, 52, 26);
        ctx.fillStyle = 'rgba(10,132,255,0.12)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(10,132,255,0.26)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#66B0FF';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, PADDING + 22, y + 27);
        ctx.textBaseline = 'top';
        y += 52 + 38;
    }

    if (empty) {
        ctx.fillStyle = '#3f3f46';
        setFont(ctx, 64, '600');
        ctx.fillText('—', QUOTE_X, y + 24);
    }

    // Vocabulary headword + definition.
    if (word) {
        ctx.fillStyle = '#fafafa';
        setFont(ctx, wordSize, '600');
        wordLines.forEach((line, index) => {
            ctx.fillText(line, QUOTE_X, y + index * wordLineHeight);
        });
        y += wordPart;
        if (defLines.length > 0) {
            y += 16;
            ctx.fillStyle = '#a1a1aa';
            setFont(ctx, 38, '400');
            defLines.forEach((line, index) => {
                ctx.fillText(line, QUOTE_X, y + index * defLineHeight);
            });
            y += defLines.length * defLineHeight;
        }
        y += word && bodyText ? 44 : 0;
    }

    // Main quote.
    if (quoteLines.length > 0) {
        roundedRect(ctx, PADDING + 4, y + 8, 5, Math.min(quoteSize * 1.25, 84), 2.5);
        ctx.fillStyle = 'rgba(10,132,255,0.75)';
        ctx.fill();
        ctx.fillStyle = '#f5f5f6';
        setFont(ctx, quoteSize, '600');
        quoteLines.forEach((line, index) => {
            ctx.fillText(line, QUOTE_X, y + index * quoteLineHeight);
        });
        meta.quoteLines = quoteLines.length;
        meta.quoteTruncated = quoteTruncated;
        meta.quoteFontSize = quoteSize;
        y += quotePart;
    }

    // Translation (target language).
    if (translationLines.length > 0) {
        y += 54;
        roundedRect(ctx, PADDING + 4, y + 6, 5, Math.min(translationLineHeight * 1.5, 70), 2.5);
        ctx.fillStyle = 'rgba(10,132,255,0.45)';
        ctx.fill();
        setFont(ctx, 38, '400');
        ctx.fillStyle = '#a1a1aa';
        translationLines.forEach((line, index) => {
            ctx.fillText(line, QUOTE_X, y + index * translationLineHeight);
        });
        meta.translationLines = translationLines.length;
        meta.translationTruncated = translationTruncated;
    }


    // ── Source + footer ────────────────────────────────────────────────────
    if (source) {
        setFont(ctx, 26, '500');
        ctx.fillStyle = '#71717a';
        roundedRect(ctx, PADDING, SOURCE_TOP + 11, 8, 8, 4);
        ctx.fill();
        const line = truncateLine(ctx, source, CONTENT_WIDTH - 26);
        ctx.fillText(line, PADDING + 20, SOURCE_TOP);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(PADDING, FOOTER_RULE_Y, CONTENT_WIDTH, 1);

    setFont(ctx, 28, '500');
    ctx.fillStyle = '#a1a1aa';
    ctx.fillText((options.tagline ?? DEFAULT_TAGLINE).trim() || DEFAULT_TAGLINE, PADDING, FOOTER_RULE_Y + 34);

    ctx.textAlign = 'right';
    setFont(ctx, 24, '500');
    ctx.fillStyle = '#52525b';
    ctx.fillText((options.footerBrand ?? 'LinguaTrek').trim() || 'LinguaTrek', CARD_WIDTH - PADDING, FOOTER_RULE_Y + 36);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    return meta;
}

/** Offscreen creation helper (tests, previews, exports). */
export function createShareCardCanvas(
    data: ShareCardData,
    options: ShareCardDrawOptions = {},
): { canvas: HTMLCanvasElement; meta: ShareCardMeta } {
    if (typeof document === 'undefined') throw new Error('share-card: document unavailable');
    const canvas = document.createElement('canvas');
    canvas.width = CARD_WIDTH;
    canvas.height = CARD_HEIGHT;
    const meta = drawShareCard(canvas, data, options);
    return { canvas, meta };
}

/** PNG encode. Rejects instead of resolving a null blob (Safari can do that). */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
        try {
            canvas.toBlob((blob) => {
                if (blob && blob.size > 0) resolve(blob);
                else reject(new Error('share-card: PNG encode produced an empty blob'));
            }, 'image/png');
        } catch (error) {
            reject(error instanceof Error ? error : new Error('share-card: PNG encode failed'));
        }
    });
}

/** Trigger a browser download for a blob; the object URL is revoked lazily. */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoke after the click has been handled; immediate revocation can abort
    // the download in some Chromium builds.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Stable, collision-resistant filename for a downloaded card. */
export function shareCardFileName(kind: ShareCardKind, now: Date = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `linguatrak-${kind}-${stamp}.png`;
}

/** Plain-text version of the card, used by the copy button. */
export function buildShareText(data: ShareCardData, options: ShareTextOptions = {}): string {
    const translationLabel = (options.translationLabel ?? '译').trim() || '译';
    const sourceLabel = (options.sourceLabel ?? '来源').trim() || '来源';
    const footer = (options.footer ?? DEFAULT_FOOTER).trim() || DEFAULT_FOOTER;

    const parts: string[] = [];
    const word = (data.word ?? '').trim();
    if (word) {
        const wordTranslation = (data.wordTranslation ?? '').trim();
        parts.push(wordTranslation ? `${word} — ${wordTranslation}` : word);
    }
    const text = (data.text ?? '').trim();
    if (text) parts.push(text);
    const translation = (data.translation ?? '').trim();
    if (translation) parts.push(`${translationLabel}: ${translation}`);
    const source = (data.source ?? '').trim();
    if (source) parts.push(`${sourceLabel}: ${source}`);
    parts.push(footer);
    return parts.join('\n\n');
}

/**
 * Copy helper with a synchronous fallback for browsers/contexts where the
 * async Clipboard API is unavailable (http, denied permission, old Chrome).
 * Returns false instead of throwing so the dialog can show a readable toast.
 */
export async function copyShareText(text: string): Promise<boolean> {
    if (!text) return false;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Fall through to the textarea path.
    }
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        return copied;
    } catch {
        return false;
    }
}
