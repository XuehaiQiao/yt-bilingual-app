// Reusable pre-flight estimate flow (home link input + content discovery).
//
// Both entry points must behave exactly the same: fetch
// `/api/estimate-cost?url=…`, show the existing confirmation dialog, and only
// then hand the URL to the processing pipeline. Extracting the flow keeps the
// discovery view from re-implementing the dialog or drifting from home.
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useI18n } from '../i18n/I18nProvider';
import { ModelSelectionModal, type EstimationData } from './ModelSelectionModal';
import { useModel } from '../lib/model';

export interface EstimateDialogHandle {
    /** Fetch the estimate for `url`; if that fails, start processing anyway. */
    estimate: (url: string) => void;
}

interface EstimateDialogProps {
    /** Current global model id. Defaults to the shared ModelProvider value. */
    currentModelId?: string;
    /** Called when the user confirms (or when the estimate request fails). */
    onStart: (url: string) => void;
}

export const EstimateDialog = forwardRef<EstimateDialogHandle, EstimateDialogProps>(
    function EstimateDialog({ currentModelId: currentModelIdProp, onStart }, ref) {
        const { t } = useI18n();
        const { modelId: providerModelId } = useModel();
        const currentModelId = currentModelIdProp || providerModelId;
        const [isEstimating, setIsEstimating] = useState(false);
        const [estimationData, setEstimationData] = useState<EstimationData | null>(null);
        const [isModalOpen, setIsModalOpen] = useState(false);
        const pendingUrlRef = useRef('');
        // A slower earlier request must never replace a newer estimate.
        const requestIdRef = useRef(0);
        // A rapid double click must not turn into two estimate requests (and,
        // if one fails, an accidental immediate start).
        const busyRef = useRef(false);

        const estimate = useCallback(async (targetUrl: string) => {
            if (busyRef.current) return;
            busyRef.current = true;
            const requestId = requestIdRef.current + 1;
            requestIdRef.current = requestId;
            pendingUrlRef.current = targetUrl;
            setIsModalOpen(false);
            setIsEstimating(true);
            try {
                const response = await apiFetch(`/api/estimate-cost?url=${encodeURIComponent(targetUrl)}`);
                if (!response.ok) {
                    throw new Error('Failed to estimate cost');
                }
                const data = (await response.json()) as EstimationData;
                if (requestId !== requestIdRef.current) return;
                setEstimationData(data);
                setIsModalOpen(true);
            } catch (err) {
                if (requestId !== requestIdRef.current) return;
                // Same fallback as the original home flow: a failed estimate
                // must not block starting the video.
                console.error('Estimation failed:', err);
                onStart(pendingUrlRef.current);
            } finally {
                busyRef.current = false;
                if (requestId === requestIdRef.current) setIsEstimating(false);
            }
        }, [onStart]);

        useImperativeHandle(ref, () => ({
            estimate: (url: string) => {
                void estimate(url);
            },
        }), [estimate]);

        const handleConfirm = () => {
            const targetUrl = pendingUrlRef.current;
            setIsModalOpen(false);
            onStart(targetUrl);
        };

        return (
            <>
                <AnimatePresence>
                    {isEstimating && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="fixed inset-0 z-50 bg-zinc-950/70 backdrop-blur-md flex flex-col items-center justify-center"
                        >
                            <Loader2 className="w-12 h-12 text-zinc-300 animate-spin mb-6" />
                            <h2 className="text-xl font-semibold tracking-tight text-zinc-100 mb-2">
                                {t('home.analyzing')}
                            </h2>
                            <p className="text-zinc-400">{t('home.analyzingHint')}</p>
                        </motion.div>
                    )}
                </AnimatePresence>

                <ModelSelectionModal
                    isOpen={isModalOpen}
                    onClose={() => setIsModalOpen(false)}
                    onConfirm={handleConfirm}
                    estimationData={estimationData}
                    currentModelId={currentModelId}
                />
            </>
        );
    },
);
