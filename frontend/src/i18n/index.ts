// UI internationalization core (specs/012-i18n-multilingual §5.7).
//
// A static dictionary per BCP-47 language, a flat dot-key namespace shared by
// every language, and a tiny runtime singleton for code that runs outside
// React (toasts, exports, API error fallbacks). The React binding lives in
// `I18nProvider.tsx`; components should read `t` from `useI18n()` so a
// language switch re-renders them.
//
// Extending to a third UI language:
//   1. add `xx-XX.json` with exactly the keys of `zh-CN.json`;
//   2. import it below and add an entry to `dictionaries`;
//   3. add the language to `LANGUAGES` (native name / Intl locale).
// No component changes are required.
import zhCN from './zh-CN.json';
import viVN from './vi-VN.json';

export type LanguageCode = 'zh-CN' | 'vi-VN';

/** Every key is declared by `zh-CN.json`, the structural source of truth. */
export type TranslationKey = keyof typeof zhCN;

export type TranslationParams = Record<string, string | number>;

export interface LanguageMeta {
  /** BCP-47 code used in storage, APIs and `<html lang>`. */
  code: LanguageCode;
  /** Name shown in the language picker, in the language itself. */
  nativeName: string;
  englishName: string;
  dir: 'ltr' | 'rtl';
  htmlLang: string;
  /** Locale handed to Intl.NumberFormat / Intl.DateTimeFormat. */
  locale: string;
}

export const DEFAULT_LANGUAGE: LanguageCode = 'zh-CN';

/** localStorage key for the UI language (never the translation target). */
export const UI_LANGUAGE_STORAGE_KEY = 'yt_bilingual_ui_lang';

export const LANGUAGES: readonly LanguageMeta[] = [
  {
    code: 'zh-CN',
    nativeName: '中文',
    englishName: 'Chinese',
    dir: 'ltr',
    htmlLang: 'zh-CN',
    locale: 'zh-CN',
  },
  {
    code: 'vi-VN',
    nativeName: 'Tiếng Việt',
    englishName: 'Vietnamese',
    dir: 'ltr',
    htmlLang: 'vi-VN',
    locale: 'vi-VN',
  },
];

const dictionaries: Record<LanguageCode, Record<TranslationKey, string>> = {
  'zh-CN': zhCN,
  'vi-VN': viVN,
};

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && LANGUAGES.some((language) => language.code === value);
}

/**
 * Accept a stored value that is a valid language or a plausible BCP-47 variant
 * (e.g. `zh`, `zh_CN`, `vi-VN`); anything else falls back to Chinese.
 */
export function normalizeLanguage(value: string | null | undefined): LanguageCode {
  if (!value) return DEFAULT_LANGUAGE;
  const normalized = value.trim().replace(/_/g, '-').toLowerCase();
  if (!normalized) return DEFAULT_LANGUAGE;
  const exact = LANGUAGES.find((language) => language.code.toLowerCase() === normalized);
  if (exact) return exact.code;
  const base = normalized.split('-')[0];
  const byBase = LANGUAGES.find((language) => language.code.toLowerCase().startsWith(`${base}-`));
  return byBase?.code ?? DEFAULT_LANGUAGE;
}

export function getLanguageMeta(code: LanguageCode): LanguageMeta {
  return LANGUAGES.find((language) => language.code === code) ?? LANGUAGES[0];
}

export function loadStoredLanguage(): LanguageCode {
  try {
    return normalizeLanguage(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY));
  } catch {
    // Private mode / storage disabled: the UI still works with the default.
    return DEFAULT_LANGUAGE;
  }
}

export function storeLanguage(code: LanguageCode): void {
  try {
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, code);
  } catch {
    // Non-fatal: persistence is a convenience, not a requirement.
  }
}

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

const warnedMissingKeys = new Set<string>();

/**
 * Translate `key` into `language`, falling back to Chinese and then to the key
 * itself so a missing translation never renders an empty label. In dev, each
 * missing key warns exactly once.
 */
export function translate(
  language: LanguageCode,
  key: TranslationKey,
  params?: TranslationParams,
): string {
  const translated = dictionaries[language]?.[key];
  if (translated !== undefined) return interpolate(translated, params);

  const fallback = dictionaries[DEFAULT_LANGUAGE][key];
  if (import.meta.env.DEV && !warnedMissingKeys.has(key)) {
    warnedMissingKeys.add(key);
    console.warn(`[i18n] missing ${language} translation for "${key}"; falling back to ${DEFAULT_LANGUAGE}.`);
  }
  if (fallback !== undefined) return interpolate(fallback, params);

  if (import.meta.env.DEV && !warnedMissingKeys.has(`key:${key}`)) {
    warnedMissingKeys.add(`key:${key}`);
    console.warn(`[i18n] unknown key "${key}".`);
  }
  return key;
}

// ── Runtime singleton ─────────────────────────────────────────────────────
// For modules that cannot use React hooks (toast fallbacks, exporters, API
// helpers). `I18nProvider` keeps this in sync with the rendered language.

let runtimeLanguage: LanguageCode = loadStoredLanguage();

export function getRuntimeLanguage(): LanguageCode {
  return runtimeLanguage;
}

export function setRuntimeLanguage(language: LanguageCode): void {
  runtimeLanguage = language;
}

/** Translate with the current runtime language (non-component code). */
export function t(key: TranslationKey, params?: TranslationParams): string {
  return translate(runtimeLanguage, key, params);
}

export function formatNumber(value: number, language: LanguageCode = runtimeLanguage): string {
  return new Intl.NumberFormat(getLanguageMeta(language).locale).format(value);
}

export function formatDate(
  value: Date | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
  language: LanguageCode = runtimeLanguage,
): string {
  return new Intl.DateTimeFormat(getLanguageMeta(language).locale, options).format(value);
}

/** Favorite-group month heading, e.g. 2026年1月 / tháng 1 năm 2026. */
export function formatMonth(value: Date | number, language: LanguageCode = runtimeLanguage): string {
  return formatDate(value, { year: 'numeric', month: 'long' }, language);
}
