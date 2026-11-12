import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cpu, KeyRound, Loader2 } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { loadModel, saveModel } from '../lib/settings';
import { describeApiError } from '../lib/toast';

/** One entry of GET /api/models — the single catalog the backend owns. */
export interface ModelOption {
    id: string;
    name: string;
    provider: string;
    available: boolean;
    quotaInfo: string;
}

interface ModelsResponse {
    models: ModelOption[];
    default: string;
}

interface ModelBarProps {
    /**
     * Reports the model that is effectively in use after the catalog loads or
     * the user picks another one. The bar itself is the single writer of the
     * `yt_bilingual_last_model` setting, so every call site can just read it
     * with `loadModel()`.
     */
    onModelResolved?: (modelId: string) => void;
}

/**
 * Global model selector: sits just below the top bar on the home screen and
 * drives every LLM interaction (translation, summary, local shows, dictionary).
 */
export const ModelBar: React.FC<ModelBarProps> = ({ onModelResolved }) => {
    const [models, setModels] = useState<ModelOption[]>([]);
    const [selectedId, setSelectedId] = useState<string>(loadModel);
    const [isOpen, setIsOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    // Keep the latest callback without re-running the catalog fetch.
    const onModelResolvedRef = useRef(onModelResolved);
    onModelResolvedRef.current = onModelResolved;

    const applyModel = useCallback((modelId: string) => {
        setSelectedId(modelId);
        saveModel(modelId);
        onModelResolvedRef.current?.(modelId);
    }, []);

    const loadModels = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const res = await apiFetch('/api/models');
            if (!res.ok) throw new Error(await describeApiError(res));
            const data: ModelsResponse = await res.json();
            const catalog = data.models || [];
            setModels(catalog);

            // Respect a saved choice; otherwise fall back to the backend
            // default (then to any usable model if the default has no Key).
            const saved = loadModel();
            const savedIsKnown = catalog.some(m => m.id === saved);
            const fallback =
                catalog.find(m => m.id === data.default && m.available) ||
                catalog.find(m => m.id === data.default) ||
                catalog.find(m => m.available) ||
                catalog[0];
            const effective = savedIsKnown ? saved : fallback?.id;
            if (effective) {
                // Don't persist the backend default: the setting means "the
                // model the user picked", so a never-chosen user keeps
                // following the backend default if it changes.
                setSelectedId(effective);
                onModelResolvedRef.current?.(effective);
            }
        } catch (err) {
            setError(await describeApiError(err));
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadModels();
    }, [loadModels]);

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

    const selectedModel = models.find(m => m.id === selectedId) || null;

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                data-testid="model-bar"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-label="切换全局模型"
                onClick={() => setIsOpen(open => !open)}
                className="inline-flex items-center gap-2 h-9 pl-3 pr-2.5 rounded-full bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 hover:border-white/10 text-zinc-300 transition-[background-color,border-color,color] duration-200 ease-apple"
            >
                <Cpu className="w-4 h-4 text-blue-400" />
                <span className="text-[11px] font-medium text-zinc-500">模型</span>
                <span
                    data-testid="model-bar-name"
                    className="text-sm font-medium text-zinc-100 whitespace-nowrap"
                >
                    {selectedModel
                        ? selectedModel.name
                        : isLoading
                            ? '加载中…'
                            : selectedId || '未选择'}
                </span>
                {isLoading ? (
                    <Loader2 className="w-3.5 h-3.5 text-zinc-500 animate-spin" />
                ) : (
                    <ChevronDown
                        className={`w-3.5 h-3.5 text-zinc-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                    />
                )}
            </button>

            {isOpen && (
                <div
                    role="menu"
                    data-testid="model-bar-menu"
                    className="absolute right-0 top-full mt-2 w-[19rem] max-w-[calc(100vw-3rem)] rounded-2xl bg-zinc-900/90 backdrop-blur-2xl border border-white/10 shadow-2xl shadow-black/60 p-2 z-30 animate-[fadeIn_0.15s_ease-out]"
                >
                    <div className="px-2.5 pt-1.5 pb-2">
                        <p className="text-[11px] font-medium text-zinc-500">全局模型 · 所有 AI 功能跟随</p>
                    </div>

                    {error ? (
                        <button
                            type="button"
                            onClick={() => void loadModels()}
                            className="w-full p-3 rounded-xl bg-zinc-800/30 hover:bg-zinc-800/60 border border-white/5 text-left text-xs text-zinc-400 transition-colors"
                        >
                            模型列表加载失败，点此重试
                            <span className="block mt-1 text-zinc-600">{error}</span>
                        </button>
                    ) : (
                        <div className="flex flex-col gap-1">
                            {models.map(model => {
                                const isSelected = model.id === selectedId;
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
                                            applyModel(model.id);
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
                            {models.length === 0 && !isLoading && (
                                <p className="px-3 py-4 text-xs text-zinc-500 text-center">没有可用模型</p>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
