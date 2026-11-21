// Saved local videos on the Content page.
//
// Each card is one IndexedDB row: cover frame, file name, last playback
// position and whether a subtitle was remembered. Clicking a card hands the
// row to ContentScreen, which resolves the saved FileSystemFileHandle inside
// the click task (so Chromium can re-prompt for permission) and opens the same
// LocalVideoLearning view as the file picker.
//
// With no rows the shelf renders nothing (the "打开本地视频" action stays); in
// an insecure context it explains that handles cannot be saved instead of
// pretending the feature will work next visit.
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Captions, Film, History, Loader2, Trash2 } from 'lucide-react';
import { CollectionCard } from './ui/CollectionCard';
import { useI18n } from '../i18n/I18nProvider';
import {
    canPersistLocalVideoHandles,
    deleteLocalVideo,
    listLocalVideos,
    LocalVideoLibraryError,
    type LocalVideoLibraryErrorCode,
    type LocalVideoRecord,
} from '../lib/localVideoLibrary';
import { toast } from '../lib/toast';
import { formatClock } from '../lib/time';

interface LocalVideoShelfProps {
    /** Bumped by App after a session closes, so progress/cover edits reload. */
    revision: number;
    onOpen: (record: LocalVideoRecord) => void;
}

export function LocalVideoShelf({ revision, onOpen }: LocalVideoShelfProps) {
    const { t } = useI18n();
    const supportsHandles = canPersistLocalVideoHandles();
    const [records, setRecords] = useState<LocalVideoRecord[]>([]);
    const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [errorCode, setErrorCode] = useState<LocalVideoLibraryErrorCode>('read');
    const [reloadToken, setReloadToken] = useState(0);

    useEffect(() => {
        // Records cannot be used without a handle-capable context; the fallback
        // notice below replaces the shelf, so there is nothing to load.
        if (!supportsHandles) return;
        let cancelled = false;
        listLocalVideos()
            .then((rows) => {
                if (cancelled) return;
                setRecords(rows);
                setState('ready');
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                console.error('Failed to read the local video library:', error);
                setErrorCode(error instanceof LocalVideoLibraryError ? error.code : 'read');
                setState('error');
            });
        return () => { cancelled = true; };
    }, [supportsHandles, revision, reloadToken]);

    const retry = useCallback(() => {
        setState('loading');
        setReloadToken((token) => token + 1);
    }, []);

    const handleDelete = useCallback(async (record: LocalVideoRecord) => {
        try {
            await deleteLocalVideo(record.id);
            setRecords((current) => current.filter((row) => row.id !== record.id));
            toast.success(t('localVideo.deleted', { name: record.name }));
        } catch (error) {
            console.error('Failed to delete a local video record:', error);
            toast.error(t('localVideo.deleteFailed'));
        }
    }, [t]);

    if (!supportsHandles) {
        return (
            <p
                data-testid="local-video-fallback-hint"
                className="mt-4 flex items-start gap-1.5 border-t border-line-subtle pt-3 text-[11px] leading-relaxed text-amber-200/80"
            >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{t('localVideo.fallbackHint')}</span>
            </p>
        );
    }

    const errorText = errorCode === 'unsupported'
        ? t('localVideo.libraryUnsupported')
        : t('localVideo.libraryError');

    return (
        <>
            {state === 'error' && (
                <div
                    data-testid="local-video-library-error"
                    role="alert"
                    className="mt-4 flex flex-wrap items-center gap-2 border-t border-amber-500/15 pt-3 text-[11px] text-amber-200"
                >
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1">{errorText}</span>
                    <button
                        type="button"
                        data-testid="local-video-library-retry"
                        onClick={retry}
                        className="inline-flex h-6 shrink-0 items-center rounded-md border border-white/10 px-2 font-medium text-zinc-300 transition-colors hover:bg-white/5 hover:text-zinc-100"
                    >
                        {t('common.retry')}
                    </button>
                </div>
            )}

            {records.length > 0 && (
                <section
                    data-testid="local-video-shelf"
                    aria-labelledby="local-video-shelf-title"
                    className="mt-4 border-t border-line-subtle pt-3"
                >
                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <h4
                            id="local-video-shelf-title"
                            className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight text-fg-primary"
                        >
                            <History className="h-3.5 w-3.5 text-brand-400" aria-hidden="true" />
                            {t('localVideo.savedTitle')}
                        </h4>
                        <span className="text-[11px] text-fg-muted">{t('localVideo.savedHint')}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-3 xl:grid-cols-4">
                        {records.map((record) => {
                            const hasSubtitle = Boolean(record.subtitleText?.trim() || record.subtitleName);
                            const percent = record.duration > 0
                                ? Math.min(100, Math.max(0, Math.round((record.progress / record.duration) * 100)))
                                : 0;
                            return (
                                <div key={record.id} className="relative min-w-0">
                                    <CollectionCard
                                        testId={`local-video-card-${record.id}`}
                                        ariaLabel={t('localVideo.openSavedAria', { name: record.name })}
                                        onClick={() => onOpen(record)}
                                        visual={(
                                            <>
                                                {record.coverDataUrl ? (
                                                    <img
                                                        src={record.coverDataUrl}
                                                        alt=""
                                                        draggable={false}
                                                        loading="lazy"
                                                        decoding="async"
                                                        data-testid={`local-video-cover-${record.id}`}
                                                        className="absolute inset-0 h-full w-full object-cover"
                                                    />
                                                ) : (
                                                    <Film className="h-8 w-8 text-zinc-600" aria-hidden="true" />
                                                )}
                                                {percent > 0 && (
                                                    <span className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
                                                        <span
                                                            data-testid={`local-video-progress-bar-${record.id}`}
                                                            className="block h-full bg-emerald-500"
                                                            style={{ width: `${percent}%` }}
                                                        />
                                                    </span>
                                                )}
                                            </>
                                        )}
                                        badge={hasSubtitle ? (
                                            <span
                                                data-testid={`local-video-subtitle-badge-${record.id}`}
                                                className="inline-flex items-center gap-0.5 rounded-full border border-blue-500/20 bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-blue-200 backdrop-blur"
                                            >
                                                <Captions className="h-3 w-3" aria-hidden="true" />
                                                {t('localVideo.hasSubtitle')}
                                            </span>
                                        ) : undefined}
                                        title={record.name}
                                        subtitle={hasSubtitle
                                            ? (record.subtitleName || t('localVideo.hasSubtitle'))
                                            : t('localVideo.noSubtitle')}
                                        meta={(
                                            <>
                                                <span
                                                    data-testid={`local-video-progress-${record.id}`}
                                                    className="min-w-0 truncate tabular-nums"
                                                >
                                                    {t('localVideo.lastProgress', { time: formatClock(record.progress) })}
                                                </span>
                                                {record.duration > 0 && (
                                                    <span className="shrink-0 tabular-nums text-fg-muted">{percent}%</span>
                                                )}
                                            </>
                                        )}
                                    />
                                    <button
                                        type="button"
                                        data-testid={`local-video-delete-${record.id}`}
                                        aria-label={t('localVideo.deleteAria', { name: record.name })}
                                        title={t('localVideo.deleteAria', { name: record.name })}
                                        onClick={() => { void handleDelete(record); }}
                                        className="absolute left-4 top-4 z-10 inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-black/70 text-zinc-300 backdrop-blur transition-colors hover:bg-red-500/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </section>
            )}

            {state === 'loading' && records.length === 0 && (
                <p className="mt-4 flex items-center gap-1.5 border-t border-line-subtle pt-3 text-[11px] text-fg-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    {t('common.loading')}
                </p>
            )}
        </>
    );
}

export default LocalVideoShelf;
