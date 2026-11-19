// Persisted visibility for the two inline learning layers:
//   - difficulty: words above the current CEFR stop (amber background)
//   - language points: idiom / fixed-expression / culture spans (underline)
// The explanation layer is the existing sentence translation + word lookup and
// deliberately has no separate switch here.
export const LANGUAGE_POINTS_KEY = 'yt_bilingual_language_points';

export function loadLanguagePointsEnabled(): boolean {
    return localStorage.getItem(LANGUAGE_POINTS_KEY) !== '0';
}

export function saveLanguagePointsEnabled(enabled: boolean) {
    localStorage.setItem(LANGUAGE_POINTS_KEY, enabled ? '1' : '0');
}
