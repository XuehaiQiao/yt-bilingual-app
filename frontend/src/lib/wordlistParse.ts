// Client-side parsing + validation for the custom-wordlist importer
// (specs/038-custom-wordlists §1–§2).
//
// The wizard reads the user's file locally: nothing is uploaded before the
// third step, so every limit and every per-row rule is enforced here first.
// The backend re-validates (§2: 客户端 + 服务端都做); this module must not be
// more permissive than the spec:
//
//   * `.csv` / `.tsv` / `.txt`, UTF-8 (a BOM is fine), ≤2 MB, ≤10000 data rows;
//   * RFC 4180 quoting: `""` escapes, newlines inside quotes, CRLF/CR/LF;
//   * delimiter auto-detection (comma / Tab) and optional header row;
//   * word column: must contain A–Z/a–z; hyphens, apostrophes and diacritics
//     allowed; at most 5 words and 40 chars; Chinese / other scripts, pure
//     numbers and pure symbols are rejected;
//   * dedupe key NFC + casefold (we keep the original casing);
//   * CEFR only A1/A2/B1/B2/C1 (anything else is ignored, never guessed);
//   * >50% invalid rows blocks the import ("this is not an English word list").
//
// `.apkg` (specs/046) is never parsed here: the backend reads the Anki package
// and returns decks/models/notes; this module only owns the size/extension
// limits and the default field→column guess used by the wizard.
//
// Pure functions only — the component owns the File object and the UI state.

export const WORDLIST_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Text files: at most 10000 data rows; the backend import endpoint accepts the
 * same ceiling. The APKG wizard also feeds its selected notes through this
 * limit, so a real 7512-note Anki deck imports in full (specs/046 §1).
 */
export const WORDLIST_MAX_ROWS = 10000;
export const WORDLIST_MAX_NAME_LENGTH = 80;
export const WORDLIST_MAX_WORD_LENGTH = 40;
export const WORDLIST_MAX_WORD_COUNT = 5;
export const WORDLIST_MAX_LISTS = 10;
export const WORDLIST_PAGE_SIZE = 50;

/** Anki `.apkg` export: uploaded to the backend for parsing, ≤50 MB (specs/046). */
export const WORDLIST_APKG_MAX_BYTES = 50 * 1024 * 1024;

export const WORDLIST_FILE_EXTENSIONS = ['.csv', '.tsv', '.txt', '.apkg'] as const;

export type WordlistDelimiter = ',' | '\t';

export const WORDLIST_COLUMN_ROLES = [
    'word',
    'translation',
    'phonetic',
    'cefr',
    'example',
] as const;

export type WordlistColumnRole = (typeof WORDLIST_COLUMN_ROLES)[number];

export type WordlistColumnMap = Record<WordlistColumnRole, number | null>;

export const WORDLIST_CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'] as const;

export type WordlistSkipReason =
    | 'empty'
    | 'notEnglish'
    | 'tooLong'
    | 'tooManyWords'
    | 'duplicate';

export interface WordlistEntry {
    word: string;
    translation: string | null;
    phonetic: string | null;
    cefr: string | null;
    example: string | null;
}

export interface WordlistSkippedRow {
    /** 1-based physical line in the uploaded file (header included). */
    line: number;
    reason: WordlistSkipReason;
    /** Raw word cell, trimmed and capped for the reason list. */
    value: string;
}

export interface WordlistValidation {
    total: number;
    entries: WordlistEntry[];
    skipped: WordlistSkippedRow[];
    valid: number;
    skippedCount: number;
    /** Rows rejected by the English-word rule (duplicates not included). */
    invalidCount: number;
    blocked: 'mostlyInvalid' | 'noValid' | null;
}

export interface ParsedWordlistFile {
    delimiter: WordlistDelimiter;
    /** `null` when the first record is data, not a header. */
    header: string[] | null;
    /** Data records only (header already removed), blank records removed. */
    rows: string[][];
    /** Physical start line of each row (used in the skip-reason list). */
    lineNumbers: number[];
    /** Biggest column count across the parsed data (for the mapping selects). */
    columnCount: number;
}

export interface ParsedWordlistRecord {
    cells: string[];
    line: number;
}

const HEADER_ALIASES: Record<WordlistColumnRole, readonly string[]> = {
    word: [
        'word', 'words', 'term', 'terms', 'headword', 'head word', 'vocabulary',
        'vocab', 'spelling', '单词', '词', '词汇', '生词', '词条', 'từ', 'từ vựng',
    ],
    translation: [
        'translation', 'translations', 'meaning', 'meanings', 'definition',
        'definitions', 'zh', 'chinese', 'vietnamese', '释义', '中文', '意思',
        '翻译', '解释', '义项', 'nghĩa', 'bản dịch', 'dịch',
    ],
    phonetic: [
        'phonetic', 'phonetics', 'ipa', 'pronunciation', 'pronounce', 'reading',
        '音标', '发音', '读音', 'phiên âm', 'cách đọc',
    ],
    cefr: ['cefr', 'level', 'grade', 'band', '等级', '级别', '难度', 'trình độ'],
    example: [
        'example', 'examples', 'sentence', 'sentences', 'sample', 'context',
        '例句', '句子', '例子', '语境', 'ví dụ', 'câu',
    ],
};

/** Header cells are normalized loosely: case, spaces, `_`, `-`, BOM. */
function normalizeHeaderCell(value: string): string {
    return value
        .replace(/^\uFEFF/, '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, ' ');
}

function headerRole(value: string): WordlistColumnRole | null {
    const cell = normalizeHeaderCell(value);
    if (!cell) return null;
    for (const role of WORDLIST_COLUMN_ROLES) {
        const aliases = HEADER_ALIASES[role];
        if (aliases.includes(cell)) return role;
        // Accept "word(英文)" / "translation 中文" style headers.
        if (aliases.some((alias) => cell === alias || cell.startsWith(`${alias} `) || cell.startsWith(`${alias}(`))) {
            return role;
        }
    }
    return null;
}

/** True when the first record names at least one column the importer knows. */
export function isHeaderRecord(cells: readonly string[]): boolean {
    const roles = new Set<WordlistColumnRole>();
    for (const cell of cells) {
        const role = headerRole(cell);
        if (role) roles.add(role);
    }
    return roles.size >= 2 || roles.has('word');
}

/**
 * Sniff the delimiter from the first physical line. Quoted fields are rare in
 * a header (where most files put the names), so counting characters outside
 * quotes is enough here; TSV exports never quote a Tab inside a word.
 */
export function detectDelimiter(text: string): WordlistDelimiter {
    const firstLine = text.replace(/^\uFEFF/, '').split('\n', 1)[0] ?? '';
    let commas = 0;
    let tabs = 0;
    let inQuotes = false;
    for (let index = 0; index < firstLine.length; index += 1) {
        const char = firstLine[index];
        if (char === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (inQuotes) continue;
        if (char === ',') commas += 1;
        else if (char === '\t') tabs += 1;
    }
    if (tabs > commas) return '\t';
    if (commas > 0) return ',';
    return tabs > 0 ? '\t' : ',';
}

/**
 * RFC 4180 record parser. Returns one entry per non-blank record and keeps the
 * physical line number so the wizard can say 「第 7 行：不是英文单词」.
 * Newlines inside a quoted field belong to the field and do not split rows.
 */
export function parseDelimitedRecords(text: string, delimiter: WordlistDelimiter): ParsedWordlistRecord[] {
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const records: ParsedWordlistRecord[] = [];
    let cells: string[] = [];
    let field = '';
    let inQuotes = false;
    let line = 1;
    let recordStart = 1;

    const commit = () => {
        cells.push(field);
        field = '';
        // Blank lines are spacing, not word rows.
        if (cells.some((cell) => cell.trim() !== '')) {
            records.push({ cells, line: recordStart });
        }
        cells = [];
    };

    for (let index = 0; index < normalized.length; index += 1) {
        const char = normalized[index];
        if (inQuotes) {
            if (char === '"') {
                if (normalized[index + 1] === '"') {
                    field += '"';
                    index += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                if (char === '\n') line += 1;
                field += char;
            }
            continue;
        }
        if (char === '"' && field === '') {
            inQuotes = true;
        } else if (char === delimiter) {
            cells.push(field);
            field = '';
        } else if (char === '\n') {
            commit();
            line += 1;
            recordStart = line;
        } else {
            field += char;
        }
    }
    if (field !== '' || cells.length > 0) commit();
    return records;
}

/** Parse a file body: delimiter + optional header, data rows and line numbers. */
export function parseWordlistFile(text: string): ParsedWordlistFile {
    const delimiter = detectDelimiter(text);
    const records = parseDelimitedRecords(text, delimiter);
    if (records.length === 0) {
        return { delimiter, header: null, rows: [], lineNumbers: [], columnCount: 0 };
    }
    const first = records[0];
    const hasHeader = isHeaderRecord(first.cells);
    const data = hasHeader ? records.slice(1) : records;
    const rows = data.map((record) => record.cells.map((cell) => cell.trim()));
    const columnCount = rows.reduce((max, cells) => Math.max(max, cells.length), hasHeader ? first.cells.length : 0);
    return {
        delimiter,
        header: hasHeader ? first.cells.map((cell) => cell.trim()) : null,
        rows,
        lineNumbers: data.map((record) => record.line),
        columnCount,
    };
}

/** Column indices named by a header record (first match wins per role). */
function mapFromHeader(header: readonly string[], columnCount: number): WordlistColumnMap {
    const map: WordlistColumnMap = {
        word: null,
        translation: null,
        phonetic: null,
        cefr: null,
        example: null,
    };
    const used = new Set<number>();
    header.forEach((cell, index) => {
        if (index >= columnCount) return;
        const role = headerRole(cell);
        if (!role || map[role] != null || used.has(index)) return;
        map[role] = index;
        used.add(index);
    });
    if (map.word == null) map.word = 0;
    return map;
}

function sampleValues(rows: readonly string[][], column: number, limit = 8): string[] {
    const values: string[] = [];
    for (const cells of rows) {
        if (values.length >= limit) break;
        const value = (cells[column] ?? '').trim();
        if (value) values.push(value);
    }
    return values;
}

function looksLikePhonetic(value: string): boolean {
    if (/^\/.+\/$/.test(value)) return true;
    return /^\[.+\]$/.test(value) || /[ˈˌəɜɔæʌθðʃʒŋ]/.test(value);
}

function inferRoleForColumn(rows: readonly string[][], column: number): WordlistColumnRole | null {
    const values = sampleValues(rows, column);
    if (values.length === 0) return null;
    if (values.every((value) => (WORDLIST_CEFR_LEVELS as readonly string[]).includes(value.toUpperCase()))) {
        return 'cefr';
    }
    if (values.every(looksLikePhonetic)) return 'phonetic';
    if (values.some((value) => /\p{Script=Han}/u.test(value))) return 'translation';
    if (values.filter((value) => value.split(/\s+/u).length >= 3).length >= Math.ceil(values.length / 2)) {
        return 'example';
    }
    return null;
}

/**
 * Default column mapping. With a header we trust the names; without one the
 * word is column 0 and the remaining columns are inferred from their content
 * (CEFR / IPA / Chinese meaning / sentence), then filled positionally in the
 * product order. Every choice stays editable in the wizard.
 */
export function defaultColumnMap(
    rows: readonly string[][],
    header: readonly string[] | null,
    columnCount: number,
): WordlistColumnMap {
    if (header) return mapFromHeader(header, columnCount);

    const map: WordlistColumnMap = {
        word: columnCount > 0 ? 0 : null,
        translation: null,
        phonetic: null,
        cefr: null,
        example: null,
    };
    const used = new Set<number>(map.word == null ? [] : [map.word]);
    const inferred: Array<[WordlistColumnRole, number]> = [];
    for (let column = 0; column < columnCount; column += 1) {
        if (used.has(column)) continue;
        const role = inferRoleForColumn(rows, column);
        if (role && map[role] == null) {
            inferred.push([role, column]);
            used.add(column);
        }
    }
    for (const [role, column] of inferred) map[role] = column;

    const order: WordlistColumnRole[] = ['translation', 'phonetic', 'cefr', 'example'];
    for (const role of order) {
        if (map[role] != null) continue;
        for (let column = 0; column < columnCount; column += 1) {
            if (used.has(column)) continue;
            map[role] = column;
            used.add(column);
            break;
        }
    }
    return map;
}

// One token mirrors the backend's `_TOKEN_RE` (backend/wordlists.py): it must
// start with a Latin letter, may contain combining marks (diacritics) and may
// join further letter runs with an apostrophe or a hyphen (don't,
// mother-in-law, rock’n’roll). Digits / periods / other scripts are rejected,
// so the client's 「有效」 count matches what the server would accept.
const WORD_TOKEN =
    /^\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:['\u2019\u2011-]\p{Script=Latin}[\p{Script=Latin}\p{M}]*)*$/u;

/**
 * English-word rule (specs/038 §2). Chinese / Japanese / Korean / Cyrillic /
 * Arabic glyphs are rejected outright, as are pure numbers and pure symbols.
 * The word is normalized to NFC (the server stores NFC) and keeps its casing.
 */
export function wordError(value: string): WordlistSkipReason | null {
    const word = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
    if (!word) return 'empty';
    if ([...word].length > WORDLIST_MAX_WORD_LENGTH) return 'tooLong';
    const tokens = word.split(' ');
    if (tokens.length > WORDLIST_MAX_WORD_COUNT) return 'tooManyWords';
    if (!tokens.every((token) => WORD_TOKEN.test(token))) return 'notEnglish';
    return null;
}

/** Dedupe key: NFC + casefold, original casing kept on the entry. */
export function wordKey(value: string): string {
    return value.normalize('NFC').toLowerCase();
}

function cellValue(cells: readonly string[], column: number | null): string {
    if (column == null || column < 0) return '';
    return (cells[column] ?? '').trim();
}

function optionalValue(cells: readonly string[], column: number | null): string | null {
    const value = cellValue(cells, column);
    return value ? value : null;
}

function cefrValue(cells: readonly string[], column: number | null): string | null {
    const value = cellValue(cells, column).toUpperCase();
    return (WORDLIST_CEFR_LEVELS as readonly string[]).includes(value) ? value : null;
}

/**
 * Validate every data row against the current mapping. Duplicates are skipped
 * (first occurrence wins); CEFR values outside A1–C1 are ignored, not guessed.
 */
export function validateWordlistRows(
    rows: readonly string[][],
    lineNumbers: readonly number[],
    map: WordlistColumnMap,
): WordlistValidation {
    const entries: WordlistEntry[] = [];
    const skipped: WordlistSkippedRow[] = [];
    const seen = new Set<string>();
    let invalidCount = 0;

    rows.forEach((cells, index) => {
        const line = lineNumbers[index] ?? index + 1;
        const rawWord = cellValue(cells, map.word);
        const reason = wordError(rawWord);
        if (reason) {
            skipped.push({ line, reason, value: rawWord.slice(0, 60) });
            invalidCount += 1;
            return;
        }
        const word = rawWord.normalize('NFC').replace(/\s+/gu, ' ').trim();
        const key = wordKey(word);
        if (seen.has(key)) {
            skipped.push({ line, reason: 'duplicate', value: word.slice(0, 60) });
            return;
        }
        seen.add(key);
        entries.push({
            word,
            translation: optionalValue(cells, map.translation),
            phonetic: optionalValue(cells, map.phonetic),
            cefr: cefrValue(cells, map.cefr),
            example: optionalValue(cells, map.example),
        });
    });

    const total = rows.length;
    let blocked: WordlistValidation['blocked'] = null;
    if (total > 0 && invalidCount / total > 0.5) blocked = 'mostlyInvalid';
    else if (entries.length === 0) blocked = 'noValid';

    return {
        total,
        entries,
        skipped,
        valid: entries.length,
        skippedCount: skipped.length,
        invalidCount,
        blocked,
    };
}

/**
 * `.csv` / `.tsv` / `.txt` / `.apkg`, case-insensitive; no extension is
 * rejected. Callers must branch on {@link isApkgFileName} first: `.apkg` is
 * uploaded as-is and never read as text.
 */
export function isWordlistFileName(fileName: string): boolean {
    const lower = fileName.trim().toLowerCase();
    return WORDLIST_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Anki export package (specs/046); routed to `POST /api/wordlists/apkg-parse`. */
export function isApkgFileName(fileName: string): boolean {
    return fileName.trim().toLowerCase().endsWith('.apkg');
}

/** Size check before `File.text()` (never read a file the backend would reject). */
export function isWordlistSizeAllowed(bytes: number): boolean {
    return Number.isFinite(bytes) && bytes >= 0 && bytes <= WORDLIST_MAX_BYTES;
}

/** APKG size check (50 MB) before the multipart upload starts. */
export function isApkgSizeAllowed(bytes: number): boolean {
    return Number.isFinite(bytes) && bytes >= 0 && bytes <= WORDLIST_APKG_MAX_BYTES;
}

/** The three text roles the APKG step maps onto model fields (specs/046 §3). */
export type ApkgFieldMap = {
    word: number | null;
    translation: number | null;
    phonetic: number | null;
};

// Anki field names are user-authored; these aliases cover the stock templates
// (Front/Back), the common word-list conventions and the real GRE deck
// (`单词 / 音标 / 解释 / 例句`). Matching is case-insensitive, on whole names.
const APKG_FIELD_ALIASES: Record<'word' | 'translation' | 'phonetic', readonly string[]> = {
    word: [
        'word', 'words', 'term', 'headword', 'head word', 'vocabulary', 'vocab',
        'spelling', 'front', 'text', 'expression', '单词', '词', '词汇', '生词',
        '词条', '单字', 'từ', 'từ vựng',
    ],
    translation: [
        'translation', 'meaning', 'definition', 'back', 'zh', 'chinese',
        'vietnamese', 'explanation', 'gloss', '释义', '解释', '中文', '意思',
        '翻译', '义项', '注释', 'nghĩa', 'bản dịch', 'dịch',
    ],
    phonetic: [
        'phonetic', 'phonetics', 'ipa', 'pronunciation', 'pronounce', 'reading',
        'pinyin', '音标', '发音', '读音', '拼音', 'phiên âm', 'cách đọc',
    ],
};

function normalizeApkgFieldName(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function apkgFieldAliasIndex(fields: readonly string[], role: keyof typeof APKG_FIELD_ALIASES): number | null {
    const aliases = APKG_FIELD_ALIASES[role];
    for (let index = 0; index < fields.length; index += 1) {
        if (aliases.includes(normalizeApkgFieldName(fields[index]))) return index;
    }
    return null;
}

/**
 * Default APKG field mapping: the word is the first field, then the phonetic
 * field is picked by its name (`音标` / `IPA` / `Front` templates), and the
 * translation by its name (`解释` / `Meaning` / `Back`). Without a name hint the
 * translation falls back to the first remaining non-empty field, so a plain
 * two-field deck still maps word/translation to 0/1.
 */
export function defaultApkgFieldMap(fields: readonly string[]): ApkgFieldMap {
    const word = fields.length > 0 ? 0 : null;
    const phonetic = apkgFieldAliasIndex(fields, 'phonetic');
    let translation = apkgFieldAliasIndex(fields, 'translation');
    if (translation === word || translation === phonetic) translation = null;
    if (translation == null) {
        for (let index = 0; index < fields.length; index += 1) {
            if (index === word || index === phonetic) continue;
            translation = index;
            break;
        }
    }
    return {
        word,
        translation,
        phonetic: phonetic === word ? null : phonetic,
    };
}

/** Default list name = file stem, the way the spec names it (§1 step 3). */
export function defaultWordlistName(fileName: string): string {
    const base = fileName.split(/[\\/]/).pop() ?? '';
    const stem = base.replace(/\.[^.]+$/, '').trim() || base.trim();
    return stem.slice(0, WORDLIST_MAX_NAME_LENGTH);
}

function withSuffix(base: string, suffix: string): string {
    return `${base.slice(0, WORDLIST_MAX_NAME_LENGTH - suffix.length)}${suffix}`;
}

/**
 * 「同名自动加 (2)」: compare case-insensitively against the lists the account
 * already has and return the first free name.
 */
export function uniqueWordlistName(base: string, existingNames: readonly string[]): string {
    const trimmed = base.replace(/\s+/gu, ' ').trim().slice(0, WORDLIST_MAX_NAME_LENGTH);
    const used = new Set(existingNames.map((name) => name.trim().toLowerCase()));
    if (!trimmed) return trimmed;
    if (!used.has(trimmed.toLowerCase())) return trimmed;
    for (let copy = 2; copy < 1000; copy += 1) {
        const candidate = withSuffix(trimmed, ` (${copy})`);
        if (!used.has(candidate.toLowerCase())) return candidate;
    }
    return trimmed;
}
