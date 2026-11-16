import { useState } from 'react';
import { ChevronDown, Globe } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { LanguageSettingsModal } from './LanguageSettingsModal';

/**
 * Language entry point (top bar and login page). A single globe button opens
 * the shared settings dialog, where the user picks "your language" — one
 * choice that drives both the interface and the translation target.
 *
 * Icon-only below `sm` so the top bar still fits at 320–375px; the
 * `aria-label`/`title` carry the full "language settings" name.
 */
interface LanguageMenuProps {
    /** Sidebar collapsed rail: globe only, same dialog and aria name. */
    iconOnly?: boolean;
}

export const LanguageMenu: React.FC<LanguageMenuProps> = ({ iconOnly = false }) => {
    const { language, languages, t } = useI18n();
    const [isOpen, setIsOpen] = useState(false);

    const current = languages.find((item) => item.code === language) ?? languages[0];

    return (
        <>
            <button
                type="button"
                data-testid="language-menu-button"
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                aria-label={t('language.buttonAria')}
                title={t('language.buttonAria')}
                onClick={() => setIsOpen(true)}
                className={`inline-flex items-center h-9 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 hover:border-white/10 text-zinc-300 hover:text-zinc-100 transition-[background-color,border-color,color] duration-200 ease-apple shrink-0 ${
                    iconOnly ? 'w-9 justify-center px-0' : 'gap-2 px-2.5 sm:px-3'
                }`}
            >
                <Globe className="w-4 h-4 shrink-0" />
                {!iconOnly && (
                    <span
                        data-testid="language-menu-current"
                        className="hidden sm:inline text-sm font-medium whitespace-nowrap"
                    >
                        {current.nativeName}
                    </span>
                )}
                {!iconOnly && (
                    <ChevronDown
                        className={`hidden sm:block w-3.5 h-3.5 text-zinc-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                    />
                )}
            </button>

            <LanguageSettingsModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
        </>
    );
};
