/* eslint-disable react-refresh/only-export-components -- the provider and its hook are one unit by design */
// React binding for the UI language. Components read `useI18n()` so a switch
// re-renders every visible string; the provider also owns the side effects:
// localStorage persistence, `<html lang>`/`dir`, the document title and the
// runtime singleton used by non-component code.
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
    DEFAULT_TARGET_LANGUAGE,
    formatDate as formatDateWithLanguage,
    formatMonth as formatMonthWithLanguage,
    formatNumber as formatNumberWithLanguage,
    getLanguageMeta,
    getRuntimeLanguage,
    LANGUAGES,
    loadStoredLanguage,
    loadTargetLang,
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
    language: LanguageCode;
    setLanguage: (language: LanguageCode) => void;
    /** Translation target language — independent from the UI language. */
    targetLang: LanguageCode;
    setTargetLang: (language: LanguageCode) => void;
    t: (key: TranslationKey, params?: TranslationParams) => string;
    formatNumber: (value: number) => string;
    formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
    formatMonth: (value: Date | number) => string;
    languages: readonly LanguageMeta[];
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Owns the current UI language. Mount once, above every screen (including the
 * auth gate) so the login page can switch languages too.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
    // Read localStorage synchronously: the first paint already uses the saved
    // language, so a reload never flashes Chinese before switching.
    const [language, setLanguageState] = useState<LanguageCode>(() => {
        const stored = loadStoredLanguage();
        setRuntimeLanguage(stored);
        return stored;
    });

    // The translation target is its own setting: reading it here (not
    // deriving it from `language`) is what keeps the two switches independent.
    const [targetLang, setTargetLangState] = useState<LanguageCode>(() => {
        const stored = loadTargetLang();
        setRuntimeTargetLang(stored);
        return stored;
    });

    const setLanguage = useCallback((next: LanguageCode) => {
        const safe = LANGUAGES.some((languageMeta) => languageMeta.code === next)
            ? next
            : DEFAULT_LANGUAGE;
        setLanguageState((prev) => (prev === safe ? prev : safe));
    }, []);

    const setTargetLang = useCallback((next: LanguageCode) => {
        const safe = LANGUAGES.some((languageMeta) => languageMeta.code === next)
            ? next
            : DEFAULT_TARGET_LANGUAGE;
        // Update the runtime copy synchronously so a request fired in the same
        // tick (e.g. a refetch triggered by this switch) already uses it.
        setRuntimeTargetLang(safe);
        saveTargetLang(safe);
        setTargetLangState((prev) => (prev === safe ? prev : safe));
    }, []);

    // Keep the runtime singleton in sync even if the module was imported before
    // the provider finished its first render.
    useEffect(() => {
        setRuntimeLanguage(language);
    }, [language]);

    // Persist the target language and mirror it into the runtime singleton.
    // Writing the default on first mount makes "default zh-CN" observable in
    // localStorage as well as in request parameters.
    useEffect(() => {
        setRuntimeTargetLang(targetLang);
        saveTargetLang(targetLang);
    }, [targetLang]);

    // Persist + reflect the language on the document. This is what makes the
    // correct Vietnamese glyphs/line-breaking available without a reload.
    useEffect(() => {
        setRuntimeLanguage(language);
        const meta = getLanguageMeta(language);
        const root = document.documentElement;
        root.lang = meta.htmlLang;
        root.dir = meta.dir;
        document.title = translate(language, 'brand.documentTitle');
        storeLanguage(language);
    }, [language]);

    const value = useMemo<I18nContextValue>(() => ({
        language,
        setLanguage,
        targetLang,
        setTargetLang,
        t: (key, params) => translate(language, key, params),
        formatNumber: (value) => formatNumberWithLanguage(value, language),
        formatDate: (value, options) => formatDateWithLanguage(value, options, language),
        formatMonth: (value) => formatMonthWithLanguage(value, language),
        languages: LANGUAGES,
    }), [language, setLanguage, targetLang, setTargetLang]);

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
