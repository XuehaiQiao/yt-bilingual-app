import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cpu, KeyRound, Loader2 } from 'lucide-react';
import { useModel } from '../lib/model';
import { useI18n } from '../i18n/I18nProvider';

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
 */
export const ModelBar: React.FC<ModelBarProps> = ({ onModelResolved, compact = false }) => {
    const { t } = useI18n();
    const { modelId, models, loading, error, selectModel, reload } = useModel();
    const [isOpen, setIsOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const onModelResolvedRef = useRef(onModelResolved);
    onModelResolvedRef.current = onModelResolved;

    useEffect(() => {
        if (modelId) onModelResolvedRef.current?.(modelId);
    }, [modelId]);

    // Close on outside pointer-down or Escape, like every other lightweight
    // popover in the app.
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

    const selectedModel = models.find(m => m.id === modelId) || null;

    return (
        <div ref={rootRef} className="relative min-w-0">
            <button
                type="button"
                data-testid="model-bar"
                data-compact={compact ? 'true' : 'false'}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-label={t('model.switchAria')}
                onClick={() => setIsOpen(open => !open)}
                className={`inline-flex items-center gap-2 h-9 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 hover:border-white/10 text-zinc-300 transition-[background-color,border-color,color] duration-200 ease-apple min-w-0 ${
                    compact ? 'pl-2.5 pr-2' : 'pl-3 pr-2.5 rounded-full'
                }`}
            >
                <Cpu className="w-4 h-4 text-blue-400 shrink-0" />
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
                        className={`w-3.5 h-3.5 text-zinc-500 transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-180' : ''}`}
                    />
                )}
            </button>

            {isOpen && (
                <div
                    role="menu"
                    data-testid="model-bar-menu"
                    className="absolute right-0 top-full mt-2 w-[19rem] max-w-[calc(100vw-3rem)] rounded-2xl bg-zinc-900/90 backdrop-blur-2xl border border-white/10 shadow-2xl shadow-black/60 p-2 z-40 animate-[fadeIn_0.15s_ease-out]"
                >
                    <div className="px-2.5 pt-1.5 pb-2">
                        <p className="text-[11px] font-medium text-zinc-500">{t('model.menuTitle')}</p>
                    </div>

                    {error ? (
                        <button
                            type="button"
                            onClick={reload}
                            className="w-full p-3 rounded-xl bg-zinc-800/30 hover:bg-zinc-800/60 border border-white/5 text-left text-xs text-zinc-400 transition-colors"
                        >
                            {t('model.loadFailed')}
                            <span className="block mt-1 text-zinc-600">{error}</span>
                        </button>
                    ) : (
                        <div className="flex flex-col gap-1">
                            {models.map(model => {
                                const isSelected = model.id === modelId;
                                return (
                                    <button
                                        key={model.id}
                                        type="button"
                                        role="menuitemradio"
                                        aria-checked={isSelected}
                                        data-testid={`model-option-${model.id}`}
                                        data-available={model.available ? 'true' : 'false'}
                                        disabled={!model.available}
                                        onClick={() => {
                                            if (!model.available) return;
                                            selectModel(model.id);
                                            onModelResolvedRef.current?.(model.id);
                                            setIsOpen(false);
                                        }}
                                        className={`relative w-full text-left p-3 rounded-xl border flex items-start gap-3 transition-[background-color,border-color,opacity] duration-200 ${
                                            isSelected
                                                ? 'border-blue-500/40 bg-blue-500/10'
                                                : 'border-white/5 bg-zinc-800/30 hover:bg-zinc-800/60 hover:border-white/10'
                                        } ${model.available ? 'cursor-pointer' : 'opacity-45 cursor-not-allowed'}`}
                                    >
                                        <span
                                            className={`mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                                                isSelected
                                                    ? 'border-blue-500 bg-blue-500 text-white'
                                                    : 'border-zinc-600'
                                            }`}
                                        >
                                            {isSelected && <Check className="w-3 h-3" strokeWidth={3} />}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-center justify-between gap-2">
                                                <span className="text-sm font-medium text-zinc-100 truncate">{model.name}</span>
                                                <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-zinc-800 border border-white/5 text-zinc-400 shrink-0">
                                                    {model.provider}
                                                </span>
                                            </span>
                                            <span className={`block text-xs mt-0.5 ${model.available ? 'text-zinc-500' : 'text-amber-400/90'}`}>
                                                {!model.available && <KeyRound className="inline w-3 h-3 mr-1 -mt-0.5" />}
                                                {model.quotaInfo}
                                            </span>
                                        </span>
                                    </button>
                                );
                            })}
                            {models.length === 0 && !loading && (
                                <p className="px-3 py-4 text-xs text-zinc-500 text-center">{t('model.empty')}</p>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
