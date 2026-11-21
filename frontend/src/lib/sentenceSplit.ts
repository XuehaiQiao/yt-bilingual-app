// Sentence segmentation shared by every reading surface (specs/037).
//
// The reading audio bar speaks and highlights one sentence at a time, so the
// paragraph text has to be split WITHOUT ever cutting through an abbreviation,
// an initial or a quoted sentence. A plain regex split cannot do that
// (`/\b\.\s/` breaks `Mr. Smith` in half), so this module scans the paragraph
// once and only accepts a boundary that survives every guard below.
//
// Contract (the readers rely on all three points):
//   1. Spans are slices of the input (`start`/`end` offsets), so a renderer can
//      reproduce the paragraph byte-for-byte — the whitespace between two
//      sentences simply stays outside the spans.
//   2. These never end a sentence: `Mr.`/`Dr.`/`Prof.`/`St.`/`vs.`/`etc.`,
//      dotted abbreviations (`U.S.`, `e.g.`, `i.e.`, `a.m.`), initials
//      (`J. K. Rowling`), numbers with a dot but no space (`3.14`), and
//      contextual abbreviations followed by digits (`No. 5`, `p. 42`).
//   3. A period only ends a sentence when what follows looks like a new
//      sentence (uppercase letter / digit / quote / non-ASCII). That guard is
//      what keeps an abbreviation this list does not know about from
//      swallowing the next sentence: `the U.S. army` never splits.
//
// `!` / `?` always terminate — `"Stop!" she said.` is two sentences. An
// ellipsis (`...` / `…`) terminates only when a new sentence follows, so
// `Well... I think so.` stays together while `Wait... Then he left.` splits.
// Trailing closing quotes/brackets stay with the sentence they close.
//
// Known limitation (accepted): an abbreviation followed by a genuinely new
// sentence (`He lives in the U.S. He works.`) stays one span, and so does
// `etc.` at the end of a sentence. Merging two sentences is harmless for
// reading audio (it reads a little further); cutting one in half is not.
export interface SentenceSpan {
    /** Sentence text, without the surrounding whitespace. */
    text: string;
    /** Offset of `text[0]` inside the paragraph. */
    start: number;
    /** Offset just past the last character of `text`. */
    end: number;
}

/**
 * Single-token abbreviations that end in a period but never end a sentence.
 * Stored lower-case; comparison is case-insensitive.
 */
const ABBREVIATIONS = new Set([
    // People / titles
    'mr', 'mrs', 'ms', 'messrs', 'dr', 'drs', 'prof', 'sr', 'jr', 'rev', 'hon',
    'pres', 'gov', 'sen', 'rep', 'gen', 'col', 'capt', 'lt', 'sgt',
    // Places / addresses
    'st', 'mt', 'ft', 'ave', 'blvd', 'rd',
    // References
    'vs', 'etc', 'al', 'cf', 'viz', 'inc', 'ltd', 'co', 'corp',
    // Dates / time
    'a.m', 'p.m', 'b.c', 'a.d', 'ph.d', 'jan', 'feb', 'mar', 'apr', 'may',
    'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
    // Dotted abbreviations are also caught by the `dottedToken` rule below;
    // keeping them here documents the intent and covers `e.g` / `i.e` typed
    // with the trailing period outside the token.
    'e.g', 'i.e', 'u.s', 'u.k', 'u.n', 'u.s.a', 'e.u',
    // Measures / words people write short
    'approx', 'avg', 'est', 'esp',
]);

/**
 * Abbreviations that are only an abbreviation when a number follows
 * (`No. 5`, `pp. 20–24`) — `No.` on its own is a perfectly good sentence.
 */
const NUMERIC_ABBREVIATIONS = new Set(['no', 'nos', 'p', 'pp', 'vol', 'vols', 'fig', 'figs', 'ch', 'chs', 'sec', 'para']);

/** Punctuation that may close a sentence and belongs to it. */
const CLOSERS = new Set(['"', "'", '\u201d', '\u2019', ')', ']', '}', '\u00bb']);
/** Characters that can legitimately start a sentence after `.` / `!` / `?`. */
const OPENERS = new Set(['"', "'", '\u201c', '\u2018', '(', '[', '\u00ab']);

const isSpace = (char: string) => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';

/** Offset of the first non-space character at or after `index`. */
function nextNonSpace(text: string, index: number): number {
    let cursor = index;
    while (cursor < text.length && isSpace(text[cursor])) cursor += 1;
    return cursor;
}

/** Offset just past a run of closing quotes/brackets starting at `index`. */
function skipClosers(text: string, index: number): number {
    let cursor = index;
    while (cursor < text.length && CLOSERS.has(text[cursor])) cursor += 1;
    return cursor;
}

/** True when the character at `index` can start a new sentence. */
function startsSentence(text: string, index: number): boolean {
    if (index >= text.length) return true;
    const char = text[index];
    if (OPENERS.has(char)) return true;
    // Uppercase ASCII / any digit (a numbered list) / non-ASCII punctuation
    // such as an em dash or a CJK character.
    return /[A-Z0-9]/.test(char) || char.charCodeAt(0) > 0x7f;
}

/** The letter/dot token immediately before `index` (e.g. `U.S` for `U.S.`). */
function tokenBefore(text: string, index: number): string {
    let cursor = index;
    while (cursor > 0 && /[A-Za-z.]/.test(text[cursor - 1])) cursor -= 1;
    return text.slice(cursor, index).replace(/^\.+/, '');
}

/** True when a single uppercase letter (`J.` in `J. K. Rowling`). */
const isInitial = (token: string) => /^[A-Z]$/.test(token);

/** True for a dotted token such as `U.S`, `e.g`, `a.m` — never a boundary. */
const isDotted = (token: string) => /^[A-Za-z]\.(?:[A-Za-z]\.)*[A-Za-z]$/.test(token);

/**
 * Decide whether the period at `dot` is an abbreviation mark instead of a
 * sentence boundary.
 */
function isAbbreviationDot(text: string, dot: number): boolean {
    // A period glued to the previous character (`3.14`, `foo.bar`) can not be a
    // boundary: a boundary always follows a word character plus a space.
    const token = tokenBefore(text, dot);
    if (!token) return false;
    if (isInitial(token)) return true;
    if (isDotted(token)) return true;
    const lower = token.toLowerCase();
    if (NUMERIC_ABBREVIATIONS.has(lower)) {
        const after = nextNonSpace(text, dot + 1);
        return after < text.length && /[0-9]/.test(text[after]);
    }
    return ABBREVIATIONS.has(lower);
}

/**
 * Split a paragraph into sentences. Empty / whitespace-only input yields `[]`;
 * a paragraph without terminal punctuation yields one span covering the whole
 * (trimmed) paragraph.
 */
export function splitSentences(input: string): SentenceSpan[] {
    const text = input ?? '';
    if (!text.trim()) return [];

    const spans: SentenceSpan[] = [];

    const push = (start: number, end: number) => {
        let finish = end;
        while (finish > start && isSpace(text[finish - 1])) finish -= 1;
        if (finish <= start) return;
        spans.push({ text: text.slice(start, finish), start, end: finish });
    };

    let start = nextNonSpace(text, 0);
    let index = start;

    while (index < text.length) {
        const char = text[index];

        // `!` / `?` (with a run of `?!`, `!!!`, …) always end the sentence.
        if (char === '!' || char === '?') {
            let cursor = index + 1;
            while (cursor < text.length && /[!?.]/.test(text[cursor])) cursor += 1;
            cursor = skipClosers(text, cursor);
            push(start, cursor);
            start = nextNonSpace(text, cursor);
            index = start;
            continue;
        }

        // `.` / `…` — the guarded case.
        if (char === '.' || char === '\u2026') {
            const ellipsis = char === '\u2026' || (char === '.' && text[index + 1] === '.' && text[index + 2] === '.');
            let cursor = index + 1;
            if (ellipsis) {
                cursor = char === '\u2026' ? index + 1 : index + 3;
                while (cursor < text.length && (text[cursor] === '.' || text[cursor] === '\u2026')) cursor += 1;
            }
            // `3.14`, `foo.Bar`: something other than a space or a closing
            // quote right after the dot ⇒ not a boundary. A closer may follow
            // directly (`"Go."`), so it is allowed here.
            if (!ellipsis && cursor < text.length && !isSpace(text[cursor]) && !CLOSERS.has(text[cursor])) {
                index = cursor;
                continue;
            }
            if (!ellipsis && isAbbreviationDot(text, index)) {
                index = cursor;
                continue;
            }
            const boundary = skipClosers(text, cursor);
            const after = nextNonSpace(text, boundary);
            if (after < text.length && !startsSentence(text, after)) {
                // Lowercase continuation: an abbreviation we do not know, an
                // e-mail address, a version number … keep the span together.
                index = cursor;
                continue;
            }
            push(start, boundary);
            start = after;
            index = start;
            continue;
        }

        index += 1;
    }

    push(start, text.length);
    return spans;
}
