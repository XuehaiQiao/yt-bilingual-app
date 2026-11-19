// Shared inline-layer switch for language points (idioms / fixed expressions /
// culture references). Difficulty highlighting keeps its own ReadingHighlightToggle;
// the two layers are independent and persisted separately.
import { useEffect, useState } from 'react';
import { Underline } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { Switch } from './Switch';
import {
    LANGUAGE_POINTS_KEY,
    loadLanguagePointsEnabled,
    saveLanguagePointsEnabled,
} from '../../lib/highlightLayers';

interface LanguagePointToggleProps {
    enabled?: boolean;
    onChange?: (next: boolean) => void;
    testId: string;
}

export function LanguagePointToggle({ enabled: controlled, onChange, testId }: LanguagePointToggleProps) {
    const { t } = useI18n();
    const [local, setLocal] = useState<boolean>(loadLanguagePointsEnabled);
    const enabled = controlled ?? local;
    const set = (next: boolean) => {
        if (controlled === undefined) setLocal(next);
        saveLanguagePointsEnabled(next);
        onChange?.(next);
    };

    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key === LANGUAGE_POINTS_KEY) setLocal(loadLanguagePointsEnabled());
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    return (
        <label
            data-testid={testId}
            data-enabled={enabled ? '1' : '0'}
            title={t('reading.languagePoints.hint')}
            className={`inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition-colors ${
                enabled
                    ? 'border-sky-400/25 bg-sky-400/10 text-sky-200 hover:bg-sky-400/15'
                    : 'border-white/5 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'
            }`}
        >
            <Underline className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('reading.languagePoints.toggle')}</span>
            <Switch
                checked={enabled}
                onChange={set}
                ariaLabel={t('reading.languagePoints.toggle')}
                tone="brand"
                className="ml-0.5"
            />
        </label>
    );
}
