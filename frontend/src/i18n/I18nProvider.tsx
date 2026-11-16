/* eslint-disable react-refresh/only-export-components -- the provider and its hook are one unit by design */
// React binding for the one user-facing language (product: "your language").
//
// A single choice drives both the interface and the translation target:
// Chinese = Chinese UI + Chinese translations, Vietnamese = Vietnamese UI +
// Vietnamese translations. The provider owns the side effects: localStorage
// persistence (including the legacy target-key mirror), `<html lang>`/`dir`,
// the document title and the runtime singletons used by non-component code.
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';
import {
    DEFAULT_LANGUAGE,
    formatDate as formatDateWithLanguage,
    formatMonth as formatMonthWithLanguage,
    formatNumber as formatNumberWithLanguage,
    getLanguageMeta,
    getRuntimeLanguage,
    LANGUAGES,
    loadStoredLanguagePreference,
    saveTargetLang,
    setRuntimeLanguage,
    setRuntimeTargetLang,
    storeLanguage,
    translate,
    type LanguageCode,
    type LanguageMeta,
    type TranslationKey,
    type TranslationParams,
} from './index';

interface I18nContextValue {
    /** The single language preference (UI + translation target). */
    language: LanguageCode;
    setLanguage: (language: LanguageCode) => void;
    /**
     * Translation target. Derived from `language` and kept as a separate field
     * only so existing API call sites can keep reading one obvious name; it can
     * never differ from the UI language.
     */
    targetLang: LanguageCode;
    t: (key: TranslationKey, params?: TranslationParams) => string;
    formatNumber: (value: number) => string;
    formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
    formatMonth: (value: Date | number) => string;
    languages: readonly LanguageMeta[];
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Owns the current language. Mount once, above every screen (including the
 * auth gate) so the login page can switch languages too.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
    // Read localStorage synchronously: the first paint already uses the saved
    // language, so a reload never flashes Chinese before switching. This also
    // runs the one-time migration that reconciles the old, possibly divergent
    // `yt_bilingual_ui_lang` / `yt_bilingual_target_lang` pair (UI wins).
    const [language, setLanguageState] = useState<LanguageCode>(() => {
        const { language: stored } = loadStoredLanguagePreference();
        setRuntimeLanguage(stored);
        setRuntimeTargetLang(stored);
        return stored;
    });

    const setLanguage = useCallback((next: LanguageCode) => {
        const safe = LANGUAGES.some((languageMeta) => languageMeta.code === next)
            ? next
            : DEFAULT_LANGUAGE;
        // Update the runtime copies synchronously so a request fired in the
        // same tick (e.g. a refetch triggered by this switch) already uses the
        // new target language, exactly like the old setTargetLang did.
        setRuntimeLanguage(safe);
        setRuntimeTargetLang(safe);
        setLanguageState((prev) => (prev === safe ? prev : safe));
    }, []);

    // Persist + mirror the single language everywhere: runtime singletons,
    // both localStorage keys (target is a compatibility mirror), `<html lang>`
    // and the document title. Switching therefore updates the interface
    // immediately; no learning request or re-translation is fired here.
    useEffect(() => {
        setRuntimeLanguage(language);
        setRuntimeTargetLang(language);
        storeLanguage(language);
        saveTargetLang(language);

        const meta = getLanguageMeta(language);
        const root = document.documentElement;
        root.lang = meta.htmlLang;
        root.dir = meta.dir;
        document.title = translate(language, 'brand.documentTitle');
    }, [language]);

    const value = useMemo<I18nContextValue>(() => ({
        language,
        setLanguage,
        targetLang: language,
        t: (key, params) => translate(language, key, params),
        formatNumber: (value) => formatNumberWithLanguage(value, language),
        formatDate: (value, options) => formatDateWithLanguage(value, options, language),
        formatMonth: (value) => formatMonthWithLanguage(value, language),
        languages: LANGUAGES,
    }), [language, setLanguage]);

    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
    const context = useContext(I18nContext);
    if (!context) throw new Error('useI18n must be used inside <I18nProvider>');
    return context;
}

/** Current language for modules that read it outside React (exports, toasts). */
export function currentLanguage(): LanguageCode {
    return getRuntimeLanguage();
}
