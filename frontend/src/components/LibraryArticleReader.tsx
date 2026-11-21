// Local reader for an original free article (user request #11).
//
// Deliberately lightweight: paragraphs + per-paragraph Chinese translation
// are already on disk, so this screen never imports the reading API client.
// The translation toggle is local state only — there is no "translate this"
// button, no polling, and no /api/article request.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Languages } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { LibraryArticle } from '../lib/library';
import { difficultyBadge, fetchDifficultyBatch, type DifficultyItem } from '../lib/difficulty';
import { ReadingHighlightToggle } from './ReadingHighlight';
import { ReadingAudioBar, ReadingAudioTrigger } from './ReadingAudioBar';
import { ReadingAudioText } from './ReadingAudioText';
import { useReadingAudio } from '../lib/useReadingAudio';
import { useReadingHighlights } from '../lib/useReadingHighlights';
import { BilingualRow, bilingualReadingWidth } from './BilingualRow';
import { SubHeader } from './ui/SubHeader';
import { ReadingVocabButton } from './ReadingVocabButton';
import type { FavoriteItem } from '../lib/favorites';

interface LibraryArticleReaderProps {
    article: LibraryArticle;
    onClose: () => void;
    /** Parent screen name for the back control's aria label. */
    parentLabel?: string;
    /**
     * Reuse the app-wide dictionary card (App owns its state/favorites).
     * Free library articles carry their id/title as the lookup source so a
     * saved word keeps its provenance.
     */
    onWordLookup: (
        word: string,
        context: string,
        start: number,
        e: React.MouseEvent,
        sourceId?: string,
        sourceTitle?: string,
    ) => void;
    /** App-owned favorites; the header chip shows the vocabulary count. */
    favorites: readonly FavoriteItem[];
    /** Same entry as the video page: navigate to the word-book full page. */
    onOpenWordbook: () => void;
}

export function LibraryArticleReader({ article, onClose, parentLabel, onWordLookup, favorites, onOpenWordbook }: LibraryArticleReaderProps) {
    const { t, formatNumber } = useI18n();
    const [showTranslations, setShowTranslations] = useState(true);
    // Every paragraph has a Chinese translation on disk, so "show translations"
    // is also "two columns on desktop".
    const bilingualColumns = showTranslations;
    // The card shows the computed CEFR input band (M2). Fetch the same row so
    // the detail header cannot disagree with the card.
    const [difficulty, setDifficulty] = useState<DifficultyItem | null>(null);
    // Same threshold + cache as the other three readers (B1 → mark B2+ words).
    const highlight = useReadingHighlights(article.paragraphs.map((paragraph) => paragraph.en));
    // Listening / shadowing for this article: the shared bar owns playback, the
    // reader only supplies the paragraph texts and the scroll container.
    const audioParagraphs = useMemo(
        () => article.paragraphs.map((paragraph) => paragraph.en),
        [article.paragraphs],
    );
    const scrollRef = useRef<HTMLDivElement>(null);
    const audio = useReadingAudio({
        paragraphs: audioParagraphs,
        scopeKey: `library:${article.id}`,
        scrollRef,
    });

    useEffect(() => {
        let cancelled = false;
        fetchDifficultyBatch([{ kind: 'article', ref: article.id }])
            .then((map) => {
                if (!cancelled) setDifficulty(map[`article:${article.id}`] ?? null);
            })
            .catch(() => {
                // Keep the editorial level as a fallback; never invent a band.
            });
        return () => {
            cancelled = true;
        };
    }, [article.id]);

    const displayLevel = difficultyBadge(difficulty, article.level);

    return (
        <div data-testid="library-reader" className="h-full min-h-0 flex flex-col bg-[#09090b]">
            <SubHeader
                title={t('topbar.feature.library')}
                onBack={onClose}
                parentLabel={parentLabel}
                meta={(
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-micro font-semibold text-emerald-300">
                        <BookOpen className="w-3.5 h-3.5" />
                        {t('library.article.badge')}
                    </span>
                )}
                actions={<ReadingVocabButton favorites={favorites} onOpenWordbook={onOpenWordbook} />}
                backTestId="library-article-back"
                titleAs="p"
            />

            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
                <article
                    className={`mx-auto px-4 sm:px-8 py-6 sm:py-10 ${bilingualReadingWidth(bilingualColumns)}`}
                    style={audio.bottomInset ? { paddingBottom: audio.bottomInset } : undefined}
                >
                    <header>
                        <h1
                            data-testid="library-article-title"
                            className="text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-100 break-words"
                        >
                            {article.title}
                        </h1>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                            <span
                                data-testid="library-article-detail-difficulty"
                                data-cefr-input={difficulty?.cefrInput ?? ''}
                                title={t('difficulty.estimateHint')}
                                className="inline-flex items-center rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-300"
                            >
                                {displayLevel ?? t('difficulty.unrated')}
                            </span>
                            <span className="tabular-nums">
                                {t('library.words', { count: formatNumber(article.wordCount) })}
                            </span>
                            <span className="tabular-nums">
                                {t('library.article.paragraphs', { count: formatNumber(article.paragraphs.length) })}
                            </span>
                            <span>{t('library.article.by', { author: article.author })}</span>
                            <span className="text-zinc-600">{t('library.article.license', { license: article.license })}</span>
                        </div>
                    </header>

                    <div className="mt-5 flex flex-wrap items-center gap-2 rounded-2xl border border-white/5 bg-zinc-900/40 px-3 py-2">
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-400 shrink-0">
                            <Languages className="w-4 h-4" />
                            {t('library.article.translationAria')}
                        </span>
                        <div
                            role="group"
                            aria-label={t('library.article.translationAria')}
                            data-testid="library-translation-toggle"
                            className="inline-flex items-center rounded-lg bg-zinc-800/80 p-0.5 border border-white/5"
                        >
                            <button
                                type="button"
                                data-testid="library-translation-all"
                                aria-pressed={showTranslations}
                                onClick={() => setShowTranslations(true)}
                                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                                    showTranslations
                                        ? 'bg-zinc-100 text-zinc-900'
                                        : 'text-zinc-400 hover:text-zinc-200'
                                }`}
                            >
                                {t('library.article.translation.all')}
                            </button>
                            <button
                                type="button"
                                data-testid="library-translation-hidden"
                                aria-pressed={!showTranslations}
                                onClick={() => setShowTranslations(false)}
                                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                                    !showTranslations
                                        ? 'bg-zinc-100 text-zinc-900'
                                        : 'text-zinc-400 hover:text-zinc-200'
                                }`}
                            >
                                {t('library.article.translation.hidden')}
                            </button>
                        </div>
                        <ReadingHighlightToggle
                            testId="library-highlight-toggle"
                            enabled={highlight.enabled}
                            onChange={highlight.setEnabled}
                            levelLabel={highlight.levelLabel}
                        />
                        <ReadingAudioTrigger audio={audio} testId="library-audio-trigger" />
                        <span className="text-[11px] text-zinc-600">{t('library.article.noApiHint')}</span>
                    </div>

                    <div className="mt-6 space-y-1.5">
                        {article.paragraphs.map((paragraph, index) => (
                            <article
                                key={index}
                                data-testid={`library-paragraph-${index}`}
                                className="rounded-2xl border border-transparent px-4 py-4 sm:px-5 hover:border-white/5 hover:bg-zinc-900/30 transition-colors"
                            >
                                <BilingualRow
                                    twoColumn={bilingualColumns}
                                    testId={`library-row-${index}`}
                                    english={(
                                        <p
                                            data-testid={`library-en-${index}`}
                                            data-lookup-context={paragraph.en}
                                            data-lookup-start={index}
                                            lang="en"
                                            className="ruby-safe-line text-base sm:text-[17px] text-zinc-200 break-words"
                                        >
                                            <ReadingAudioText
                                                text={paragraph.en}
                                                paragraphIndex={index}
                                                active={audio.active}
                                                isHighlighted={highlight.isHighlighted}
                                                onWordClick={(word, e) => onWordLookup(
                                                    word,
                                                    paragraph.en,
                                                    index,
                                                    e,
                                                    article.id,
                                                    article.title,
                                                )}
                                            />
                                        </p>
                                    )}
                                    translation={showTranslations ? (
                                        <p
                                            data-testid={`library-article-translation-${index}`}
                                            lang="zh-CN"
                                            className="text-[15px] leading-relaxed text-zinc-400 break-words"
                                        >
                                            {paragraph.zh}
                                        </p>
                                    ) : undefined}
                                />
                            </article>
                        ))}
                    </div>
                </article>
            </div>

            <ReadingAudioBar audio={audio} testIdPrefix="library-audio" />
        </div>
    );
}
