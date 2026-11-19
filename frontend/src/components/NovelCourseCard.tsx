// Public-domain novel → 12-minute course entry (specs/030 §6).
//
// Pride and Prejudice (Project Gutenberg #1342) is deliberately *not* part of
// the 75-book library: this card is a second generation surface, not a reader.
// Picking a chapter posts to `/api/course/generate`; the result opens the same
// `#/app/today/lesson/{id}` screen static courses use. The backend owns the 1–61 range,
// caching and quota — the card only turns errors into readable states.
import { useRef, useState } from 'react';
import { ArrowRight, BookOpen, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { CourseApiError, generateCourse } from '../lib/course';
import { toast } from '../lib/toast';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';

const GUTENBERG_ID = 1342;
const CHAPTER_COUNT = 61;
const CHAPTERS = Array.from({ length: CHAPTER_COUNT }, (_, index) => index + 1);

const ENTRY_ACTION =
    'inline-flex items-center justify-center gap-2 h-9 px-4 rounded-xl text-sm font-medium transition-colors shrink-0';

interface NovelCourseCardProps {
    isGuest: boolean;
    /** Current highlighter level; the backend caches by it. */
    level: string;
    onRequestLogin?: () => void;
    /** Open the generated lesson (same route/screen as static courses). */
    onOpenLesson: (lessonId: string) => void;
}

export function NovelCourseCard({
    isGuest,
    level,
    onRequestLogin,
    onOpenLesson,
}: NovelCourseCardProps) {
    const { t } = useI18n();
    const [chapter, setChapter] = useState(1);
    const [generating, setGenerating] = useState(false);
    const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
    // Synchronous guard: state alone cannot stop a double click that lands
    // before React re-renders.
    const generatingRef = useRef(false);

    const handleGenerate = async () => {
        if (generatingRef.current) return;
        if (isGuest) {
            toast.info(t('course.generate.login'));
            onRequestLogin?.();
            return;
        }
        generatingRef.current = true;
        setGenerating(true);
        setErrorKey(null);
        try {
            const result = await generateCourse({
                sourceKind: 'novel',
                gutenbergId: GUTENBERG_ID,
                chapter,
                level,
            });
            onOpenLesson(result.lessonId);
        } catch (error) {
            if (error instanceof CourseApiError) {
                switch (error.code) {
                    case 'unauthorized':
                    case 'forbidden':
                        setErrorKey('course.generate.login');
                        onRequestLogin?.();
                        break;
                    case 'source_not_ready':
                        setErrorKey('course.generate.notReady');
                        break;
                    case 'rate_limited':
                        setErrorKey('course.generate.rateLimited');
                        break;
                    case 'network':
                    case 'server':
                    case 'generation_failed':
                    case 'invalid_response':
                        setErrorKey('course.generate.failed');
                        break;
                    default:
                        setErrorKey('course.generate.generic');
                        break;
                }
            } else {
                setErrorKey('course.generate.failed');
            }
        } finally {
            generatingRef.current = false;
            setGenerating(false);
        }
    };

    return (
        <motion.section
            data-testid="novel-course-card"
            whileTap={{ scale: 0.995 }}
            transition={{ type: 'spring', stiffness: 550, damping: 35 }}
            className="mt-2.5 sm:mt-4 rounded-2xl sm:rounded-3xl border border-white/5 bg-zinc-900/40 p-3.5 sm:p-5"
        >
            <div className="flex flex-col lg:flex-row lg:items-center gap-3.5 sm:gap-5">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
                        <BookOpen className="w-5 h-5 text-blue-400" />
                    </div>
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-[10px] sm:text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300">
                                {t('novel.entry.badge')}
                            </span>
                            <span className="text-[10px] sm:text-[11px] font-medium text-zinc-500">
                                {t('novel.entry.meta')}
                            </span>
                        </div>
                        <h3 className="mt-1 text-sm sm:text-[15px] font-semibold tracking-tight text-zinc-100">
                            {t('novel.entry.title')}
                        </h3>
                        <p className="mt-0.5 text-[11px] sm:text-xs leading-relaxed text-zinc-500">
                            {t('novel.entry.desc')}
                        </p>
                        {isGuest && (
                            <p
                                data-testid="novel-course-guest-hint"
                                className="mt-1 text-[11px] leading-relaxed text-zinc-500"
                            >
                                {t('novel.entry.guestHint')}
                            </p>
                        )}
                        {errorKey && (
                            <p
                                data-testid="novel-course-error"
                                role="alert"
                                className="mt-1 text-[11px] leading-relaxed text-red-300"
                            >
                                {t(errorKey)}
                            </p>
                        )}
                    </div>
                </div>

                <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
                    <label className="flex items-center gap-2 shrink-0">
                        <span className="text-[11px] font-medium text-zinc-500">
                            {t('novel.entry.chapter')}
                        </span>
                        <select
                            data-testid="novel-chapter-select"
                            value={chapter}
                            onChange={(event) => {
                                setChapter(Number.parseInt(event.target.value, 10));
                                // A stale "not ready" / "failed" line belongs to
                                // the previous chapter, not the new one.
                                setErrorKey(null);
                            }}
                            disabled={generating}
                            aria-label={t('novel.entry.chapterAria')}
                            title={t('novel.entry.chapterAria')}
                            className="appearance-none bg-zinc-800/80 text-zinc-200 text-xs font-medium rounded-lg border border-white/5 h-9 pl-2.5 pr-7 outline-none cursor-pointer hover:text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed bg-no-repeat bg-[right_0.5rem_center] bg-[length:10px] bg-[url('data:image/svg+xml;utf8,<svg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2010%206%22><path%20d=%22M1%201l4%204%204-4%22%20stroke=%22%2371717a%22%20stroke-width=%221.5%22%20fill=%22none%22%20stroke-linecap=%22round%22/></svg>')]"
                        >
                            {CHAPTERS.map((number) => (
                                <option key={number} value={number}>
                                    {t('novel.entry.chapterOption', { chapter: number })}
                                </option>
                            ))}
                        </select>
                    </label>

                    <button
                        type="button"
                        data-testid="novel-course-generate"
                        data-state={generating ? 'loading' : 'idle'}
                        onClick={() => void handleGenerate()}
                        disabled={generating}
                        aria-busy={generating}
                        aria-label={generating ? t('novel.entry.loading') : t('course.generate.cta')}
                        title={generating ? t('novel.entry.loading') : t('course.generate.cta')}
                        className={`${ENTRY_ACTION} flex-1 sm:flex-none bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-blue-300 hover:text-blue-200 disabled:opacity-60 disabled:cursor-wait`}
                    >
                        {generating
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <ArrowRight className="w-4 h-4" />}
                        <span>{generating ? t('novel.entry.loading') : t('course.generate.cta')}</span>
                    </button>
                </div>
            </div>
        </motion.section>
    );
}
