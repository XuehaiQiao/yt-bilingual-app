import { motion } from 'framer-motion';
import { Languages } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { LanguageCode, LanguageMeta } from '../i18n';
import { Dialog } from './ui/Dialog';

interface LanguageSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

interface LanguageSegmentedProps {
    label: string;
    value: LanguageCode;
    options: readonly LanguageMeta[];
    onChange: (code: LanguageCode) => void;
}

/**
 * Segmented control recipe from docs/设计语言.md: zinc track, sliding white
 * thumb, one option per language. Native name + BCP-47 code fit side by side
 * on a 375px screen without truncating.
 */
function LanguageSegmented({ label, value, options, onChange }: LanguageSegmentedProps) {
    return (
        <div
            role="radiogroup"
            aria-label={label}
            data-testid="language-ui-options"
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
                        data-testid={`language-option-${option.code}`}
                        onClick={() => onChange(option.code)}
                        className={`relative flex-1 min-w-0 px-2.5 py-2 rounded-md text-left transition-colors ${
                            isSelected ? 'text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                    >
                        {isSelected && (
                            <motion.span
                                layoutId="languageThumb"
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
 * Language settings dialog: one choice — "your language" — controls both the
 * interface and the translation target. Everything applies immediately (no
 * Save button), matching the existing auth tabs and episode pickers.
 *
 * Switching the language changes `targetLang` too, so `App` aborts any
 * in-flight stream, leaves the current video and toasts the cost-protection
 * hint. No API learning request is fired from here and nothing is
 * re-translated automatically.
 */
export const LanguageSettingsModal: React.FC<LanguageSettingsModalProps> = ({ isOpen, onClose }) => {
    const { t, language, setLanguage, languages } = useI18n();

    return (
        <Dialog
            open={isOpen}
            onClose={onClose}
            size="sm"
            testId="language-settings-modal"
            title={
                <span className="flex items-center gap-2">
                    <Languages className="h-5 w-5 shrink-0 text-blue-400" aria-hidden="true" />
                    <span className="truncate">{t('language.settingsTitle')}</span>
                </span>
            }
            description={t('language.settingsSubtitle')}
        >
            <div className="space-y-5">
                <section>
                    <div className="flex items-baseline justify-between gap-3">
                        <h3 className="text-[15px] font-semibold tracking-tight text-zinc-100">
                            {t('language.yourLanguage')}
                        </h3>
                        <span className="text-[11px] font-medium text-zinc-500 tabular-nums shrink-0">
                            {language}
                        </span>
                    </div>
                    <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                        {t('language.yourLanguageHint')}
                    </p>
                    <div className="mt-3">
                        <LanguageSegmented
                            label={t('language.yourLanguage')}
                            value={language}
                            options={languages}
                            onChange={setLanguage}
                        />
                    </div>
                </section>

                <p
                    data-testid="language-no-retranslate-hint"
                    className="border-t border-white/5 pt-4 text-[11px] text-zinc-500 leading-relaxed"
                >
                    {t('language.noRetranslateHint')}
                </p>
            </div>
        </Dialog>
    );
};
