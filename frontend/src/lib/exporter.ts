// Export favorites to Anki-importable TSV or generic CSV.
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
    downloadFile(`lingua-nova-anki-${dateStamp()}.tsv`, rows.join('\n'), 'text/tab-separated-values');
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
