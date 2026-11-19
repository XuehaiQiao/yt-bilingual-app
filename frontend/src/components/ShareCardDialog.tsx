// Share card dialog (计划 D-6 · 分享卡 P1).
//
// One dialog for all share entry points: favorites, sentence packs and the
// reader. It paints the same 1080×1440 canvas the user downloads, then offers
// "download PNG" / "copy text". Everything is local: no request is made here,
// so the card works for guests and offline (after the app shell has loaded).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Loader2, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { toast } from '../lib/toast';
import {
    buildShareText,
    canvasToPngBlob,
    copyShareText,
    downloadBlob,
    drawShareCard,
    shareCardFileName,
    type ShareCardData,
    type ShareCardKind,
    type ShareCardMeta,
} from '../lib/shareCard';
import { Dialog } from './ui/Dialog';
import { ShareCardCanvas, type ShareCardCanvasStatus } from './ui/ShareCardCanvas';

const KIND_LABEL: Record<ShareCardKind, TranslationKey> = {
    sentence: 'share.label.sentence',
    vocabulary: 'share.label.vocabulary',
    article: 'share.label.article',
    selection: 'share.label.selection',
};

interface ShareCardDialogProps {
    isOpen: boolean;
    /** Null while closed; kept mounted briefly so the exit animation can run. */
    data: ShareCardData | null;
    onClose: () => void;
}

const primaryButton =
    'inline-flex items-center justify-center gap-2 h-10 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-200 disabled:opacity-50 disabled:active:scale-100';
const secondaryButton =
    'inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50';

/** Give system fonts a brief chance to settle without ever hanging the dialog. */
async function waitForFonts(): Promise<void> {
    if (typeof document === 'undefined' || !document.fonts) return;
    await Promise.race([
        document.fonts.ready,
        new Promise<void>((resolve) => window.setTimeout(resolve, 400)),
    ]);
}

export const ShareCardDialog: React.FC<ShareCardDialogProps> = ({ isOpen, data, onClose }) => {
    const { t } = useI18n();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    // The shared Dialog portals its children in after `open` flips true (one
    // render later), so the canvas is not in the tree when the first effect
    // runs. Track the actual mount and retry generation once it appears.
    const [canvasMounted, setCanvasMounted] = useState(false);
    const setCanvasRef = useCallback((node: HTMLCanvasElement | null) => {
        canvasRef.current = node;
        setCanvasMounted(Boolean(node));
    }, []);
    const [status, setStatus] = useState<ShareCardCanvasStatus>('idle');
    const [meta, setMeta] = useState<ShareCardMeta | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [busy, setBusy] = useState<'download' | 'copy' | null>(null);
    // Keep the last payload while the overlay animates out; parents clear their
    // state (`data = null`) on the same tick they set isOpen=false.
    const [cached, setCached] = useState<ShareCardData | null>(null);

    useEffect(() => {
        if (data) setCached(data);
    }, [data]);

    const active = data ?? cached;
    const open = isOpen && Boolean(data);

    // Resolve the kind label through i18n unless the caller already supplied
    // one (e.g. a specific collection name in the future).
    const drawData = useMemo<ShareCardData | null>(() => {
        if (!data) return null;
        return { ...data, label: data.label ?? t(KIND_LABEL[data.kind]) };
    }, [data, t]);

    const tagline = t('share.tagline');

    // Generate (or regenerate after a retry) whenever the dialog opens with a
    // new payload or the UI language changes the label/tagline.
    useEffect(() => {
        if (!open || !canvasMounted) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        let cancelled = false;

        if (!drawData || (!drawData.text.trim() && !(drawData.word ?? '').trim())) {
            setStatus('empty');
            setMeta(null);
            setError(null);
            return;
        }

        setStatus('loading');
        setError(null);
        setMeta(null);
        (async () => {
            try {
                await waitForFonts();
                if (cancelled) return;
                const next = drawShareCard(canvas, drawData, { tagline });
                if (cancelled) return;
                setMeta(next);
                setStatus(next.empty ? 'empty' : 'ready');
            } catch (err) {
                if (cancelled) return;
                console.error('Share card generation failed:', err);
                setStatus('error');
                setError(t('share.error.generate'));
            }
        })();

        return () => { cancelled = true; };
    }, [open, canvasMounted, drawData, tagline, attempt, t]);

    // Escape, backdrop and the close button all belong to the shared Dialog
    // (A2 C4 / IX-09); this component only cleans up local state on close.
    const close = useCallback(() => {
        setBusy(null);
        onClose();
    }, [onClose]);

    const handleDownload = useCallback(async () => {
        const canvas = canvasRef.current;
        if (!canvas || !active || status !== 'ready' || busy) return;
        setBusy('download');
        try {
            const blob = await canvasToPngBlob(canvas);
            downloadBlob(blob, shareCardFileName(active.kind));
            toast.success(t('share.downloaded'));
        } catch (err) {
            console.error('Share card download failed:', err);
            toast.error(t('share.error.download'));
        } finally {
            setBusy(null);
        }
    }, [active, busy, status, t]);

    const handleCopy = useCallback(async () => {
        if (!active || busy) return;
        setBusy('copy');
        try {
            const text = buildShareText(active, {
                translationLabel: t('share.text.translationLabel'),
                sourceLabel: t('share.text.sourceLabel'),
                footer: t('share.text.footer'),
            });
            const copied = await copyShareText(text);
            if (copied) toast.success(t('share.copied'));
            else toast.error(t('share.error.copy'));
        } catch (err) {
            console.error('Share card copy failed:', err);
            toast.error(t('share.error.copy'));
        } finally {
            setBusy(null);
        }
    }, [active, busy, t]);

    const retry = useCallback(() => {
        setAttempt((value) => value + 1);
    }, []);

    return (
        <Dialog
            open={open}
            onClose={close}
            size="sm"
            showClose={false}
            ariaLabel={t('share.title')}
            testId="share-card-dialog"
        >
            {/* The Dialog already owns the shell; this restores the original
                header/scroll-area/footer layout (including the `share-card-close`
                test id used by scripts/reader-layout-test.mjs). */}
            <div className="-m-6">
                <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line-subtle bg-surface/95 px-6 py-5 backdrop-blur-2xl">
                    <div className="min-w-0">
                        <h2 id="share-card-title" className="text-dialog font-semibold tracking-tight text-fg-primary">
                            {t('share.title')}
                        </h2>
                        <p id="share-card-subtitle" className="mt-1 text-xs leading-relaxed text-fg-secondary">
                            {t('share.subtitle')}
                        </p>
                    </div>
                    <button
                        type="button"
                        data-testid="share-card-close"
                        onClick={close}
                        aria-label={t('common.close')}
                        title={t('common.close')}
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-secondary transition-colors hover:bg-state-hover hover:text-fg-primary"
                    >
                        <X className="w-5 h-5" aria-hidden="true" />
                    </button>
                </div>

                <div className="px-4 py-4 sm:px-6 sm:py-5">
                    <ShareCardCanvas
                        canvasRef={setCanvasRef}
                        status={status}
                        meta={meta}
                        error={error}
                        onRetry={retry}
                        ariaLabel={t('share.previewAlt')}
                        retryButtonClassName={secondaryButton}
                    />
                </div>

                <div className="sticky bottom-0 z-10 flex flex-col-reverse gap-2 border-t border-line-subtle bg-surface/95 px-6 py-4 backdrop-blur-2xl sm:flex-row sm:items-center sm:justify-end">
                    <button
                        type="button"
                        data-testid="share-card-copy"
                        onClick={() => { void handleCopy(); }}
                        disabled={status !== 'ready' || busy !== null}
                        className={secondaryButton}
                    >
                        <Copy className="w-4 h-4" />
                        {t('share.copy')}
                    </button>
                    <button
                        type="button"
                        data-testid="share-card-download"
                        onClick={() => { void handleDownload(); }}
                        disabled={status !== 'ready' || busy !== null}
                        className={primaryButton}
                    >
                        {busy === 'download' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                        {busy === 'download' ? t('share.downloading') : t('share.download')}
                    </button>
                </div>
            </div>
        </Dialog>
    );
};
