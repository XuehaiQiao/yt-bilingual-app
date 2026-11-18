import React from 'react';
import { Cpu, DollarSign, Info, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { Dialog } from './ui/Dialog';

export interface ModelOption {
    id: string;
    name: string;
    provider: string;
    estimatedCost: number | null;
    available: boolean;
    quotaInfo: string;
}

export interface EstimationVideoMetadata {
    title?: string | null;
    channel?: string | null;
    thumbnail?: string | null;
}

export interface EstimationData {
    videoId: string;
    metadata: EstimationVideoMetadata | null;
    transcriptStats: {
        wordCount: number;
        estimatedInputTokens: number;
        estimatedOutputTokens: number;
    };
    models: ModelOption[];
}

interface ModelSelectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Starts processing; the model is read from the global setting, not here. */
    onConfirm: () => void;
    estimationData: EstimationData | null;
    /** Current global model id ('' when the catalog hasn't resolved one). */
    currentModelId: string;
}

/**
 * Pre-flight confirmation for a video. Model choice now lives in the global
 * ModelBar, so this dialog only shows which model will be used and what the
 * whole video is estimated to cost with it — no model list.
 */
export const ModelSelectionModal: React.FC<ModelSelectionModalProps> = ({
    isOpen,
    onClose,
    onConfirm,
    estimationData,
    currentModelId
}) => {
    const { t, formatNumber } = useI18n();
    const currentModel = estimationData?.models.find(m => m.id === currentModelId) || null;

    return (
        <Dialog
            open={isOpen && estimationData !== null}
            onClose={onClose}
            size="md"
            testId="estimate-modal"
            title={
                <span className="flex items-center gap-2">
                    <Cpu className="h-5 w-5 shrink-0 text-blue-400" aria-hidden="true" />
                    <span className="truncate">{t('estimate.title')}</span>
                </span>
            }
            description={t('estimate.subtitle')}
            footer={
                <>
                    <button
                        type="button"
                        onClick={onClose}
                        className="h-10 px-5 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                    >{t('common.cancel')}</button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="inline-flex items-center gap-2 h-10 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-all duration-200"
                    >
                        {currentModel?.available !== false && <CheckCircle2 className="w-4 h-4" />}
                        {t('estimate.confirm')}
                    </button>
                </>
            }
        >
            {estimationData && (
                <div className="space-y-6">

                    {/* Video Stats */}
                    <div className="bg-zinc-800/30 rounded-xl p-4 border border-white/5">
                        <div className="flex gap-4">
                            <div className="w-32 aspect-video bg-zinc-900 rounded-lg overflow-hidden shrink-0 border border-white/5">
                                {estimationData.metadata?.thumbnail ? (
                                    <img src={estimationData.metadata.thumbnail} className="w-full h-full object-cover" alt="thumbnail" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-xs text-zinc-500">{t('common.noThumbnail')}</div>
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <h3 className="text-zinc-100 font-medium truncate mb-1">{estimationData.metadata?.title || t('common.unknownVideo')}</h3>
                                <p className="text-sm text-zinc-400 truncate mb-3">{estimationData.metadata?.channel || t('common.unknownChannel')}</p>

                                <div className="flex items-center gap-4 text-xs font-medium bg-zinc-900/50 p-2 rounded-lg inline-flex border border-white/5">
                                    <span className="text-zinc-500">{t('estimate.words')}  <span className="text-zinc-100 tabular-nums ml-1">{formatNumber(estimationData.transcriptStats.wordCount)}</span></span>
                                    <span className="text-zinc-500">{t('estimate.tokens')}  <span className="text-zinc-100 tabular-nums ml-1">~{formatNumber(estimationData.transcriptStats.estimatedInputTokens + estimationData.transcriptStats.estimatedOutputTokens)}</span></span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Which model will run — chosen globally, not here */}
                    <div className="bg-zinc-800/30 rounded-xl p-4 border border-white/5">
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex items-start gap-3 min-w-0">
                                <div className="w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
                                    <Cpu className="w-4 h-4 text-blue-400" />
                                </div>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-xs text-zinc-500">{t('estimate.modelLabel')}</span>
                                        <span data-testid="estimate-model" className="text-sm font-medium text-zinc-100 truncate">
                                            {currentModel ? currentModel.name : t('common.unselected')}
                                        </span>
                                        {currentModel && (
                                            <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-zinc-800 border border-white/5 text-zinc-400">
                                                {currentModel.provider}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-zinc-500 mt-1">
                                        {currentModel ? currentModel.quotaInfo : t('estimate.quotaUnknown')}
                                    </p>
                                </div>
                            </div>
                            <div className="text-right shrink-0">
                                <p className="text-[11px] text-zinc-500">{t('estimate.total')}</p>
                                <p className="text-sm font-semibold text-zinc-100 tabular-nums flex items-center gap-1 justify-end">
                                    <DollarSign className="w-3.5 h-3.5 text-zinc-500" />
                                    <span data-testid="estimate-cost">
                                        {currentModel
                                            ? currentModel.estimatedCost != null
                                                ? currentModel.estimatedCost.toFixed(4)
                                                : t('estimate.pending')
                                            : '—'}
                                    </span>
                                </p>
                                {currentModel && currentModel.estimatedCost == null && (
                                    <p className="text-[11px] text-zinc-600 mt-0.5">{t('estimate.priceUnknown')}</p>
                                )}
                            </div>
                        </div>

                        {!currentModel && (
                            <div
                                data-testid="estimate-model-hint"
                                className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-400"
                            >
                                <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                <span>{t('estimate.hintSwitch')}</span>
                            </div>
                        )}

                        {currentModel && !currentModel.available && (
                            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-400">
                                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                <span>{t('estimate.hintUnavailable')}</span>
                            </div>
                        )}

                        {currentModel && currentModel.available && currentModel.estimatedCost == null && (
                            <div className="mt-3 flex items-start gap-2 rounded-lg border border-white/5 bg-zinc-900/40 px-3 py-2 text-xs leading-relaxed text-zinc-500">
                                <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                <span>{t('estimate.hintNoPrice')}</span>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </Dialog>
    );
};
