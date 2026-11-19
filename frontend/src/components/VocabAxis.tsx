import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { VOCAB_LEVELS, type VocabLevelId } from '../lib/settings';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';

// Labels are CEFR bands (A1–C2) in every UI language; taglines are localized.
const LEVEL_I18N: Record<VocabLevelId, { label: TranslationKey; tagline: TranslationKey }> = {
    liftoff: { label: 'home.vocabLevel.liftoff.label', tagline: 'home.vocabLevel.liftoff.tagline' },
    orbit: { label: 'home.vocabLevel.orbit.label', tagline: 'home.vocabLevel.orbit.tagline' },
    moonwalk: { label: 'home.vocabLevel.moonwalk.label', tagline: 'home.vocabLevel.moonwalk.tagline' },
    interstellar: { label: 'home.vocabLevel.interstellar.label', tagline: 'home.vocabLevel.interstellar.tagline' },
    'deep-space': { label: 'home.vocabLevel.deep-space.label', tagline: 'home.vocabLevel.deep-space.tagline' },
    supernova: { label: 'home.vocabLevel.supernova.label', tagline: 'home.vocabLevel.supernova.tagline' },
};

interface VocabAxisProps {
    value: VocabLevelId;
    onChange: (level: VocabLevelId) => void;
    /** The content page used to own the title; settings renders its own row label. */
    showTitle?: boolean;
}

/**
 * Vocabulary level as six CEFR stops A1 → C2. The axis is a capability band,
 * not progress: neutral gray rail, brand fill up to the current stop, and a
 * brand thumb marking it. No rainbow gradient and no purple glow (tokens.md
 * §2.2); selecting a stop only calls `onChange` — persistence stays with the
 * caller (specs/004).
 */
export const VocabAxis: React.FC<VocabAxisProps> = ({ value, onChange, showTitle = true }) => {
    const { t } = useI18n();
    const reducedMotion = useReducedMotion();
    const index = Math.max(0, VOCAB_LEVELS.findIndex(l => l.id === value));
    const pct = (index / (VOCAB_LEVELS.length - 1)) * 100;
    const selected = VOCAB_LEVELS[index];
    const spring = reducedMotion
        ? { duration: 0 }
        : { type: 'spring' as const, stiffness: 320, damping: 32 };
    const fade = reducedMotion ? { duration: 0 } : { duration: 0.18, ease: 'easeOut' as const };

    return (
        <div
            data-testid="vocab-axis"
            role="group"
            aria-label={t('home.vocabAxisTitle')}
            className="max-w-2xl mx-auto w-full select-none"
        >
            {showTitle && (
                <p className="text-center text-caption font-medium text-fg-secondary mb-3">
                    {t('home.vocabAxisTitle')}
                </p>
            )}

            {/* Track */}
            <div className="relative h-6 mx-3">
                {/* base rail */}
                <div
                    aria-hidden="true"
                    className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[3px] rounded-full bg-surface-3"
                />
                {/* lit portion up to the selected stop */}
                <motion.div
                    aria-hidden="true"
                    className="absolute left-0 top-1/2 -translate-y-1/2 h-[3px] rounded-full bg-brand"
                    initial={false}
                    animate={{ width: `${pct}%` }}
                    transition={spring}
                />
                {/* stops */}
                {VOCAB_LEVELS.map((level, i) => {
                    const left = `${(i / (VOCAB_LEVELS.length - 1)) * 100}%`;
                    const passed = i <= index;
                    return (
                        <button
                            key={level.id}
                            type="button"
                            data-testid={`vocab-axis-dot-${level.label}`}
                            aria-pressed={i === index}
                            aria-label={t(LEVEL_I18N[level.id].label)}
                            onClick={() => onChange(level.id)}
                            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 p-2 group rounded-full"
                            style={{ left }}
                            title={t(LEVEL_I18N[level.id].label)}
                        >
                            <span className={`block w-2 h-2 rounded-full transition-colors duration-200 ${
                                passed ? 'bg-brand-300' : 'bg-surface-3 group-hover:bg-fg-muted'
                            }`} />
                        </button>
                    );
                })}
                {/* brand thumb on the selected stop */}
                <motion.span
                    aria-hidden="true"
                    className="absolute top-1/2 w-5 h-5 rounded-full bg-brand ring-4 ring-brand/15 pointer-events-none"
                    initial={false}
                    animate={{ left: `${pct}%` }}
                    style={{ y: '-50%', x: '-50%' }}
                    transition={spring}
                />
            </div>

            {/* Stop names */}
            <div className="relative h-5 mx-3 mt-1.5">
                {VOCAB_LEVELS.map((level, i) => (
                    <button
                        key={level.id}
                        type="button"
                        data-testid={`vocab-axis-stop-${level.label}`}
                        aria-pressed={i === index}
                        aria-label={t(LEVEL_I18N[level.id].label)}
                        onClick={() => onChange(level.id)}
                        className={`absolute -translate-x-1/2 text-micro font-medium whitespace-nowrap transition-colors duration-200 ${
                            i === index ? 'text-fg-primary' : 'text-fg-muted hover:text-fg-strong'
                        }`}
                        style={{ left: `${(i / (VOCAB_LEVELS.length - 1)) * 100}%` }}
                    >
                        {t(LEVEL_I18N[level.id].label)}
                    </button>
                ))}
            </div>

            {/* Tagline for the selected stop */}
            {/* No fixed height + overflow-hidden: Vietnamese tone marks and a
                wrapped tagline must never be clipped. */}
            <div className="min-h-5 mt-2 text-center">
                <AnimatePresence mode="wait">
                    <motion.p
                        key={selected.id}
                        data-testid="vocab-axis-tagline"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={fade}
                        className="text-caption text-fg-secondary"
                    >
                        {t(LEVEL_I18N[selected.id].tagline)}
                    </motion.p>
                </AnimatePresence>
            </div>
        </div>
    );
};
