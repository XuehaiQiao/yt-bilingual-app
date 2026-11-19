import React, { useEffect, useRef } from 'react';
import { ChevronDown, Cpu, KeyRound, Loader2 } from 'lucide-react';
import { useModel } from '../lib/model';
import { useI18n } from '../i18n/I18nProvider';
import { Menu, type MenuItem } from './ui/Menu';

export type { ModelOption } from '../lib/model';

interface ModelBarProps {
    /**
     * Reports the model that is effectively in use after the catalog loads or
     * the user picks another one. Kept for call sites that mirror the value
     * (the estimate dialog now reads the provider directly).
     */
    onModelResolved?: (modelId: string) => void;
    /** Header/Settings chip: no "模型" label, tighter padding. */
    compact?: boolean;
}

/**
 * Global model selector. The catalog + selection live in `ModelProvider`
 * (P0 IA §10.3), so every instance — top bar, profile settings, learning
 * header — shows and writes the same value.
 *
 * The dropdown itself is the shared `ui/Menu`: this file only maps the catalog
 * (and the load-failure retry) to menu items. `selectModel`/`onModelResolved`
 * and the legacy test hooks (`model-bar*`, `model-option-*`) are unchanged.
 */
export const ModelBar: React.FC<ModelBarProps> = ({ onModelResolved, compact = false }) => {
    const { t } = useI18n();
    const { modelId, models, loading, error, selectModel, reload } = useModel();
    const onModelResolvedRef = useRef(onModelResolved);
    useEffect(() => {
        onModelResolvedRef.current = onModelResolved;
    }, [onModelResolved]);

    useEffect(() => {
        if (modelId) onModelResolvedRef.current?.(modelId);
    }, [modelId]);

    const selectedModel = models.find(m => m.id === modelId) || null;

    const items: MenuItem[] = error
        ? [
            {
                id: 'reload',
                label: t('model.loadFailed'),
                description: error,
                // Retry keeps the menu open so a recovered catalog replaces
                // the error row in place, matching the old dropdown.
                keepOpen: true,
                onSelect: reload,
            },
        ]
        : models.map(model => {
            const isSelected = model.id === modelId;
            return {
                id: model.id,
                label: model.name,
                description: (
                    <span className={model.available ? 'text-fg-muted' : 'text-warning-fg'}>
                        {!model.available && (
                            <KeyRound className="mr-1 -mt-0.5 inline h-3 w-3" aria-hidden="true" />
                        )}
                        {model.quotaInfo}
                    </span>
                ),
                meta: (
                    <span className="rounded-full border border-line-subtle bg-surface-2 px-1.5 py-0.5 text-micro font-medium text-fg-secondary">
                        {model.provider}
                    </span>
                ),
                checked: isSelected,
                disabled: !model.available,
                testId: `model-option-${model.id}`,
                data: { 'data-available': model.available ? 'true' : 'false' },
                onSelect: () => {
                    if (!model.available) return;
                    selectModel(model.id);
                    onModelResolvedRef.current?.(model.id);
                },
            };
        });

    return (
        <Menu
            ariaLabel={t('model.switchAria')}
            items={items}
            header={t('model.menuTitle')}
            empty={models.length === 0 && !loading && !error ? t('model.empty') : undefined}
            menuTestId="model-bar-menu"
            popupClassName="w-[19rem]"
            className="min-w-0"
            trigger={({ open, triggerRef, triggerProps }) => (
                <button
                    ref={triggerRef}
                    {...triggerProps}
                    type="button"
                    data-testid="model-bar"
                    data-compact={compact ? 'true' : 'false'}
                    aria-label={t('model.switchAria')}
                    className={`inline-flex items-center gap-2 h-9 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 hover:border-white/10 text-zinc-300 transition-[background-color,border-color,color] duration-200 ease-apple min-w-0 ${
                        compact ? 'pl-2.5 pr-2' : 'pl-3 pr-2.5 rounded-full'
                    }`}
                >
                    <Cpu className="w-4 h-4 text-blue-400 shrink-0" aria-hidden="true" />
                    {!compact && (
                        <span className="text-[11px] font-medium text-zinc-500">{t('model.label')}</span>
                    )}
                    <span
                        data-testid="model-bar-name"
                        className={`text-sm font-medium text-zinc-100 whitespace-nowrap min-w-0 ${
                            compact ? 'max-w-[8ch] xl:max-w-none truncate xl:overflow-visible' : ''
                        }`}
                    >
                        {selectedModel
                            ? selectedModel.name
                            : loading
                                ? t('common.loading')
                                : modelId || t('common.unselected')}
                    </span>
                    {loading ? (
                        <Loader2 className="w-3.5 h-3.5 text-zinc-500 animate-spin shrink-0" />
                    ) : (
                        <ChevronDown
                            className={`w-3.5 h-3.5 text-zinc-500 transition-transform duration-200 shrink-0 ${open ? 'rotate-180' : ''}`}
                        />
                    )}
                </button>
            )}
        />
    );
};
