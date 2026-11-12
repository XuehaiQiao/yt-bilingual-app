import React from 'react';
import { X, Cpu, DollarSign, Info, CheckCircle2, AlertTriangle } from 'lucide-react';

export interface ModelOption {
    id: string;
    name: string;
    provider: string;
    estimatedCost: number | null;
    available: boolean;
    quotaInfo: string;
}

export interface EstimationData {
    videoId: string;
    metadata: any;
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
    if (!isOpen || !estimationData) return null;

    const currentModel = estimationData.models.find(m => m.id === currentModelId) || null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
                className="absolute inset-0 bg-zinc-950/70 backdrop-blur-md animate-[fadeIn_0.25s_ease-out]"
                onClick={onClose}
            />

            <div
                data-testid="estimate-modal"
                className="relative bg-zinc-900/90 backdrop-blur-2xl rounded-2xl w-full max-w-2xl border border-white/10 shadow-2xl shadow-black/60 flex flex-col overflow-hidden animate-[slideUp_0.32s_cubic-bezier(0.25,1,0.5,1)]"
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-5 border-b border-white/5">
                    <div>
                        <h2 className="text-xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
                            <Cpu className="w-5 h-5 text-blue-400" />
                            Confirm & Start
                        </h2>
                        <p className="text-sm text-zinc-400 mt-0.5">
                            Uses the model selected in the global model bar — the estimate is for the whole video
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-full text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 space-y-6 flex-1 overflow-y-auto custom-scrollbar">

                    {/* Video Stats */}
                    <div className="bg-zinc-800/30 rounded-xl p-4 border border-white/5">
                        <div className="flex gap-4">
                            <div className="w-32 aspect-video bg-zinc-900 rounded-lg overflow-hidden shrink-0 border border-white/5">
                                {estimationData.metadata?.thumbnail ? (
                                    <img src={estimationData.metadata.thumbnail} className="w-full h-full object-cover" alt="thumbnail" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-xs text-zinc-500">No thumbnail</div>
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <h3 className="text-zinc-100 font-medium truncate mb-1">{estimationData.metadata?.title || 'Unknown video'}</h3>
                                <p className="text-sm text-zinc-400 truncate mb-3">{estimationData.metadata?.channel || 'Unknown channel'}</p>

                                <div className="flex items-center gap-4 text-xs font-medium bg-zinc-900/50 p-2 rounded-lg inline-flex border border-white/5">
                                    <span className="text-zinc-500">Words:  <span className="text-zinc-100 tabular-nums ml-1">{estimationData.transcriptStats.wordCount.toLocaleString()}</span></span>
                                    <span className="text-zinc-500">Est. tokens:  <span className="text-zinc-100 tabular-nums ml-1">~{(estimationData.transcriptStats.estimatedInputTokens + estimationData.transcriptStats.estimatedOutputTokens).toLocaleString()}</span></span>
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
                                        <span className="text-xs text-zinc-500">使用模型</span>
                                        <span data-testid="estimate-model" className="text-sm font-medium text-zinc-100 truncate">
                                            {currentModel ? currentModel.name : '未选择'}
                                        </span>
                                        {currentModel && (
                                            <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-zinc-800 border border-white/5 text-zinc-400">
                                                {currentModel.provider}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-zinc-500 mt-1">
                                        {currentModel ? currentModel.quotaInfo : '暂时无法确认当前模型。'}
                                    </p>
                                </div>
                            </div>
                            <div className="text-right shrink-0">
                                <p className="text-[11px] text-zinc-500">整片估算</p>
                                <p className="text-sm font-semibold text-zinc-100 tabular-nums flex items-center gap-1 justify-end">
                                    <DollarSign className="w-3.5 h-3.5 text-zinc-500" />
                                    <span data-testid="estimate-cost">
                                        {currentModel
                                            ? currentModel.estimatedCost != null
                                                ? currentModel.estimatedCost.toFixed(4)
                                                : '待定'
                                            : '—'}
                                    </span>
                                </p>
                                {currentModel && currentModel.estimatedCost == null && (
                                    <p className="text-[11px] text-zinc-600 mt-0.5">价格未知</p>
                                )}
                            </div>
                        </div>

                        {!currentModel && (
                            <div
                                data-testid="estimate-model-hint"
                                className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-400"
                            >
                                <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                <span>去首页切换模型：打开首页顶部的「模型」栏选择后，所有 AI 功能都会跟随它。</span>
                            </div>
                        )}

                        {currentModel && !currentModel.available && (
                            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-400">
                                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                <span>当前模型未配置 Key，无法用于处理；请到首页「模型」栏换一个可用模型。</span>
                            </div>
                        )}

                        {currentModel && currentModel.available && currentModel.estimatedCost == null && (
                            <div className="mt-3 flex items-start gap-2 rounded-lg border border-white/5 bg-zinc-900/40 px-3 py-2 text-xs leading-relaxed text-zinc-500">
                                <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                <span>这个模型没有可靠单价，费用显示「待定」，不填猜测值。</span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-white/5 flex justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="h-10 px-5 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                    >Cancel</button>
                    <button
                        onClick={onConfirm}
                        className="inline-flex items-center gap-2 h-10 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-all duration-200"
                    >
                        {currentModel?.available !== false && <CheckCircle2 className="w-4 h-4" />}
                        Confirm & Start
                    </button>
                </div>
            </div>
        </div>
    );
};
