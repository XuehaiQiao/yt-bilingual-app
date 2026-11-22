// Export word lists to Anki-importable TSV or generic CSV.
//
// Two layers:
//   * `exportAnkiTsv` / `exportCsv` keep the original 我的收藏 semantics
//     (Front/Back/Tags; CSV with full context), unchanged except the TSV file
//     name now carries the list identifier (P0-16).
//   * `exportTable` is the shared column exporter every other word list uses
//     (已掌握 / CEFR / GRE / CET4 / CET6 / 短语 / 自定义). One implementation for
//     escaping, BOM and the `<list>-<YYYYMMDD>` file name so no surface copies
//     the format rules.
import type { FavoriteItem } from './favorites';
import { formatDate, t } from '../i18n';

function downloadFile(filename: string, content: string, mime: string) {
    const blob = new Blob(['﻿' + content], { type: `${mime};charset=utf-8` }); // BOM for Excel
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

const dateStamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

/** One column of a generic list export: header text + how to read the cell. */
export interface ExportColumn<T> {
    header: string;
    value: (row: T) => string | number | null | undefined;
}

/** The two formats every word-list export offers. */
export type ExportTableFormat = 'tsv' | 'csv';

const cellText = (value: string | number | null | undefined): string => (
    value == null ? '' : String(value)
);

/**
 * Download a generic word list as TSV or CSV.
 *
 * - **TSV** has **no header row**: these files are meant to be imported into
 *   Anki, where a header would become a bogus card. Tabs/newlines are flattened
 *   to spaces, same as the favorites TSV. Columns follow the caller's order.
 * - **CSV** starts with the column headers (translated) and escapes fields with
 *   RFC 4180 quoting, so Excel/Numbers open it directly.
 * - Both prepend a UTF-8 BOM (Excel reads Chinese correctly).
 * - File name: `lingua-nova-<baseName>-<YYYYMMDD>.<ext>`, where `baseName` is
 *   the list identifier (`mastered`, `cefr`, `gre`, `phrases`,
 *   `custom-<list>` …), so every downloaded file says which list it came from.
 *
 * The caller passes the already filtered/sorted/cross-page rows; this helper
 * never reaches the network and never writes a partial file (rows are complete
 * before it is called).
 */
export function exportTable<T>(input: {
    format: ExportTableFormat;
    /** List identifier in the file name (e.g. `mastered`, `gre`). */
    baseName: string;
    columns: readonly ExportColumn<T>[];
    rows: readonly T[];
}): void {
    const { format, baseName, columns, rows } = input;
    const stamp = dateStamp();
    if (format === 'tsv') {
        const lines = rows.map((row) => columns
            .map((column) => cellText(column.value(row)).replace(/[\t\n\r]+/g, ' ').trim())
            .join('\t'));
        downloadFile(
            `lingua-nova-${baseName}-${stamp}.tsv`,
            lines.join('\n'),
            'text/tab-separated-values',
        );
        return;
    }
    const esc = (value: string | number | null | undefined) => (
        `"${cellText(value).replace(/"/g, '""')}"`
    );
    const header = columns.map((column) => esc(column.header)).join(',');
    const lines = rows.map((row) => columns
        .map((column) => esc(column.value(row)))
        .join(','));
    downloadFile(`lingua-nova-${baseName}-${stamp}.csv`, [header, ...lines].join('\n'), 'text/csv');
}

/** One Anki note per favorite: Front / Back / Tags (tab-separated). */
export function exportAnkiTsv(favorites: FavoriteItem[]) {
    const clean = (s: string) => (s || '').replace(/[\t\n\r]+/g, ' ').trim();
    const rows = favorites.map(fav => {
        const isVocab = fav.type === 'vocabulary';
        const front = clean(fav.en_text);
        const backParts = isVocab
            ? [clean(fav.zh_text), fav.context_en ? `${t('export.examplePrefix')}${clean(fav.context_en)}` : '']
            : [clean(fav.zh_text)];
        const back = backParts.filter(Boolean).join('<br>');
        const tags = `lingua-nova ${isVocab ? 'vocabulary' : 'sentence'}`;
        return [front, back, tags].join('\t');
    });
    // P0-16: the file name carries the list identifier (`favorites`) too.
    downloadFile(`lingua-nova-favorites-anki-${dateStamp()}.tsv`, rows.join('\n'), 'text/tab-separated-values');
}

/** Spreadsheet-friendly CSV with full context columns. */
export function exportCsv(favorites: FavoriteItem[]) {
    const esc = (s: string) => `"${(s || '').replace(/"/g, '""')}"`;
    const header = [
        t('export.type'), t('export.english'), t('export.chinese'),
        t('export.exampleEn'), t('export.exampleZh'),
        t('export.videoId'), t('export.timestamp'), t('export.addedAt'),
    ];
    const rows = favorites.map(fav => [
        esc(fav.type === 'vocabulary' ? t('export.typeVocabulary') : t('export.typeSentence')),
        esc(fav.en_text),
        esc(fav.zh_text),
        esc(fav.context_en || ''),
        esc(fav.context_zh || ''),
        esc(fav.videoId),
        String(Math.round(fav.start)),
        esc(fav.added_at ? formatDate(new Date(fav.added_at)) : ''),
    ].join(','));
    downloadFile(`lingua-nova-favorites-${dateStamp()}.csv`, [header.join(','), ...rows].join('\n'), 'text/csv');
}
