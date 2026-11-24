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
import { AIGeneratedBadge } from './AIGeneratedBadge';
import { ReadingHighlightToggle } from './ReadingHighlight';
import { ReadingAudioBar, ReadingAudioTrigger } from './ReadingAudioBar';
import { useReadingAudio } from '../lib/useReadingAudio';
import { useReadingAnalysis } from '../lib/useReadingAnalysis';
import { useReadingHighlights } from '../lib/useReadingHighlights';
import { ReadingLayout } from './layout/ReadingLayout';
import type { InlineLanguagePoint } from './TranscriptBlock';
import { ReadingSurface, type ReadingSurfaceParagraph } from './reading/ReadingSurface';
import { SubHeader } from './ui/SubHeader';
import { ReadingHighlightRail } from './reading/ReadingHighlightRail';
import type { FavoriteDraft, FavoriteItem } from '../lib/favorites';

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
    /** App-owned favorites; the rail's star reads/writes through App. */
    favorites: readonly FavoriteItem[];
    /**
     * Teaching analysis merged into the article payload (specs/028 × 024),
     * keyed by paragraph index. Optional: without it the reader behaves
     * exactly as before (difficulty marks + clickable words only).
     */
    languagePointsByBlock?: Record<string, InlineLanguagePoint[]>;
    /** Contextual glosses keyed by lower-case word, per paragraph index. */
    wordGlossesByBlock?: Record<string, Record<string, string>>;
    /** Shared language-point switch from 我的 (defaults to on). */
    showLanguagePoints?: boolean;
    /** Guests may read this public article but not save words. */
    isGuest?: boolean;
    onRequestLogin?: () => void;
    /** App-owned optimistic favorite writes; the rail's star uses them. */
    onAddFavorite: (draft: FavoriteDraft) => Promise<FavoriteItem>;
    onRemoveFavorite: (id: string) => Promise<boolean>;
}

export function LibraryArticleReader({
    article,
    onClose,
    parentLabel,
    onWordLookup,
    favorites,
    languagePointsByBlock,
    wordGlossesByBlock,
    showLanguagePoints = true,
    isGuest = false,
    onRequestLogin,
    onAddFavorite,
    onRemoveFavorite,
}: LibraryArticleReaderProps) {
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
    // Analysis is already merged into the free-library payload by App
    // (specs/028 × 024); this reader never requests it, so the no-account path
    // stays request-free. The shared hook only normalizes the block maps, so
    // both article readers consume the exact same shape (specs/039).
    const payloadAnalysis = useMemo(() => {
        if (languagePointsByBlock === undefined && wordGlossesByBlock === undefined) return undefined;
        return {
            languagePointsByBlock: languagePointsByBlock ?? {},
            wordGlossesByBlock: wordGlossesByBlock ?? {},
        };
    }, [languagePointsByBlock, wordGlossesByBlock]);
    const analysis = useReadingAnalysis({
        contentRef: `library:${article.id}`,
        payloadAnalysis,
        // App owns the level refresh (it reloads the payload and re-passes the
        // maps); this surface only renders what it is handed.
        enabled: false,
    });
    const surfaceParagraphs = useMemo<ReadingSurfaceParagraph[]>(
        () => article.paragraphs.map((paragraph, index) => ({
            id: index,
            index,
            en: paragraph.en,
            zh: paragraph.zh,
            languagePoints: analysis.languagePointsByBlock[String(index)],
            glosses: analysis.wordGlossesByBlock[String(index)],
        })),
        [analysis.languagePointsByBlock, analysis.wordGlossesByBlock, article.paragraphs],
    );
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

    // Right-rail panels (P2-04) use the payload the reader already has.
    const railLanguagePoints: InlineLanguagePoint[] = [];
    const seenPoints = new Set<string>();
    for (const list of Object.values(analysis.languagePointsByBlock)) {
        for (const point of list) {
            const key = `${point.kind}:${point.text.trim().toLowerCase()}`;
            if (!point.text.trim() || seenPoints.has(key)) continue;
            seenPoints.add(key);
            railLanguagePoints.push(point);
        }
    }

    const jumpToParagraph = (index: number) => {
        const node = scrollRef.current?.querySelector<HTMLElement>(
            `[data-testid="library-paragraph-${index}"]`,
        );
        node?.scrollIntoView({ block: 'start' });
    };

    const rail = (
        <>
            <section
                data-testid="library-rail-toc"
                className="rounded-panel border border-line-subtle bg-surface/40 p-4 sm:p-5"
            >
                <h3 className="text-caption font-semibold text-fg-primary">
                    {t('library.article.paragraphs', { count: formatNumber(article.paragraphs.length) })}
                </h3>
                <div className="mt-2 flex max-h-80 flex-col gap-1 overflow-y-auto custom-scrollbar">
                    {article.paragraphs.map((paragraph, index) => (
                        <button
                            key={index}
                            type="button"
                            onClick={() => jumpToParagraph(index)}
                            className="flex w-full min-w-0 items-baseline gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-state-hover"
                        >
                            <span className="w-5 shrink-0 text-micro tabular-nums text-fg-muted">
                                {index + 1}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-micro text-fg-secondary">
                                {paragraph.en}
                            </span>
                        </button>
                    ))}
                </div>
            </section>

            {railLanguagePoints.length > 0 && (
                <section
                    data-testid="library-rail-language-points"
                    className="rounded-panel border border-line-subtle bg-surface/40 p-4 sm:p-5"
                >
                    <h3 className="text-caption font-semibold text-fg-primary">
                        {t('reading.languagePoints.toggle')}
                    </h3>
                    <p className="mt-1 text-micro leading-relaxed text-fg-muted">
                        {t('reading.languagePoints.hint')}
                    </p>
                    <ul className="mt-3 flex flex-col gap-2">
                        {railLanguagePoints.slice(0, 8).map((point) => (
                            <li key={`${point.kind}:${point.text}`} className="min-w-0">
                                <p className="break-words text-ui font-medium text-fg-strong">
                                    {point.text}
                                </p>
                                {point.meaning && (
                                    <p className="mt-0.5 break-words text-micro leading-relaxed text-fg-muted">
                                        {point.meaning}
                                    </p>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <ReadingHighlightRail
                testIdPrefix="library"
                texts={article.paragraphs.map((paragraph) => paragraph.en)}
                glossesByBlock={analysis.wordGlossesByBlock}
                enabled={highlight.enabled}
                isHighlighted={highlight.isHighlighted}
                wordLevels={highlight.wordLevels}
                favorites={favorites}
                sourceKind="library_article"
                sourceRef={article.id}
                sourceTitle={article.title}
                isGuest={isGuest}
                onRequestLogin={onRequestLogin}
                onAddFavorite={onAddFavorite}
                onRemoveFavorite={onRemoveFavorite}
            />
        </>
    );

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
                backTestId="library-article-back"
                titleAs="p"
            />

            <div
                ref={scrollRef}
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar"
            >
                <div style={audio.bottomInset ? { paddingBottom: audio.bottomInset } : undefined}>
                <ReadingLayout
                    testId="library-layout"
                    gridTestId="library-grid"
                    bodyTestId="library-body"
                    railTestId="library-rail"
                    className="py-4 sm:py-8"
                    rail={rail}
                >
                <article className="min-w-0">
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
                        <AIGeneratedBadge kind="translation" testId="library-ai-translation" />
                        <ReadingHighlightToggle
                            testId="library-highlight-toggle"
                            enabled={highlight.enabled}
                            onChange={highlight.setEnabled}
                            levelLabel={highlight.levelLabel}
                        />
                        <ReadingAudioTrigger audio={audio} testId="library-audio-trigger" />
                        <span className="text-[11px] text-zinc-600">{t('library.article.noApiHint')}</span>
                    </div>

                    <div className="mt-6">
                        <ReadingSurface
                            paragraphs={surfaceParagraphs}
                            testIdPrefix="library"
                            translationTestIdPrefix="library-article-translation"
                            isHighlighted={highlight.isHighlighted}
                            showLanguagePoints={showLanguagePoints}
                            audio={audio}
                            layout={bilingualColumns ? 'two-column' : 'single'}
                            showTranslations={showTranslations}
                            englishLang="en"
                            translationLang="zh-CN"
                            analysisStatus={analysis.status}
                            onWordClick={(word, e, paragraph) => onWordLookup(
                                word,
                                paragraph.en,
                                paragraph.index,
                                e,
                                article.id,
                                article.title,
                            )}
                        />
                    </div>
                </article>
                </ReadingLayout>
                </div>
            </div>

            <ReadingAudioBar audio={audio} testIdPrefix="library-audio" />
        </div>
    );
}
