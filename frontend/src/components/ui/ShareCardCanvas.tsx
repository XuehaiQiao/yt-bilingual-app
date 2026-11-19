// Shared share-card canvas preview (A2 components.md §C4 · G21-01).
//
// The share dialog used to own this canvas inline, which kept the one `<canvas>`
// in the app outside `ui/`. Moving just the preview block here makes the
// instance attributable to a shared component without touching the card
// renderer (`lib/shareCard.ts`), its 1080×1440 size, the copy/download actions,
// or any `share-card-*` test id the capture / layout scripts rely on.
//
// The wrapper keeps the original layout (centered, max 52vh) so the dialog
// header/footer and the generated image are pixel-identical to before.
import type { Ref } from 'react';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { CARD_HEIGHT, CARD_WIDTH, type ShareCardMeta } from '../../lib/shareCard';

export type ShareCardCanvasStatus = 'idle' | 'loading' | 'ready' | 'error' | 'empty';

export interface ShareCardCanvasProps {
    /** Attached by the caller; generation still happens in `ShareCardDialog`. */
    canvasRef: Ref<HTMLCanvasElement>;
    status: ShareCardCanvasStatus;
    meta: ShareCardMeta | null;
    /** Already-localized failure text; ignored while `status !== 'error'`. */
    error?: string | null;
    onRetry: () => void;
    /** Accessible name for the generated image. */
    ariaLabel: string;
    /**
     * Retry button recipe supplied by the caller so this block does not fork
     * the dialog's secondary-button styles.
     */
    retryButtonClassName?: string;
}

export function ShareCardCanvas({
    canvasRef,
    status,
    meta,
    error,
    onRetry,
    ariaLabel,
    retryButtonClassName,
}: ShareCardCanvasProps) {
    const { t } = useI18n();
    return (
        <div className="relative mx-auto flex justify-center">
            <canvas
                ref={canvasRef}
                width={CARD_WIDTH}
                height={CARD_HEIGHT}
                data-testid="share-card-preview"
                data-share-state={status}
                data-truncated={meta?.quoteTruncated ? 'true' : 'false'}
                data-translation-truncated={meta?.translationTruncated ? 'true' : 'false'}
                data-lines={meta?.quoteLines ?? 0}
                role="img"
                aria-label={ariaLabel}
                className="block h-auto w-auto max-w-full rounded-xl border border-white/10 bg-zinc-950 shadow-2xl shadow-black/50"
                style={{ maxHeight: '52vh' }}
            />

            {status === 'loading' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-xl bg-zinc-950/55 backdrop-blur-[2px]">
                    <Loader2 className="w-6 h-6 text-zinc-400 animate-spin" />
                    <p className="text-xs text-zinc-400">{t('share.generating')}</p>
                </div>
            )}

            {(status === 'error' || status === 'empty') && (
                <div
                    data-testid="share-card-error"
                    role="alert"
                    className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-xl bg-zinc-950/80 px-5 text-center backdrop-blur-[2px]"
                >
                    <AlertCircle className="w-6 h-6 text-amber-400" />
                    <p className="text-sm leading-relaxed text-zinc-300">
                        {status === 'empty' ? t('share.error.empty') : (error ?? t('share.error.generate'))}
                    </p>
                    {status === 'error' && (
                        <button type="button" data-testid="share-card-retry" onClick={onRetry} className={retryButtonClassName}>
                            <RefreshCw className="w-4 h-4" />
                            {t('common.retry')}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
