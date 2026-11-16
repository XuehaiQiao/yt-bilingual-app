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
  /** How to name this language inside a given UI language. */
  displayNames: Record<LanguageCode, string>;
  dir: 'ltr' | 'rtl';
  htmlLang: string;
  /** Locale handed to Intl.NumberFormat / Intl.DateTimeFormat. */
  locale: string;
}

export const DEFAULT_LANGUAGE: LanguageCode = 'zh-CN';

/**
 * localStorage key for the one user-facing language preference.
 *
 * Since the "one language" change this is the single source of truth: the UI
 * language and the translation target are the same choice. The old
 * `yt_bilingual_target_lang` key is kept in sync for migration/rollback only.
 */
export const UI_LANGUAGE_STORAGE_KEY = 'yt_bilingual_ui_lang';

/** Legacy translation-target key; mirrored from the UI language (migration). */
export const TARGET_LANGUAGE_STORAGE_KEY = 'yt_bilingual_target_lang';

/** Translation target language defaults to Simplified Chinese. */
export const DEFAULT_TARGET_LANGUAGE: LanguageCode = 'zh-CN';

export const LANGUAGES: readonly LanguageMeta[] = [
  {
    code: 'zh-CN',
    nativeName: '中文',
    englishName: 'Chinese',
    displayNames: { 'zh-CN': '中文（简体）', 'vi-VN': 'Tiếng Trung (Giản thể)' },
    dir: 'ltr',
    htmlLang: 'zh-CN',
    locale: 'zh-CN',
  },
  {
    code: 'vi-VN',
    nativeName: 'Tiếng Việt',
    englishName: 'Vietnamese',
    displayNames: { 'zh-CN': '越南语', 'vi-VN': 'Tiếng Việt' },
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

/**
 * One-time migration for the old two-setting model (UI language + translation
 * target language stored separately).
 *
 * The product now has a single "your language" choice, so the UI language is
 * the source of truth: when the two legacy keys disagree, keep the UI language
 * and overwrite the target key with it. When no UI value exists yet, fall back
 * to Chinese (the default) and still normalise the target key. The React
 * provider keeps both keys written from then on, so a rollback to an older
 * build finds a consistent pair.
 */
export function loadStoredLanguagePreference(): {
  language: LanguageCode;
  migratedFrom: LanguageCode | null;
} {
  try {
    const rawUi = localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
    const rawTarget = localStorage.getItem(TARGET_LANGUAGE_STORAGE_KEY);
    // `normalizeLanguage(null)` = zh-CN, matching the old default; a invalid
    // stored UI value therefore behaves exactly like a missing one.
    const language = normalizeLanguage(rawUi);
    const target = rawTarget ? normalizeLanguage(rawTarget) : null;
    if (target && target !== language) {
      localStorage.setItem(TARGET_LANGUAGE_STORAGE_KEY, language);
      if (!rawUi) localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
      return { language, migratedFrom: target };
    }
    // Make the single preference observable from the first paint, including
    // upgrade installs that only ever had the target key (or no key at all).
    if (rawTarget !== language) localStorage.setItem(TARGET_LANGUAGE_STORAGE_KEY, language);
    if (!rawUi) localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
    return { language, migratedFrom: null };
  } catch {
    // Private mode / storage disabled: defaults are still fully functional.
    return { language: DEFAULT_LANGUAGE, migratedFrom: null };
  }
}

/**
 * Read the (legacy) translation target language. Invalid or missing values
 * fall back to `zh-CN`. New code should read `targetLang` from `useI18n()`,
 * which is derived from the single language preference.
 */
export function loadTargetLang(): LanguageCode {
  try {
    return normalizeLanguage(localStorage.getItem(TARGET_LANGUAGE_STORAGE_KEY));
  } catch {
    // Private mode / storage disabled: keep translating into Chinese.
    return DEFAULT_TARGET_LANGUAGE;
  }
}

/**
 * Mirror the language into the legacy target key. Kept because `apiFetch` and
 * older builds still read it; UI code never calls this directly.
 */
export function saveTargetLang(code: LanguageCode): void {
  try {
    // Normalize on write too: a bad/legacy value must never persist and then
    // poison the next request.
    localStorage.setItem(TARGET_LANGUAGE_STORAGE_KEY, normalizeLanguage(code));
  } catch {
    // Non-fatal: the in-memory runtime value still drives requests.
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

/**
 * Runtime copy of the translation target language. `apiFetch` reads this on
 * every request so no call site can forget `targetLang`; the provider updates
 * it together with localStorage.
 */
let runtimeTargetLang: LanguageCode = loadTargetLang();

export function getRuntimeTargetLang(): LanguageCode {
  return runtimeTargetLang;
}

export function setRuntimeTargetLang(language: LanguageCode): void {
  runtimeTargetLang = normalizeLanguage(language);
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
