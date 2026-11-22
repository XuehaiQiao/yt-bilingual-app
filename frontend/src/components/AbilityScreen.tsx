// CEFR ability profile (M1 / docs/项目计划-CEFR能力标定.md §8).
//
// One page answers four questions honestly:
//   1. what interval does the vocabulary evidence support, and how strong is it;
//   2. which skills are untested / have insufficient evidence;
//   3. what a learner at that band can generally do (can-do, with basis);
//   4. what raw evidence exists (type / date / result only, never item text).
//
// Vocabulary recognition is a support metric, not a fifth skill: it is rendered
// in its own summary card, never as a row of the four-skill grid. M1 never
// prints "measured", a point grade, a numeric confidence, an accuracy figure or
// an IELTS equivalence.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    ArrowLeft,
    ArrowRight,
    BookOpen,
    Check,
    ChevronRight,
    Clock3,
    Ear,
    FileText,
    Gauge,
    Info,
    Loader2,
    Mic,
    PenLine,
    RotateCcw,
    ShieldQuestion,
    Sparkles,
    SquarePen,
} from 'lucide-react';
import {
    canDoBasis,
    canDoSource,
    canDoText,
    getAbilityProfile,
    getCanDo,
    resolveSelfAssessItems,
    selfAssess,
    type AbilityCanDo,
    type AbilityCanDoEntry,
    type AbilityEvidence,
    type AbilityProfile,
    type AbilitySelfAssessItem,
    type AbilitySkillKey,
    type AbilitySkillProfile,
} from '../lib/ability';
import { describeApiError } from '../lib/toast';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { Dialog } from './ui/Dialog';
import { SubHeader } from './ui/SubHeader';
import { PageContainer } from './layout/PageContainer';
import { PageGrid } from './layout/PageGrid';
import { SideRail } from './layout/SideRail';

interface AbilityScreenProps {
    /** Leave the screen (the previous page stays mounted underneath). */
    onClose: () => void;
    /** Parent screen name for the back control's aria label. */
    parentLabel?: string;
    /** Start / retest the 12-minute placement test. */
    onOpenPlacement: () => void;
}

const PAGE_SIZE = 6;
const MIN_ANSWERS = 12;

const CARD = 'rounded-3xl border border-white/5 bg-zinc-900/40';
const SUB_CARD = 'rounded-2xl border border-white/5 bg-zinc-800/30';
const PRIMARY_BUTTON =
    'inline-flex items-center justify-center gap-2 h-10 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-200 ease-apple disabled:opacity-50 disabled:pointer-events-none';
const SECONDARY_BUTTON =
    'inline-flex items-center justify-center gap-2 h-9 px-3 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50 disabled:pointer-events-none';
const GHOST_BUTTON =
    'inline-flex items-center justify-center gap-2 h-9 px-3 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors disabled:opacity-50 disabled:pointer-events-none';

const STRENGTH_KEYS: Record<string, TranslationKey> = {
    // Backend `evidenceStrength` uses strong/medium/weak; precision/validity
    // labels use high/medium/low. Both render as the same three-tier badge.
    strong: 'placement.confidence.high',
    high: 'placement.confidence.high',
    medium: 'placement.confidence.medium',
    weak: 'placement.confidence.low',
    low: 'placement.confidence.low',
};

const EVIDENCE_TYPE_KEYS: Record<string, TranslationKey> = {
    placement_answer: 'ability.evidence.type.placement_answer',
    self_assess: 'ability.evidence.type.self_assess',
    quiz_attempt: 'ability.evidence.type.quiz_attempt',
    review_state: 'ability.evidence.type.review_state',
    watch_behavior: 'ability.evidence.type.watch_behavior',
    dictation: 'ability.evidence.type.dictation',
    reading_progress: 'ability.evidence.type.reading_progress',
    writing_sample: 'ability.evidence.type.writing_sample',
    speaking_sample: 'ability.evidence.type.speaking_sample',
};

const SOURCE_KEYS: Record<string, TranslationKey> = {
    placement: 'ability.source.placement',
    self_assess: 'ability.source.self_assess',
};

const SKILL_LABEL_KEYS: Record<string, TranslationKey> = {
    vocabulary: 'ability.skill.vocabulary',
    reading: 'ability.skill.reading',
    listening: 'ability.skill.listening',
    speaking: 'ability.skill.speaking',
    writing: 'ability.skill.writing',
    grammar: 'ability.skill.grammar',
};

const RATING_KEYS: readonly TranslationKey[] = [
    'ability.assess.rating.0',
    'ability.assess.rating.1',
    'ability.assess.rating.2',
    'ability.assess.rating.3',
];

const RATING_SHORT_KEYS: readonly TranslationKey[] = [
    'ability.assess.ratingShort.0',
    'ability.assess.ratingShort.1',
    'ability.assess.ratingShort.2',
    'ability.assess.ratingShort.3',
];

/** `A2–B2` → a single token so the interval never wraps mid-band. */
function intervalLabel(value: string): string {
    return value.replace(/[–—]/g, '–');
}

function makeRequestId(): string {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch {
        // Non-secure context / old browser: fall back to a local unique key.
    }
    return `sa-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function countCanDoEntries(canDo: AbilityCanDo | null | undefined): number {
    if (!canDo?.bySkill) return 0;
    return Object.values(canDo.bySkill).reduce(
        (total, entries) => total + (Array.isArray(entries) ? entries.length : 0),
        0,
    );
}

/** True when the profile has placement-derived vocabulary evidence to show. */
function hasVocabularyEvidence(vocabulary: AbilitySkillProfile | null | undefined): boolean {
    if (!vocabulary) return false;
    if (!['uncalibrated', 'measured', 'estimated'].includes(String(vocabulary.status))) return false;
    return (vocabulary.evidenceCount ?? 0) > 0 || Boolean(vocabulary.label || vocabulary.high);
}

function skillStatusMeta(status: string): { labelKey: TranslationKey; chipClass: string } {
    switch (status) {
        case 'self_report':
            return {
                labelKey: 'ability.badge.selfReport',
                chipClass: 'bg-amber-500/10 border-amber-500/20 text-amber-300',
            };
        case 'insufficient':
            return {
                labelKey: 'ability.badge.insufficient',
                chipClass: 'bg-white/5 border-white/5 text-zinc-400',
            };
        case 'not_measured':
            return {
                labelKey: 'ability.badge.notMeasured',
                chipClass: 'bg-white/5 border-white/5 text-zinc-400',
            };
        case 'estimated':
            return {
                labelKey: 'ability.badge.estimated',
                chipClass: 'bg-amber-500/10 border-amber-500/20 text-amber-300',
            };
        case 'measured':
            return {
                labelKey: 'ability.badge.measured',
                chipClass: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300',
            };
        case 'uncalibrated':
        default:
            return {
                labelKey: 'ability.badge.uncalibrated',
                chipClass: 'bg-blue-500/10 border-blue-500/20 text-blue-300',
            };
    }
}

// ── Self-assessment sheet ────────────────────────────────────────────────

function SelfAssessSheet({
    items,
    onClose,
    onSubmitted,
}: {
    items: AbilitySelfAssessItem[];
    onClose: () => void;
    onSubmitted: (profile: AbilityProfile | null) => void;
}) {
    const { t, formatNumber } = useI18n();
    const [answers, setAnswers] = useState<Record<string, number>>({});
    const [page, setPage] = useState(0);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const startedAtRef = useRef(Date.now());

    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const pageItems = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const answeredCount = Object.keys(answers).length;

    const ratingLabel = (value: number): string => t(RATING_KEYS[value]);

    const submit = async () => {
        if (submitting) return;
        const payload = items
            .filter((item) => typeof answers[item.id] === 'number')
            .map((item) => ({ itemId: item.id, rating: answers[item.id] }));
        if (payload.length < MIN_ANSWERS) {
            setError(t('ability.assess.minimum', { answered: formatNumber(payload.length) }));
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const result = await selfAssess({
                clientRequestId: makeRequestId(),
                answers: payload,
                durationMs: Math.max(0, Date.now() - startedAtRef.current),
            });
            onSubmitted(result.profile ?? null);
        } catch (err) {
            setError(await describeApiError(err));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog
            open
            onClose={onClose}
            title={t('ability.assess.title')}
            description={t('ability.assess.subtitle')}
            size="md"
            sheet
            loading={submitting}
            closeLabel={t('ability.assess.closeAria')}
            testId="ability-self-assess-sheet"
            footer={
                <div className="flex w-full flex-col gap-2">
                    {error && (
                        <p data-testid="ability-self-assess-error" className="text-xs leading-relaxed text-amber-300 break-words">
                            {error}
                        </p>
                    )}
                    {answeredCount < MIN_ANSWERS && (
                        <p className="text-[11px] text-zinc-500">
                            {t('ability.assess.minimum', { answered: formatNumber(answeredCount) })}
                        </p>
                    )}
                    <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setPage((prev) => Math.max(0, prev - 1))}
                            disabled={page === 0 || submitting}
                            className={`${SECONDARY_BUTTON} w-full sm:w-auto`}
                        >
                            <ArrowLeft className="w-4 h-4" />
                            {t('ability.assess.prev')}
                        </button>
                        <div className="flex-1" />
                        {page < pages - 1 ? (
                            <button
                                type="button"
                                data-testid="ability-self-assess-next"
                                onClick={() => setPage((prev) => Math.min(pages - 1, prev + 1))}
                                disabled={submitting}
                                className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
                            >
                                {t('ability.assess.next')}
                                <ArrowRight className="w-4 h-4" />
                            </button>
                        ) : (
                            <button
                                type="button"
                                data-testid="ability-self-assess-submit"
                                onClick={() => void submit()}
                                disabled={submitting || answeredCount < MIN_ANSWERS}
                                className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
                            >
                                {submitting ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                    <Check className="w-4 h-4" />
                                )}
                                {submitting ? t('ability.assess.submitting') : t('ability.assess.submit')}
                            </button>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={submitting}
                        className={`${GHOST_BUTTON} w-full sm:w-auto`}
                    >
                        {t('ability.assess.close')}
                    </button>
                </div>
            }
        >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="text-[11px] font-medium text-zinc-400 tabular-nums">
                    {t('ability.assess.page', {
                        current: formatNumber(page + 1),
                        total: formatNumber(pages),
                    })}
                </span>
                <span
                    data-testid="ability-self-assess-answered"
                    className="text-[11px] font-medium text-zinc-500 tabular-nums"
                >
                    {t('ability.assess.answered', {
                        answered: formatNumber(answeredCount),
                        total: formatNumber(items.length),
                    })}
                </span>
                <span className="text-[11px] text-zinc-600">{t('ability.assess.skipHint')}</span>
            </div>

            <p className="pt-2 text-[11px] leading-relaxed text-zinc-500">
                {t('ability.assess.legend')}
            </p>

            <div className="mt-4 space-y-3">
                {pageItems.map((item, pageIndex) => {
                    const number = page * PAGE_SIZE + pageIndex + 1;
                    const current = answers[item.id];
                    return (
                        <div
                            key={item.id}
                            data-testid={`ability-self-assess-item-${item.id}`}
                            className={SUB_CARD + ' p-3.5'}
                        >
                            <div className="flex items-start gap-2.5">
                                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white/5 text-[11px] font-semibold text-zinc-500 tabular-nums">
                                    {number}
                                </span>
                                <div className="min-w-0">
                                    <p className="text-sm leading-relaxed text-zinc-200 break-words">
                                        {item.statement}
                                    </p>
                                    {(item.skill || item.band) && (
                                        <p className="mt-1 text-[11px] text-zinc-500">
                                            {t('ability.assess.itemSkill', {
                                                skill: item.skill
                                                    ? (SKILL_LABEL_KEYS[item.skill] ? t(SKILL_LABEL_KEYS[item.skill]) : item.skill)
                                                    : '—',
                                                band: item.band || '—',
                                            })}
                                        </p>
                                    )}
                                </div>
                            </div>
                            <div
                                role="radiogroup"
                                aria-label={item.statement}
                                className="mt-2.5 grid grid-cols-4 gap-0.5 rounded-lg border border-white/5 bg-zinc-800/80 p-0.5"
                            >
                                {[0, 1, 2, 3].map((rating) => {
                                    const selected = current === rating;
                                    return (
                                        <button
                                            key={rating}
                                            type="button"
                                            role="radio"
                                            aria-checked={selected}
                                            aria-label={t('ability.assess.ratingAria', {
                                                statement: item.statement,
                                                label: ratingLabel(rating),
                                            })}
                                            data-testid={`ability-self-assess-option-${item.id}-${rating}`}
                                            onClick={() => {
                                                setAnswers((prev) => ({ ...prev, [item.id]: rating }));
                                                setError(null);
                                            }}
                                            className={`min-w-0 rounded-md px-1 py-1.5 text-center transition-[background-color,color] duration-200 ease-apple ${
                                                selected
                                                    ? 'bg-zinc-100 text-zinc-900'
                                                    : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
                                            }`}
                                        >
                                            <span className="block text-[11px] font-semibold tabular-nums">
                                                {rating}
                                            </span>
                                            <span className="block truncate text-[10px] leading-tight">
                                                {t(RATING_SHORT_KEYS[rating])}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
        </Dialog>
    );
}

// ── Evidence drawer ──────────────────────────────────────────────────────

function EvidenceDrawer({
    evidence,
    selfReportBand,
    selfReportCaveat,
    onClose,
}: {
    evidence: AbilityEvidence[];
    selfReportBand: string | null;
    selfReportCaveat: string | null;
    onClose: () => void;
}) {
    const { t, formatNumber, formatDate } = useI18n();

    const typeLabel = (type: string | null | undefined): string => {
        if (!type) return t('ability.evidence.type.other');
        const key = EVIDENCE_TYPE_KEYS[type];
        return key ? t(key) : t('ability.evidence.type.other');
    };

    const resultLabel = (item: AbilityEvidence): string => {
        if (item.result) return item.result;
        if (item.band) return item.band;
        return t('ability.evidence.noResult');
    };

    return (
        <Dialog
            open
            onClose={onClose}
            title={t('ability.evidence.title')}
            description={t('ability.evidence.subtitle', { count: formatNumber(evidence.length) })}
            size="md"
            sheet
            closeLabel={t('ability.evidence.closeAria')}
            testId="ability-evidence-drawer"
        >
            <p className="text-[11px] leading-relaxed text-zinc-500">
                {t('ability.evidence.privacy')}
            </p>
            {evidence.length === 0 && !selfReportBand && (
                <p className="py-10 text-center text-xs text-zinc-500">{t('ability.evidence.empty')}</p>
            )}
            <ul className="mt-3 space-y-2">
                {evidence.map((item, index) => (
                    <li
                        key={item.id ?? `${item.type ?? 'evidence'}-${index}`}
                        data-testid="ability-evidence-item"
                        className="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-zinc-800/30 p-3"
                    >
                        <div className="flex min-w-0 items-center gap-2.5">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/5 text-zinc-500">
                                <FileText className="w-4 h-4" />
                            </span>
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-zinc-200">
                                    {typeLabel(item.type)}
                                </p>
                                <p className="mt-0.5 text-[11px] text-zinc-500 tabular-nums">
                                    {item.observedAt
                                        ? formatDate(item.observedAt, { dateStyle: 'medium' })
                                        : t('ability.time.unknown')}
                                </p>
                            </div>
                        </div>
                        <span className="shrink-0 rounded-full border border-white/5 bg-white/5 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                            {resultLabel(item)}
                        </span>
                    </li>
                ))}
            </ul>

            {selfReportBand && (
                <div
                    data-testid="ability-evidence-self-report"
                    className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3"
                >
                    <p className="text-sm font-medium text-amber-200">
                        {t('ability.evidence.selfReport', { band: selfReportBand })}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-amber-200/70">
                        {selfReportCaveat || t('ability.skill.writing.caveat')}
                    </p>
                </div>
            )}
        </Dialog>
    );
}

// ── Screen ───────────────────────────────────────────────────────────────

export function AbilityScreen({ onClose, parentLabel, onOpenPlacement }: AbilityScreenProps) {
    const { t, language, formatNumber, formatDate } = useI18n();
    const [profile, setProfile] = useState<AbilityProfile | null>(null);
    const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
    const [error, setError] = useState<string | null>(null);
    const [reloadNonce, setReloadNonce] = useState(0);
    const [remoteCanDo, setRemoteCanDo] = useState<AbilityCanDo | null>(null);
    const [evidenceOpen, setEvidenceOpen] = useState(false);
    const [assessOpen, setAssessOpen] = useState(false);
    const [announce, setAnnounce] = useState('');
    // The "N days ago" copy is computed from this value instead of calling
    // Date.now() during render; refreshing the profile re-stamps it.
    const [now, setNow] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);

    const load = useCallback(async (signal: { cancelled: boolean }) => {
        setPhase('loading');
        setError(null);
        setRemoteCanDo(null);
        try {
            const next = await getAbilityProfile(language);
            if (signal.cancelled) return;
            setProfile(next);
            setPhase('ready');
            setNow(Date.now());
            // Fallback: an older/partial response without can-do still shows the
            // public descriptors for the current band. The server-localized
            // profile payload always wins when it exists.
            const level = next.canDo?.level || next.vocabulary?.cefr || null;
            if (level && countCanDoEntries(next.canDo) === 0) {
                const skills: AbilitySkillKey[] = ['listening', 'reading', 'speaking', 'writing'];
                const settled = await Promise.allSettled(skills.map((skill) => getCanDo(level, skill, language)));
                if (signal.cancelled) return;
                const bySkill: Record<string, AbilityCanDoEntry[]> = {};
                settled.forEach((result, index) => {
                    if (result.status !== 'fulfilled') return;
                    const entries = result.value.items
                        ?? result.value.canDo?.bySkill?.[skills[index]]
                        ?? [];
                    if (entries.length > 0) bySkill[skills[index]] = entries;
                });
                if (Object.keys(bySkill).length > 0) {
                    setRemoteCanDo({ level, bySkill });
                }
            }
        } catch (err) {
            if (signal.cancelled) return;
            setError(await describeApiError(err));
            setPhase('error');
        }
    }, [language]);

    useEffect(() => {
        const signal = { cancelled: false };
        // One-shot external fetch: `load` sets its own loading/error state.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load(signal);
        return () => {
            signal.cancelled = true;
        };
    }, [load, reloadNonce, language]);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: 0 });
    }, [reloadNonce]);

    useEffect(() => {
        if (!announce) return;
        const timer = window.setTimeout(() => setAnnounce(''), 6000);
        return () => window.clearTimeout(timer);
    }, [announce]);

    // zh can show the server's own note/disclaimer verbatim; the same fields
    // are Chinese-only in M1, so VI uses the localized UI copy to avoid mixing
    // languages. Counts/dates still come from the payload.
    const preferServerCopy = language === 'zh-CN';
    const vocabulary = profile?.vocabulary ?? null;
    const reading = profile?.skills?.reading ?? null;
    const listening = profile?.skills?.listening ?? null;
    const speaking = profile?.skills?.speaking ?? null;
    const writing = profile?.skills?.writing ?? null;

    const hasEvidence = hasVocabularyEvidence(vocabulary);
    const intervalRaw = vocabulary?.label
        || (vocabulary?.low && vocabulary?.high ? `${vocabulary.low}–${vocabulary.high}` : null)
        || vocabulary?.cefr
        || profile?.composite?.label
        || null;
    const interval = intervalRaw ? intervalLabel(intervalRaw) : null;
    const stale = Boolean(vocabulary?.stale);
    const preliminary = Boolean(profile?.preliminary);
    const sampleSize = profile?.sampleSize ?? 0;
    const disclaimer = (preferServerCopy && profile?.disclaimer?.trim())
        || t('ability.disclaimer.fixed');

    const whenText = (value: number | null | undefined): string => {
        if (!value || !Number.isFinite(value)) return t('ability.time.unknown');
        if (!now) return formatDate(value, { dateStyle: 'medium' });
        const days = Math.floor((now - value) / 86400000);
        if (days <= 0) return t('ability.time.today');
        if (days < 30) return t('ability.time.daysAgo', { count: formatNumber(days) });
        return formatDate(value, { dateStyle: 'medium' });
    };

    const strengthLabel = (skill: AbilitySkillProfile | null): string | null => {
        if (!skill) return null;
        const token = skill.evidenceStrength || skill.validity?.label || skill.precision?.label || null;
        if (!token) return null;
        const key = STRENGTH_KEYS[token];
        return key ? t(key) : token;
    };

    const canDoLevel = profile?.canDo?.level || remoteCanDo?.level || vocabulary?.cefr || null;
    const canDoEntries = useMemo(() => {
        const profileBySkill = profile?.canDo?.bySkill ?? null;
        const profileHasEntries = Boolean(profileBySkill && Object.values(profileBySkill).some(
            (entries) => Array.isArray(entries) && entries.length > 0,
        ));
        // A profile may carry the can-do object with empty arrays while the
        // public fallback still has descriptors; prefer whichever has content.
        const bySkill = (profileHasEntries ? profileBySkill : (remoteCanDo?.bySkill ?? profileBySkill)) ?? null;
        if (!bySkill) return [] as Array<{ skill: string; text: string; basis: string | null; source: string | null }>;
        const order = ['listening', 'reading', 'speaking', 'writing', 'vocabulary'];
        const skills = [...order, ...Object.keys(bySkill).filter((skill) => !order.includes(skill))];
        const seen = new Set<string>();
        const rows: Array<{ skill: string; text: string; basis: string | null; source: string | null }> = [];
        const push = (skill: string, entries: AbilityCanDoEntry[]): boolean => {
            for (const entry of entries) {
                const text = canDoText(entry).replace(/[（(]通用描述[)）]\s*$/, '').trim();
                if (!text || seen.has(text)) continue;
                seen.add(text);
                rows.push({
                    skill,
                    text,
                    basis: canDoBasis(entry),
                    source: canDoSource(entry),
                });
                return true;
            }
            return false;
        };
        // One descriptor per skill first, so the four skills are all represented
        // before a second item from any single skill takes a slot.
        for (const skill of skills) {
            const entries = bySkill[skill];
            if (Array.isArray(entries) && entries.length > 0) {
                push(skill, entries);
                if (rows.length >= 6) return rows;
            }
        }
        for (const skill of skills) {
            const entries = bySkill[skill];
            if (!Array.isArray(entries) || entries.length === 0) continue;
            const rowCount = rows.length;
            push(skill, entries.slice(1));
            if (rows.length === rowCount) continue;
            if (rows.length >= 6) return rows;
        }
        return rows;
    }, [profile, remoteCanDo]);

    const basisLabel = (token: string | null): string | null => {
        if (!token) return null;
        if (token === 'cefr-aligned') return t('ability.cando.basis.cefr');
        if (token === 'product-operational') return t('ability.cando.basis.product');
        return token;
    };

    const skillLabel = (skill: string): string => {
        const key = SKILL_LABEL_KEYS[skill];
        return key ? t(key) : skill;
    };

    const sourceLabel = (token: string | null): string | null => {
        if (!token) return null;
        const key = SOURCE_KEYS[token];
        if (key) return t(key);
        // An unknown machine token would only leak an internal id; a
        // human-readable source sentence is safe to show as-is.
        return /^[a-z0-9_.-]+$/i.test(token) ? null : token;
    };

    const selfReportBand = writing?.selfReport?.band ?? writing?.band ?? null;
    const selfReportCaveat = (preferServerCopy && writing?.selfReport?.caveat?.trim())
        || t('ability.skill.writing.caveat');

    const evidence = useMemo<AbilityEvidence[]>(() => {
        const fromServer = Array.isArray(profile?.evidence) ? profile.evidence : [];
        if (fromServer.length > 0) {
            // The self-report has its own highlighted row in the drawer; drop the
            // duplicate evidence row so the band is shown exactly once.
            return fromServer
                .filter((item) => !(selfReportBand && item.type === 'self_assess'))
                .slice(0, 6);
        }
        const synthesized: AbilityEvidence[] = [];
        if (vocabulary && hasVocabularyEvidence(vocabulary)) {
            synthesized.push({
                id: 'vocabulary-summary',
                skill: 'vocabulary',
                type: 'placement_answer',
                observedAt: vocabulary.lastEvidenceAt ?? null,
                band: interval,
            });
        }
        if (reading && String(reading.status) === 'insufficient' && (reading.items ?? 0) > 0) {
            synthesized.push({
                id: 'reading-summary',
                skill: 'reading',
                type: 'placement_answer',
                observedAt: reading.lastEvidenceAt ?? vocabulary?.lastEvidenceAt ?? null,
                band: reading.items
                    ? t('ability.skill.reading.itemsShort', { count: formatNumber(reading.items) })
                    : t('ability.badge.insufficient'),
            });
        }
        return synthesized;
    }, [profile, vocabulary, reading, interval, selfReportBand, t, formatNumber]);

    const canDoNote = (preferServerCopy && profile?.canDo?.note?.trim())
        || t('ability.cando.note');

    const assessItems = useMemo(
        () => resolveSelfAssessItems(profile, language),
        [profile, language],
    );

    const handleSubmitted = (next: AbilityProfile | null) => {
        if (next) setProfile(next);
        setNow(Date.now());
        setAssessOpen(false);
        setAnnounce(t('ability.assess.success'));
        setReloadNonce((prev) => prev + 1);
    };

    const renderSkillCard = (options: {
        skill: AbilitySkillKey;
        title: string;
        status: string;
        note: string | null;
        extra?: ReactNode;
        className?: string;
    }) => {
        const meta = skillStatusMeta(options.status);
        return (
            <div
                key={options.skill}
                data-testid={`ability-skill-${options.skill}`}
                data-status={options.status}
                className={`${SUB_CARD} p-4 min-w-0 ${options.className ?? ''}`}
            >
                <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                        {options.skill === 'listening' && <Ear className="w-4 h-4 text-zinc-500 shrink-0" />}
                        {options.skill === 'reading' && <BookOpen className="w-4 h-4 text-zinc-500 shrink-0" />}
                        {options.skill === 'speaking' && <Mic className="w-4 h-4 text-zinc-500 shrink-0" />}
                        {options.skill === 'writing' && <PenLine className="w-4 h-4 text-zinc-500 shrink-0" />}
                        <h3 className="text-sm font-medium text-zinc-200 break-words">{options.title}</h3>
                    </div>
                    <span
                        data-testid={`ability-skill-${options.skill}-badge`}
                        className={`shrink-0 inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full border ${meta.chipClass}`}
                    >
                        {t(meta.labelKey)}
                    </span>
                </div>
                {options.note && (
                    <p className="mt-2 text-xs leading-relaxed text-zinc-500 break-words">{options.note}</p>
                )}
                {options.extra}
            </div>
        );
    };

    const readingItems = reading?.items ?? 0;
    const readingStatus = String(reading?.status || 'not_measured');
    const readingNote = readingItems > 0
        ? ((preferServerCopy && reading?.note?.trim()) || t('ability.skill.reading.generic'))
        : t('ability.skill.reading.notMeasuredNote');
    const writingBand = selfReportBand;
    // The backend keeps writing at `self_report` even before any self-report
    // exists (band null). Until evidence arrives, "未测" is the honest label.
    const writingStatus = String(writing?.status || 'not_measured') === 'self_report' && !writingBand
        ? 'not_measured'
        : String(writing?.status || 'not_measured');
    const writingNote = writingBand
        ? ((preferServerCopy && writing?.note?.trim()) || t('ability.skill.writing.note'))
        : t('ability.skill.writing.notMeasuredNote');

    const metaParts: string[] = [];
    const strength = strengthLabel(vocabulary);
    if (strength) metaParts.push(t('ability.strengthLine', { strength }));
    if (vocabulary?.evidenceCount) {
        metaParts.push(t('ability.evidenceCount', { count: formatNumber(vocabulary.evidenceCount) }));
    }
    if (vocabulary?.lastEvidenceAt) {
        metaParts.push(t('ability.lastEvidence', { when: whenText(vocabulary.lastEvidenceAt) }));
    }

    const header = (
        <SubHeader
            title={t('ability.title')}
            onBack={onClose}
            parentLabel={parentLabel}
            meta={t('ability.eyebrow')}
            backTestId="ability-back"
            titleTestId="ability-title"
        />
    );

    const body = (
        <>
            <p className="text-xs leading-relaxed text-fg-muted break-words">
                {t('ability.subtitle')}
            </p>
            {stale && (
                <div
                    data-testid="ability-stale"
                    className="flex items-start gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs leading-relaxed text-amber-200"
                >
                    <Clock3 className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                    <p className="break-words">
                        {t('ability.stale', { when: whenText(vocabulary?.lastEvidenceAt) })}
                    </p>
                </div>
            )}

            {preliminary && (
                <div
                    data-testid="ability-preliminary"
                    className="flex items-start gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs leading-relaxed text-amber-200"
                >
                    <Info className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                    <p className="break-words">
                        {t('ability.preliminary', { count: formatNumber(sampleSize) })}
                    </p>
                </div>
            )}

            {hasEvidence ? (
                <section data-testid="ability-summary" className={`${CARD} p-5 sm:p-7`}>
                    <p className="text-[11px] font-medium text-zinc-500">
                        {t('ability.support.title')}
                    </p>
                    <p
                        data-testid="ability-interval"
                        className="mt-1 text-5xl sm:text-6xl font-semibold tracking-tight text-zinc-50 tabular-nums break-words"
                    >
                        {interval ?? '—'}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span
                            data-testid="ability-uncalibrated-badge"
                            className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 text-[11px] font-medium text-blue-300"
                        >
                            <Gauge className="w-3 h-3" />
                            {t('ability.badge.uncalibrated')}
                        </span>
                        {metaParts.length > 0 && (
                            <span
                                data-testid="ability-meta"
                                className="text-[11px] font-medium text-zinc-500 break-words"
                            >
                                {metaParts.join(' · ')}
                            </span>
                        )}
                    </div>
                    <p className="mt-3 text-xs leading-relaxed text-zinc-400 break-words">
                        {(preferServerCopy && vocabulary?.note?.trim()) || t('ability.support.note', {
                            count: formatNumber(vocabulary?.evidenceCount ?? 0),
                        })}
                    </p>
                    {vocabulary?.estimate && (vocabulary.estimate.low != null || vocabulary.estimate.high != null) && (
                        <p
                            data-testid="ability-vocab-estimate"
                            className="mt-2 text-xs leading-relaxed text-zinc-500 break-words"
                        >
                            {t('ability.vocabEstimate', {
                                low: formatNumber(vocabulary.estimate.low ?? 0),
                                high: formatNumber(vocabulary.estimate.high ?? 0),
                            })}
                        </p>
                    )}
                    <p className="mt-3 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-zinc-500 break-words">
                        {disclaimer}
                    </p>
                </section>
            ) : (
                <section
                    data-testid="ability-empty"
                    className={`${CARD} flex flex-col items-center p-8 text-center`}
                >
                    <Gauge className="w-10 h-10 text-zinc-700 mb-3" />
                    <h2 className="text-sm font-medium text-zinc-300">{t('ability.empty.title')}</h2>
                    <p className="mt-1 max-w-sm text-xs leading-relaxed text-zinc-500">
                        {t('ability.empty.hint')}
                    </p>
                    <button
                        type="button"
                        data-testid="ability-empty-cta"
                        onClick={onOpenPlacement}
                        className={`${PRIMARY_BUTTON} mt-5`}
                    >
                        <Sparkles className="w-4 h-4" />
                        {t('ability.empty.action')}
                    </button>
                    <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
                        {t('ability.empty.selfAssessHint')}
                    </p>
                </section>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
                <section
                    data-testid="ability-group-input"
                    className={`${CARD} p-4 sm:p-5`}
                >
                    <div className="flex flex-col gap-0.5">
                        <h2 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                            {t('ability.input.title')}
                        </h2>
                        <span className="text-[11px] leading-relaxed text-zinc-500">
                            {t('ability.input.subtitle')}
                        </span>
                    </div>
                    <div className="mt-3 space-y-3">
                        {renderSkillCard({
                            skill: 'listening',
                            title: t('ability.skill.listening'),
                            status: String(listening?.status || 'not_measured'),
                            note: (preferServerCopy && listening?.note?.trim()) || t('ability.skill.listening.note'),
                            extra: (
                                <span className="mt-2 inline-flex items-center rounded-full border border-white/5 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                                    {t('ability.skill.m3')}
                                </span>
                            ),
                        })}
                        {renderSkillCard({
                            skill: 'reading',
                            title: t('ability.skill.reading'),
                            status: readingStatus,
                            note: readingNote,
                            extra: (
                                <>
                                    {readingItems > 0 && (
                                        <p
                                            data-testid="ability-skill-reading-items"
                                            className="mt-2 text-[11px] font-medium text-zinc-400 tabular-nums"
                                        >
                                            {t('ability.skill.reading.count', {
                                                count: formatNumber(readingItems),
                                            })}
                                        </p>
                                    )}
                                    {readingStatus === 'insufficient' && readingItems > 0 && (
                                        <details className="group mt-2">
                                            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-blue-300 hover:text-blue-200 transition-colors [&::-webkit-details-marker]:hidden">
                                                <ChevronRight className="w-3 h-3 transition-transform duration-200 group-open:rotate-90" />
                                                {t('ability.skill.reading.why')}
                                            </summary>
                                            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500 break-words">
                                                {t('ability.skill.reading.explain')}
                                            </p>
                                        </details>
                                    )}
                                    <span className="mt-2 inline-flex items-center rounded-full border border-white/5 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                                        {t('ability.skill.reading.next')}
                                    </span>
                                </>
                            ),
                        })}
                    </div>
                </section>

                <section
                    data-testid="ability-group-output"
                    className={`${CARD} p-4 sm:p-5`}
                >
                    <div className="flex flex-col gap-0.5">
                        <h2 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                            {t('ability.output.title')}
                        </h2>
                        <span className="text-[11px] leading-relaxed text-zinc-500">
                            {t('ability.output.subtitle')}
                        </span>
                    </div>
                    <div className="mt-3 space-y-3">
                        {renderSkillCard({
                            skill: 'speaking',
                            title: t('ability.skill.speaking'),
                            status: String(speaking?.status || 'not_measured'),
                            note: (preferServerCopy && speaking?.note?.trim()) || t('ability.skill.speaking.note'),
                            extra: (
                                <span className="mt-2 inline-flex items-center rounded-full border border-white/5 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                                    {t('ability.skill.m3')}
                                </span>
                            ),
                        })}
                        {renderSkillCard({
                            skill: 'writing',
                            title: t('ability.skill.writing'),
                            status: writingStatus,
                            note: writingNote,
                            extra: (
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                    {writingBand && (
                                        <span
                                            data-testid="ability-writing-band"
                                            className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300"
                                        >
                                            {t('ability.skill.writing.bandLabel')} {writingBand}
                                        </span>
                                    )}
                                    {writingBand && (
                                        <span className="text-[11px] leading-relaxed text-zinc-500">
                                            {selfReportCaveat || t('ability.skill.writing.caveat')}
                                        </span>
                                    )}
                                </div>
                            ),
                        })}
                    </div>
                </section>
            </div>

            {canDoLevel && canDoEntries.length > 0 && (
                <section data-testid="ability-cando" className={`${CARD} p-5 sm:p-6`}>
                    <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
                        <h2 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                            {t('ability.cando.title')}
                            <span className="ml-2 text-sm font-medium text-zinc-400">{canDoLevel}</span>
                        </h2>
                        <p className="text-[11px] leading-relaxed text-zinc-500">
                            {t('ability.cando.subtitle', { level: canDoLevel })}
                        </p>
                    </div>
                    <ul className="mt-3 space-y-2.5">
                        {canDoEntries.map((row, index) => {
                            const basis = basisLabel(row.basis);
                            const isTested = row.skill === 'vocabulary' && hasEvidence;
                            return (
                                <li
                                    key={`${row.skill}-${index}`}
                                    data-testid="ability-cando-item"
                                    data-skill={row.skill}
                                    className="flex items-start gap-2.5"
                                >
                                    <span className="mt-0.5 shrink-0 rounded-full border border-white/5 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
                                        {skillLabel(row.skill)}
                                    </span>
                                    <div className="min-w-0">
                                        <p className="text-sm leading-relaxed text-zinc-300 break-words">{row.text}</p>
                                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-zinc-500">
                                            {basis && (
                                                <span className="inline-flex items-center rounded-full border border-white/5 bg-zinc-800/60 px-1.5 py-0.5">
                                                    {basis}
                                                </span>
                                            )}
                                            {isTested && vocabulary?.evidenceCount ? (
                                                <span data-testid="ability-cando-basis">
                                                    {t('ability.cando.evidence', {
                                                        count: formatNumber(vocabulary.evidenceCount),
                                                    })}
                                                </span>
                                            ) : (
                                                !isTested && (
                                                    <span data-testid="ability-cando-generic">
                                                        {t('ability.cando.generic')}
                                                    </span>
                                                )
                                            )}
                                            {!basis && !isTested && (
                                                <span>{t('ability.cando.basis.cefr')}</span>
                                            )}
                                            {sourceLabel(row.source) && (
                                                <span>
                                                    {t('ability.cando.basis.source', {
                                                        source: sourceLabel(row.source) ?? '',
                                                    })}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                    <p className="mt-3 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-zinc-500 break-words">
                        {canDoNote}
                    </p>
                </section>
            )}

        </>
    );

    // Desktop side rail (docs/设计-桌面布局规范.md §6): the page's actions and
    // the footnote. The action set only exists once the profile is ready, same
    // visibility contract as before; the mobile single column stacks it after
    // the main column at the same place the buttons used to sit.
    const rail = (
        <SideRail testId="ability-rail">
            {phase === 'ready' && (
                <section
                    data-testid="ability-actions"
                    className="rounded-panel border border-line-subtle bg-surface/40 p-4 sm:p-5"
                >
                    <div className="flex flex-col gap-2">
                        {hasEvidence ? (
                            <button
                                type="button"
                                data-testid="ability-retest"
                                onClick={onOpenPlacement}
                                className={`${SECONDARY_BUTTON} h-10 w-full`}
                            >
                                <RotateCcw className="w-4 h-4" />
                                {t('ability.actions.retest')}
                            </button>
                        ) : null}
                        <button
                            type="button"
                            data-testid="ability-self-assess"
                            onClick={() => setAssessOpen(true)}
                            className={`${PRIMARY_BUTTON} w-full`}
                        >
                            <SquarePen className="w-4 h-4" />
                            {t('ability.actions.assess')}
                        </button>
                        {(evidence.length > 0 || selfReportBand) && (
                            <button
                                type="button"
                                data-testid="ability-evidence"
                                onClick={() => setEvidenceOpen(true)}
                                className={`${GHOST_BUTTON} h-10 w-full`}
                            >
                                {t('ability.actions.evidence')}
                            </button>
                        )}
                    </div>
                </section>
            )}
            <p className="text-micro leading-relaxed text-fg-disabled break-words">
                {t('ability.disclaimer.footer')}
            </p>
        </SideRail>
    );

    return (
        <div
            data-testid="ability-screen"
            data-phase={phase}
            className="flex-1 min-h-0 flex flex-col overflow-hidden bg-[#09090b]"
        >
            {header}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
            <PageContainer variant="standard" className="py-4 sm:py-8">
                <PageGrid testId="ability-grid" railTestId="ability-rail-slot" rail={rail}>
                    <div className="flex flex-col gap-4 sm:gap-6">
                <div
                    aria-live="polite"
                    data-testid="ability-announce"
                    className={announce ? 'rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-200' : 'sr-only'}
                >
                    {announce}
                </div>

                {phase === 'loading' && (
                    <div className={`${CARD} flex items-center gap-3 p-6`} data-testid="ability-loading">
                        <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0" />
                        <p className="text-sm text-zinc-400">{t('ability.loading')}</p>
                    </div>
                )}

                {phase === 'error' && (
                    <div className={`${CARD} p-5`} data-testid="ability-error">
                        <div className="flex items-start gap-2">
                            <ShieldQuestion className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                            <div className="min-w-0">
                                <p className="text-sm text-amber-200">{t('ability.error.title')}</p>
                                <p className="mt-1 text-xs text-zinc-500 break-words">{error}</p>
                            </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                            <button
                                type="button"
                                data-testid="ability-retry"
                                onClick={() => setReloadNonce((prev) => prev + 1)}
                                className={SECONDARY_BUTTON}
                            >
                                <RotateCcw className="w-4 h-4" />
                                {t('common.retry')}
                            </button>
                            <button type="button" onClick={onOpenPlacement} className={GHOST_BUTTON}>
                                {t('ability.empty.action')}
                            </button>
                        </div>
                    </div>
                )}

                {phase === 'ready' && body}
                    </div>
                </PageGrid>
            </PageContainer>
            </div>

            {assessOpen && (
                <SelfAssessSheet
                    items={assessItems}
                    onClose={() => setAssessOpen(false)}
                    onSubmitted={handleSubmitted}
                />
            )}

            {evidenceOpen && (
                <EvidenceDrawer
                    evidence={evidence}
                    selfReportBand={selfReportBand}
                    selfReportCaveat={selfReportCaveat}
                    onClose={() => setEvidenceOpen(false)}
                />
            )}
        </div>
    );
}
