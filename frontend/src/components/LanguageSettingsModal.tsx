import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Languages, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { LanguageCode, LanguageMeta } from '../i18n';

interface LanguageSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

interface SegmentedLanguageProps {
    label: string;
    value: LanguageCode;
    options: readonly LanguageMeta[];
    layoutId: string;
    testId: string;
    optionTestIdPrefix: string;
    onChange: (code: LanguageCode) => void;
}

/**
 * Segmented control recipe from docs/设计语言.md: zinc track, sliding white
 * thumb, one option per language. Native name + BCP-47 code fit side by side
 * on a 375px screen without truncating.
 */
function LanguageSegmented({
    label,
    value,
    options,
    layoutId,
    testId,
    optionTestIdPrefix,
    onChange,
}: SegmentedLanguageProps) {
    return (
        <div
            role="radiogroup"
            aria-label={label}
            data-testid={testId}
            className="inline-flex w-full items-center rounded-lg bg-zinc-800/80 p-0.5 border border-white/5"
        >
            {options.map((option) => {
                const isSelected = option.code === value;
                return (
                    <button
                        key={option.code}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        data-testid={`${optionTestIdPrefix}-${option.code}`}
                        onClick={() => onChange(option.code)}
                        className={`relative flex-1 min-w-0 px-2.5 py-2 rounded-md text-left transition-colors ${
                            isSelected ? 'text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                    >
                        {isSelected && (
                            <motion.span
                                layoutId={layoutId}
                                className="absolute inset-0 bg-zinc-100 rounded-md shadow-sm"
                                transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                            />
                        )}
                        <span className="relative z-10 block min-w-0">
                            <span className="block text-xs font-medium truncate">{option.nativeName}</span>
                            <span
                                className={`block text-[11px] mt-0.5 tabular-nums truncate ${
                                    isSelected ? 'text-zinc-600' : 'text-zinc-500'
                                }`}
                            >
                                {option.code}
                            </span>
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

/**
 * Language settings dialog: two independent switches — interface language and
 * translation target language. Everything applies immediately (no Save
 * button), matching the existing auth tabs and episode pickers.
 *
 * Switching the target language only changes what future translations use;
 * `App` aborts any in-flight stream, leaves the current video and toasts the
 * cost-protection hint. No API learning request is fired from here.
 */
export const LanguageSettingsModal: React.FC<LanguageSettingsModalProps> = ({ isOpen, onClose }) => {
    const { t, language, setLanguage, targetLang, setTargetLang, languages } = useI18n();

    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    // Portal to <body>: the trigger lives in the top bar, whose backdrop-blur
    // creates a containing block for `position: fixed` descendants. Without the
    // portal the dialog would be centred inside the 64px bar, not the viewport.
    return createPortal(
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div
                className="absolute inset-0 bg-zinc-950/70 backdrop-blur-md animate-[fadeIn_0.25s_ease-out]"
                onClick={onClose}
            />

            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="language-settings-title"
                data-testid="language-settings-modal"
                className="relative w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto custom-scrollbar bg-zinc-900/90 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl shadow-black/60 animate-[slideUp_0.32s_cubic-bezier(0.25,1,0.5,1)]"
            >
                <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-white/5">
                    <div className="min-w-0">
                        <h2
                            id="language-settings-title"
                            className="text-xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2"
                        >
                            <Languages className="w-5 h-5 text-blue-400 shrink-0" />
                            <span className="truncate">{t('language.settingsTitle')}</span>
                        </h2>
                        <p className="text-sm text-zinc-400 mt-0.5 leading-relaxed">
                            {t('language.settingsSubtitle')}
                        </p>
                    </div>
                    <button
                        type="button"
                        data-testid="language-settings-close"
                        onClick={onClose}
                        aria-label={t('common.close')}
                        title={t('common.close')}
                        className="p-2 rounded-full text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors shrink-0"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-6 space-y-6">
                    <section>
                        <div className="flex items-baseline justify-between gap-3">
                            <h3 className="text-[15px] font-semibold tracking-tight text-zinc-100">
                                {t('language.uiSection')}
                            </h3>
                            <span className="text-[11px] font-medium text-zinc-500 tabular-nums shrink-0">
                                {language}
                            </span>
                        </div>
                        <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                            {t('language.uiHint')}
                        </p>
                        <div className="mt-3">
                            <LanguageSegmented
                                label={t('language.uiSection')}
                                value={language}
                                options={languages}
                                layoutId="languageUiThumb"
                                testId="language-ui-options"
                                optionTestIdPrefix="language-option"
                                onChange={setLanguage}
                            />
                        </div>
                    </section>

                    <section>
                        <div className="flex items-baseline justify-between gap-3">
                            <h3 className="text-[15px] font-semibold tracking-tight text-zinc-100">
                                {t('language.targetSection')}
                            </h3>
                            <span className="text-[11px] font-medium text-zinc-500 tabular-nums shrink-0">
                                {targetLang}
                            </span>
                        </div>
                        <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                            {t('language.targetHint')}
                        </p>
                        <div className="mt-3">
                            <LanguageSegmented
                                label={t('language.targetSection')}
                                value={targetLang}
                                options={languages}
                                layoutId="languageTargetThumb"
                                testId="language-target-options"
                                optionTestIdPrefix="target-language-option"
                                onChange={setTargetLang}
                            />
                        </div>
                    </section>

                    <p className="border-t border-white/5 pt-4 text-[11px] text-zinc-500 leading-relaxed">
                        {t('language.independentHint')}
                    </p>
                </div>
            </div>
        </div>,
        document.body,
    );
};
