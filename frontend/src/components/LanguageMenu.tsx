import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Globe } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';

interface LanguageMenuProps {
    /** Which edge the dropdown anchors to. */
    align?: 'left' | 'right';
    /** Extra classes for the trigger button (each surface has its own height). */
    buttonClassName?: string;
}

/**
 * UI language picker. One shared component for the top bar and the login page:
 * a globe button + a two-row dropdown built from the existing popover recipe
 * (ModelBar). Switching only changes the interface language — it never touches
 * the translation pipeline or reloads the page.
 */
export const LanguageMenu: React.FC<LanguageMenuProps> = ({ align = 'right', buttonClassName }) => {
    const { language, setLanguage, t, languages } = useI18n();
    const [isOpen, setIsOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsOpen(false);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [isOpen]);

    const current = languages.find((item) => item.code === language) ?? languages[0];

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                data-testid="language-menu-button"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-label={t('language.buttonAria')}
                title={t('language.buttonAria')}
                onClick={() => setIsOpen((open) => !open)}
                className={buttonClassName ?? 'inline-flex items-center gap-2 h-9 px-2.5 sm:px-3 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 hover:border-white/10 text-zinc-300 hover:text-zinc-100 transition-[background-color,border-color,color] duration-200 ease-apple'}
            >
                <Globe className="w-4 h-4 shrink-0" />
                <span
                    data-testid="language-menu-current"
                    className="hidden sm:inline text-sm font-medium whitespace-nowrap"
                >
                    {current.nativeName}
                </span>
                <ChevronDown
                    className={`hidden sm:block w-3.5 h-3.5 text-zinc-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                />
            </button>

            {isOpen && (
                <div
                    role="menu"
                    data-testid="language-menu"
                    aria-label={t('language.menuTitle')}
                    className={`absolute top-full mt-2 w-56 max-w-[calc(100vw-2rem)] rounded-2xl bg-zinc-900/90 backdrop-blur-2xl border border-white/10 shadow-2xl shadow-black/60 p-2 z-40 animate-[fadeIn_0.15s_ease-out] ${align === 'right' ? 'right-0' : 'left-0'}`}
                >
                    <div className="px-2.5 pt-1.5 pb-2">
                        <p className="text-[11px] font-medium text-zinc-500">{t('language.menuTitle')}</p>
                    </div>
                    <div className="flex flex-col gap-1">
                        {languages.map((item) => {
                            const isSelected = item.code === language;
                            return (
                                <button
                                    key={item.code}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={isSelected}
                                    data-testid={`language-option-${item.code}`}
                                    onClick={() => {
                                        setLanguage(item.code);
                                        setIsOpen(false);
                                    }}
                                    className={`w-full text-left p-2.5 rounded-xl border flex items-center gap-3 transition-colors ${
                                        isSelected
                                            ? 'border-blue-500/40 bg-blue-500/10'
                                            : 'border-white/5 bg-zinc-800/30 hover:bg-zinc-800/60 hover:border-white/10'
                                    }`}
                                >
                                    <span
                                        className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                                            isSelected ? 'border-blue-500 bg-blue-500 text-white' : 'border-zinc-600'
                                        }`}
                                    >
                                        {isSelected && <Check className="w-3 h-3" strokeWidth={3} />}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-medium text-zinc-100">{item.nativeName}</span>
                                        <span className="block text-[11px] text-zinc-500 mt-0.5">{item.englishName}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};
