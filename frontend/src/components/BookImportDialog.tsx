// "Import a book" dialog (specs/031 local EPUB upload + public-domain links).
//
// Two tabs share one Dialog:
//   - public-domain link: paste Gutenberg / Standard Ebooks URL → preview
//     metadata → import (the backend rejects anything outside the whitelist);
//   - local EPUB:     drag/drop or pick a `.epub` ≤30MB → preview parsed
//     metadata → accept the rights declaration → import into "My books".
// Imported books are stored per account; local files stay private. Errors stay
// inline (`role=alert`) and the chosen file is kept so the user can retry.
import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
    AlertCircle,
    ArrowRight,
    BookOpen,
    BookPlus,
    FileText,
    Globe2,
    Link2,
    Loader2,
    Lock,
    RefreshCw,
    UploadCloud,
    X,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import {
    ImportedBooksApiError,
    LOCAL_EPUB_MAX_BYTES,
    LocalEpubError,
    importPublicDomainBook,
    isEpubFile,
    previewImportedBook,
    previewLocalEpub,
    uploadLocalEpub,
    type ImportPreview,
    type LocalEpubErrorCode,
    type LocalEpubPreview,
} from '../lib/importedBooks';
import { toast } from '../lib/toast';
import { cn } from '../lib/cn';
import { Dialog } from './ui/Dialog';
import { Tabs, tabPanelProps } from './ui/Tabs';

interface BookImportDialogProps {
    open: boolean;
    /** Prefilled link (handover from the article reader or another entry). */
    initialUrl?: string;
    onClose: () => void;
    /**
     * `openAfterImport` is only set by the public-domain link flow, which keeps
     * its original "jump into the book" behavior; a local upload closes onto the
     * refreshed shelf so the new local card is visible (spec 031 §4.1).
     */
    onImported: (bookId: string, options?: { openAfterImport?: boolean }) => void;
    onRequestLogin: () => void;
}

type ImportTab = 'link' | 'upload';
type LocalPhase = 'uploading' | 'parsing' | null;

const LOCAL_ERROR_KEYS: Record<LocalEpubErrorCode, TranslationKey> = {
    notEpub: 'importedBooks.upload.error.notEpub',
    drm: 'importedBooks.upload.error.drm',
    tooLarge: 'importedBooks.upload.error.tooLarge',
    corrupt: 'importedBooks.upload.error.corrupt',
    noChapters: 'importedBooks.upload.error.noChapters',
    unsupportedLanguage: 'importedBooks.upload.error.unsupportedLanguage',
    rateLimited: 'importedBooks.upload.error.rateLimited',
    unauthorized: 'importedBooks.upload.error.unauthorized',
    network: 'importedBooks.upload.error.network',
    cancelled: 'importedBooks.upload.error.failed',
    failed: 'importedBooks.upload.error.failed',
};

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / 1024 ** index;
    return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** Cover thumbnail that falls back to the book glyph when the data URL fails. */
function LocalPreviewCover({ src }: { src: string }) {
    const [failed, setFailed] = useState(false);
    if (failed) return <BookOpen className="h-6 w-6 text-fg-muted" aria-hidden="true" />;
    return (
        <img
            data-testid="local-epub-cover"
            src={src}
            alt=""
            onError={() => setFailed(true)}
            className="h-full w-full object-cover"
        />
    );
}

export function BookImportDialog({
    open,
    initialUrl,
    onClose,
    onImported,
    onRequestLogin,
}: BookImportDialogProps) {
    const { t, formatNumber } = useI18n();
    const [tab, setTab] = useState<ImportTab>('link');
    const [url, setUrl] = useState('');
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [previewing, setPreviewing] = useState(false);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [localFile, setLocalFile] = useState<File | null>(null);
    const [localPreview, setLocalPreview] = useState<LocalEpubPreview | null>(null);
    const [localPhase, setLocalPhase] = useState<LocalPhase>(null);
    const [parsingLocal, setParsingLocal] = useState(false);
    const [localPreviewFailed, setLocalPreviewFailed] = useState(false);
    const [rightsAccepted, setRightsAccepted] = useState(false);
    const [dragging, setDragging] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const previewAbortRef = useRef<AbortController | null>(null);
    const importAbortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!open) return;
        setTab('link');
        setUrl(initialUrl ?? '');
        setPreview(null);
        setPreviewing(false);
        setImporting(false);
        setError(null);
        setLocalFile(null);
        setLocalPreview(null);
        setLocalPhase(null);
        setParsingLocal(false);
        setLocalPreviewFailed(false);
        setRightsAccepted(false);
        setDragging(false);
    }, [open, initialUrl]);

    // Abort in-flight multipart requests when the Dialog closes/unmounts; the
    // rejected promise is ignored by the aborted-signal guards below.
    useEffect(() => {
        if (open) return;
        previewAbortRef.current?.abort();
        importAbortRef.current?.abort();
    }, [open]);

    useEffect(
        () => () => {
            previewAbortRef.current?.abort();
            importAbortRef.current?.abort();
        },
        [],
    );

    const handleFailure = (failure: unknown) => {
        if (failure instanceof ImportedBooksApiError && failure.status === 401) {
            onClose();
            onRequestLogin();
            return;
        }
        if (failure instanceof ImportedBooksApiError) {
            setError(failure.detail);
            return;
        }
        console.error('Book import failed:', failure);
        setError(t('importedBooks.dialog.failed'));
    };

    const handlePreview = async () => {
        const value = url.trim();
        if (!value) {
            setError(t('importedBooks.dialog.urlRequired'));
            return;
        }
        setPreviewing(true);
        setPreview(null);
        setError(null);
        try {
            setPreview(await previewImportedBook(value));
        } catch (failure) {
            handleFailure(failure);
        } finally {
            setPreviewing(false);
        }
    };

    const handleImport = async () => {
        if (!preview) {
            setError(t('importedBooks.dialog.previewFirst'));
            return;
        }
        setImporting(true);
        setError(null);
        try {
            const result = await importPublicDomainBook(url.trim());
            onImported(result.bookId, { openAfterImport: true });
        } catch (failure) {
            handleFailure(failure);
        } finally {
            setImporting(false);
        }
    };

    const startLocalPreview = async (file: File) => {
        previewAbortRef.current?.abort();
        const controller = new AbortController();
        previewAbortRef.current = controller;
        setParsingLocal(true);
        setLocalPhase('uploading');
        setLocalPreviewFailed(false);
        setError(null);
        try {
            const parsed = await previewLocalEpub(file, {
                signal: controller.signal,
                onPhase: (phase) => {
                    if (!controller.signal.aborted) setLocalPhase(phase);
                },
            });
            if (controller.signal.aborted) return;
            setLocalPreview(parsed);
            setLocalPhase(null);
        } catch (failure) {
            if (controller.signal.aborted) return;
            if (failure instanceof LocalEpubError && failure.code === 'cancelled') return;
            if (
                (failure instanceof LocalEpubError && failure.status === 401) ||
                (failure instanceof LocalEpubError && failure.code === 'unauthorized')
            ) {
                onClose();
                onRequestLogin();
                return;
            }
            if (failure instanceof LocalEpubError) {
                setError(t(LOCAL_ERROR_KEYS[failure.code]));
                setLocalPreviewFailed(failure.code !== 'notEpub' && failure.code !== 'tooLarge');
            } else {
                console.error('Local EPUB preview failed:', failure);
                setError(t(LOCAL_ERROR_KEYS.failed));
                setLocalPreviewFailed(true);
            }
            setLocalPreview(null);
        } finally {
            if (!controller.signal.aborted) {
                setParsingLocal(false);
                setLocalPhase(null);
            }
            if (previewAbortRef.current === controller) previewAbortRef.current = null;
        }
    };

    const selectLocalFile = (file: File) => {
        previewAbortRef.current?.abort();
        setLocalFile(file);
        setLocalPreview(null);
        setLocalPreviewFailed(false);
        setRightsAccepted(false);
        setLocalPhase(null);
        setParsingLocal(false);
        setError(null);
        if (!isEpubFile(file)) {
            setError(t('importedBooks.upload.error.notEpub'));
            return;
        }
        if (file.size > LOCAL_EPUB_MAX_BYTES) {
            setError(t('importedBooks.upload.error.tooLarge'));
            return;
        }
        void startLocalPreview(file);
    };

    const clearLocalFile = () => {
        previewAbortRef.current?.abort();
        setLocalFile(null);
        setLocalPreview(null);
        setLocalPreviewFailed(false);
        setRightsAccepted(false);
        setLocalPhase(null);
        setParsingLocal(false);
        setError(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleLocalImport = async () => {
        if (!localPreview) {
            setError(t('importedBooks.dialog.previewFirst'));
            return;
        }
        if (!rightsAccepted) {
            setError(t('importedBooks.upload.rightsRequired'));
            return;
        }
        importAbortRef.current?.abort();
        const controller = new AbortController();
        importAbortRef.current = controller;
        setImporting(true);
        setError(null);
        try {
            const result = await uploadLocalEpub(localPreview.uploadToken, controller.signal);
            if (controller.signal.aborted) return;
            toast.success(t('importedBooks.upload.added'));
            onImported(result.bookId);
        } catch (failure) {
            if (controller.signal.aborted) return;
            if (failure instanceof LocalEpubError && failure.code === 'cancelled') return;
            if (
                (failure instanceof LocalEpubError && failure.status === 401) ||
                (failure instanceof LocalEpubError && failure.code === 'unauthorized')
            ) {
                onClose();
                onRequestLogin();
                return;
            }
            if (failure instanceof LocalEpubError) {
                setError(t(LOCAL_ERROR_KEYS[failure.code]));
            } else {
                console.error('Local EPUB import failed:', failure);
                setError(t(LOCAL_ERROR_KEYS.failed));
            }
        } finally {
            if (!controller.signal.aborted) setImporting(false);
            if (importAbortRef.current === controller) importAbortRef.current = null;
        }
    };

    const tabBusy = previewing || importing || parsingLocal;
    const linkBusy = previewing || importing;
    const uploadBusy = parsingLocal || importing;

    const handleTabChange = (next: string) => {
        if (tabBusy || (next !== 'link' && next !== 'upload') || next === tab) return;
        setError(null);
        setTab(next);
    };

    const onDropFile = (event: DragEvent<HTMLButtonElement>) => {
        event.preventDefault();
        setDragging(false);
        if (uploadBusy) return;
        const file = event.dataTransfer.files?.[0];
        if (file) selectLocalFile(file);
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            size="md"
            sheet
            testId="book-import-dialog"
            loading={tab === 'link' && linkBusy}
            initialFocus={inputRef}
            closeLabel={t('importedBooks.dialog.close')}
            title={
                <span className="flex items-center gap-2">
                    <BookPlus className="h-4 w-4 shrink-0 text-blue-400 sm:h-5 sm:w-5" aria-hidden="true" />
                    <span className="truncate">{t('importedBooks.dialog.title')}</span>
                </span>
            }
            description={t('importedBooks.dialog.subtitle')}
            error={
                error ? (
                    <span data-testid="book-import-error" className="flex items-start gap-2">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 break-words">{error}</span>
                    </span>
                ) : undefined
            }
            footer={
                tab === 'link' ? (
                    <>
                        <button
                            type="button"
                            data-testid="book-import-preview-button"
                            onClick={() => void handlePreview()}
                            disabled={linkBusy}
                            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-white/10 bg-zinc-800/60 px-3 text-[13px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700/60 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {previewing ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : (
                                <Globe2 className="h-4 w-4" aria-hidden="true" />
                            )}
                            {previewing
                                ? t('importedBooks.dialog.previewing')
                                : t('importedBooks.dialog.preview')}
                        </button>
                        <button
                            type="button"
                            data-testid="book-import-confirm"
                            onClick={() => void handleImport()}
                            disabled={linkBusy || !preview}
                            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-blue-500 px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-blue-500/40"
                        >
                            {importing ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : (
                                <BookPlus className="h-4 w-4" aria-hidden="true" />
                            )}
                            {importing
                                ? t('importedBooks.dialog.importing')
                                : t('importedBooks.dialog.confirm')}
                            {!importing && <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />}
                        </button>
                    </>
                ) : (
                    <>
                        <button
                            type="button"
                            data-testid="local-epub-cancel"
                            onClick={() => {
                                previewAbortRef.current?.abort();
                                importAbortRef.current?.abort();
                                onClose();
                            }}
                            className="inline-flex h-9 items-center justify-center rounded-lg border border-line-subtle bg-surface-2/60 px-3.5 text-[13px] font-medium text-fg-strong transition-colors hover:bg-surface-3/60"
                        >
                            {t('importedBooks.upload.cancel')}
                        </button>
                        <button
                            type="button"
                            data-testid="local-epub-confirm"
                            onClick={() => void handleLocalImport()}
                            disabled={!localPreview || !rightsAccepted || uploadBusy}
                            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-brand px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-brand-600 disabled:cursor-not-allowed disabled:bg-brand/40 disabled:opacity-60"
                        >
                            {importing ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : (
                                <BookPlus className="h-4 w-4" aria-hidden="true" />
                            )}
                            {importing
                                ? t('importedBooks.upload.adding')
                                : t('importedBooks.upload.add')}
                        </button>
                    </>
                )
            }
        >
            <div className="space-y-4">
                <Tabs
                    skin="panel"
                    fill
                    items={[
                        {
                            id: 'link',
                            label: t('importedBooks.dialog.tabs.link'),
                            icon: <Link2 className="h-3.5 w-3.5" aria-hidden="true" />,
                            testId: 'book-import-tab-link',
                        },
                        {
                            id: 'upload',
                            label: t('importedBooks.dialog.tabs.upload'),
                            icon: <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />,
                            testId: 'book-import-tab-upload',
                        },
                    ]}
                    value={tab}
                    onChange={handleTabChange}
                    layoutId="book-import-tabs"
                    ariaLabel={t('importedBooks.dialog.title')}
                    idPrefix="book-import"
                    testId="book-import-tabs"
                    className="w-full"
                />

                {tab === 'link' && (
                    <div
                        {...tabPanelProps('book-import', 'link')}
                        className="space-y-4"
                        data-testid="book-import-link-panel"
                    >
                        <div>
                            <label
                                htmlFor="book-import-url"
                                className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-300"
                            >
                                <Link2 className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
                                {t('importedBooks.dialog.urlLabel')}
                            </label>
                            <input
                                id="book-import-url"
                                ref={inputRef}
                                data-testid="book-import-url"
                                type="url"
                                inputMode="url"
                                autoComplete="off"
                                spellCheck={false}
                                value={url}
                                disabled={linkBusy}
                                onChange={(event) => {
                                    setUrl(event.target.value);
                                    setPreview(null);
                                    setError(null);
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !linkBusy) {
                                        event.preventDefault();
                                        void handlePreview();
                                    }
                                }}
                                placeholder={t('importedBooks.dialog.urlPlaceholder')}
                                className="mt-1.5 w-full rounded-xl border border-white/10 bg-zinc-950/70 px-3 py-2.5 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500/40 focus:outline-none focus:ring-1 focus:ring-blue-500/30 disabled:opacity-60"
                            />
                            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-600">
                                {t('importedBooks.dialog.hint')}
                            </p>
                        </div>

                        {preview && (
                            <div
                                data-testid="book-import-preview"
                                className="rounded-xl border border-white/5 bg-zinc-950/40 p-3.5"
                            >
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-300">
                                        <Globe2 className="h-3 w-3" aria-hidden="true" />
                                        {preview.sourceType === 'gutenberg'
                                            ? t('importedBooks.sourceGutenberg')
                                            : t('importedBooks.sourceStandardEbooks')}
                                    </span>
                                    <span className="text-[11px] text-zinc-500">
                                        {t('importedBooks.dialog.chapterCount', {
                                            count: formatNumber(preview.chapterCount),
                                        })}
                                    </span>
                                </div>
                                <h3 className="mt-2 break-words text-[15px] font-semibold leading-snug text-zinc-100">
                                    {preview.title}
                                </h3>
                                {preview.author && (
                                    <p className="mt-0.5 break-words text-[12px] text-zinc-400">
                                        {preview.author}
                                    </p>
                                )}
                                <p className="mt-1 text-[11px] text-zinc-600">
                                    {t('importedBooks.dialog.source', {
                                        source: preview.source.provider,
                                    })}
                                </p>
                            </div>
                        )}
                    </div>
                )}

                {tab === 'upload' && (
                    <div
                        {...tabPanelProps('book-import', 'upload')}
                        className="space-y-3"
                        data-testid="book-import-upload-panel"
                    >
                        <input
                            ref={fileInputRef}
                            data-testid="local-epub-input"
                            type="file"
                            accept=".epub,application/epub+zip"
                            className="hidden"
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                // Reset so re-picking the same file fires again.
                                event.target.value = '';
                                if (file) selectLocalFile(file);
                            }}
                        />

                        {!localFile && (
                            <button
                                type="button"
                                data-testid="local-epub-dropzone"
                                onClick={() => fileInputRef.current?.click()}
                                onDragEnter={(event) => {
                                    event.preventDefault();
                                    if (!uploadBusy) setDragging(true);
                                }}
                                onDragOver={(event) => {
                                    event.preventDefault();
                                    if (!uploadBusy) setDragging(true);
                                }}
                                onDragLeave={(event) => {
                                    if (
                                        event.relatedTarget instanceof Node &&
                                        event.currentTarget.contains(event.relatedTarget)
                                    ) {
                                        return;
                                    }
                                    setDragging(false);
                                }}
                                onDrop={onDropFile}
                                disabled={uploadBusy}
                                className={cn(
                                    'flex w-full flex-col items-center justify-center gap-1 rounded-control border border-dashed px-4 py-8 text-center transition-colors',
                                    dragging
                                        ? 'border-brand/60 bg-brand/10'
                                        : 'border-line-strong bg-surface-2/40 hover:border-brand/40 hover:bg-surface-2/60',
                                    uploadBusy && 'pointer-events-none opacity-60',
                                )}
                            >
                                <UploadCloud
                                    className={cn(
                                        'h-7 w-7',
                                        dragging ? 'text-brand-300' : 'text-fg-muted',
                                    )}
                                    aria-hidden="true"
                                />
                                <span className="mt-1 text-ui font-medium text-fg-strong">
                                    {dragging
                                        ? t('importedBooks.upload.dropActive')
                                        : t('importedBooks.upload.dropHint')}
                                </span>
                                <span className="text-caption text-fg-secondary">
                                    {t('importedBooks.upload.choose')}
                                </span>
                                <span className="text-micro text-fg-muted">
                                    {t('importedBooks.upload.maxSize')}
                                </span>
                            </button>
                        )}

                        {localFile && (
                            <div
                                data-testid="local-epub-file"
                                className="flex items-center gap-3 rounded-control border border-line-subtle bg-surface-2/40 p-3"
                            >
                                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control-lg border border-brand/20 bg-brand/10 text-brand-300">
                                    <FileText className="h-5 w-5" aria-hidden="true" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p
                                        data-testid="local-epub-file-name"
                                        className="truncate text-ui font-medium text-fg-strong"
                                    >
                                        {localFile.name}
                                    </p>
                                    <p className="text-micro tabular-nums text-fg-muted">
                                        {formatBytes(localFile.size)}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    data-testid="local-epub-remove"
                                    onClick={clearLocalFile}
                                    disabled={uploadBusy}
                                    className="inline-flex shrink-0 items-center gap-1 rounded-control px-2 py-1 text-micro font-medium text-fg-secondary transition-colors hover:bg-state-hover hover:text-fg-primary disabled:pointer-events-none disabled:opacity-40"
                                >
                                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                                    {t('importedBooks.upload.remove')}
                                </button>
                            </div>
                        )}

                        {parsingLocal && (
                            <div
                                data-testid="local-epub-progress"
                                role="status"
                                aria-live="polite"
                                className="flex items-center gap-2 rounded-control border border-brand/20 bg-brand/10 px-3 py-2 text-caption text-brand-300"
                            >
                                <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                                {localPhase === 'uploading'
                                    ? t('importedBooks.upload.uploading')
                                    : t('importedBooks.upload.parsing')}
                            </div>
                        )}

                        {localFile && !localPreview && !parsingLocal && localPreviewFailed && (
                            <button
                                type="button"
                                data-testid="local-epub-retry"
                                onClick={() => void startLocalPreview(localFile)}
                                className="inline-flex h-8 items-center gap-1.5 rounded-control border border-line-subtle bg-surface-2/60 px-2.5 text-micro font-medium text-fg-strong transition-colors hover:bg-surface-3/60"
                            >
                                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                                {t('importedBooks.upload.retryPreview')}
                            </button>
                        )}

                        {localPreview && (
                            <div
                                data-testid="local-epub-preview"
                                className="rounded-control border border-line-subtle bg-surface-2/40 p-3.5"
                            >
                                <div className="flex items-start gap-3">
                                    <span className="flex h-24 w-16 shrink-0 items-center justify-center overflow-hidden rounded-control border border-line-subtle bg-surface-2">
                                        {localPreview.coverDataUrl ? (
                                            <LocalPreviewCover
                                                key={localPreview.coverDataUrl}
                                                src={localPreview.coverDataUrl}
                                            />
                                        ) : (
                                            <BookOpen
                                                className="h-6 w-6 text-fg-muted"
                                                aria-hidden="true"
                                            />
                                        )}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <h3 className="break-words text-ui font-semibold leading-snug text-fg-primary">
                                            {localPreview.title}
                                        </h3>
                                        {localPreview.author && (
                                            <p className="mt-0.5 break-words text-caption text-fg-secondary">
                                                {localPreview.author}
                                            </p>
                                        )}
                                        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-micro text-fg-muted">
                                            <span>
                                                {t('importedBooks.dialog.chapterCount', {
                                                    count: formatNumber(localPreview.chapterCount),
                                                })}
                                            </span>
                                            <span>
                                                {t('importedBooks.upload.size', {
                                                    size: formatBytes(localPreview.sizeBytes),
                                                })}
                                            </span>
                                            <span>
                                                {t('importedBooks.upload.language', {
                                                    language: localPreview.language.toUpperCase(),
                                                })}
                                            </span>
                                        </div>
                                        <p className="mt-1.5 flex items-center gap-1 text-micro text-emerald-400/90">
                                            <Lock className="h-3 w-3" aria-hidden="true" />
                                            {t('importedBooks.upload.private')}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {localPreview && (
                            <label
                                data-testid="local-epub-rights-label"
                                className={cn(
                                    'flex cursor-pointer items-start gap-2.5 rounded-control border p-3 transition-colors',
                                    rightsAccepted
                                        ? 'border-brand/30 bg-brand/[0.08]'
                                        : 'border-line-subtle bg-surface-2/30',
                                    uploadBusy && 'pointer-events-none opacity-60',
                                )}
                            >
                                <input
                                    type="checkbox"
                                    data-testid="local-epub-rights"
                                    checked={rightsAccepted}
                                    disabled={uploadBusy}
                                    onChange={(event) => setRightsAccepted(event.target.checked)}
                                    className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
                                />
                                <span className="min-w-0">
                                    <span className="block text-caption font-medium leading-relaxed text-fg-strong">
                                        {t('importedBooks.upload.rights')}
                                    </span>
                                    <span className="mt-0.5 block text-micro leading-relaxed text-fg-muted">
                                        {t('importedBooks.upload.rightsHint')}
                                    </span>
                                </span>
                            </label>
                        )}

                        {!localFile && (
                            <p className="text-micro leading-relaxed text-fg-muted">
                                {t('importedBooks.upload.rightsHint')}
                            </p>
                        )}
                    </div>
                )}
            </div>
        </Dialog>
    );
}
