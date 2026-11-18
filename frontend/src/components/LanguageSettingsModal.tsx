import { Languages } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { LanguageCode } from '../i18n';
import { Dialog } from './ui/Dialog';
import { Segmented } from './ui/Segmented';

interface LanguageSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
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
                        <Segmented
                            options={languages.map((option) => ({
                                value: option.code,
                                label: (
                                    <span className="block min-w-0 text-left">
                                        <span className="block truncate text-caption font-medium">
                                            {option.nativeName}
                                        </span>
                                        <span className="mt-0.5 block truncate text-micro tabular-nums opacity-70">
                                            {option.code}
                                        </span>
                                    </span>
                                ),
                                testId: `language-option-${option.code}`,
                            }))}
                            value={language}
                            onChange={(code) => setLanguage(code as LanguageCode)}
                            layoutId="language"
                            ariaLabel={t('language.yourLanguage')}
                            size="md"
                            fullWidth
                            testId="language-ui-options"
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
