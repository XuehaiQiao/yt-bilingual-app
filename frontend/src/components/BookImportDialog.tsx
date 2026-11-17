// "Import a public-domain book" dialog (Gutenberg / Standard Ebooks).
//
// Paste a link → preview metadata + chapter count → confirm import. The backend
// rejects anything outside the two public-domain sources with a readable
// message; this dialog only renders it. Imported books are stored per account.
import { useEffect, useRef, useState } from 'react';
import {
    AlertCircle,
    ArrowRight,
    BookPlus,
    Globe2,
    Link2,
    Loader2,
    X,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import {
    ImportedBooksApiError,
    importPublicDomainBook,
    previewImportedBook,
    type ImportPreview,
} from '../lib/importedBooks';

interface BookImportDialogProps {
    open: boolean;
    /** Prefilled link (handover from the article reader or another entry). */
    initialUrl?: string;
    onClose: () => void;
    onImported: (bookId: string) => void;
    onRequestLogin: () => void;
}

export function BookImportDialog({
    open,
    initialUrl,
    onClose,
    onImported,
    onRequestLogin,
}: BookImportDialogProps) {
    const { t, formatNumber } = useI18n();
    const [url, setUrl] = useState('');
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [previewing, setPreviewing] = useState(false);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        setUrl(initialUrl ?? '');
        setPreview(null);
        setPreviewing(false);
        setImporting(false);
        setError(null);
        const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
        return () => window.cancelAnimationFrame(frame);
    }, [open, initialUrl]);

    useEffect(() => {
        if (!open) return;
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !previewing && !importing) onClose();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [open, previewing, importing, onClose]);

    if (!open) return null;

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
            onImported(result.bookId);
        } catch (failure) {
            handleFailure(failure);
        } finally {
            setImporting(false);
        }
    };

    const busy = previewing || importing;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
            <div
                className="absolute inset-0 bg-zinc-950/70 backdrop-blur-md"
                onClick={() => {
                    if (!busy) onClose();
                }}
            />
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="book-import-title"
                data-testid="book-import-dialog"
                className="relative flex max-h-[calc(100dvh-24px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 shadow-2xl shadow-black/60 backdrop-blur-2xl"
            >
                <div className="flex items-start justify-between gap-3 border-b border-white/5 px-4 py-4 sm:px-5">
                    <div className="min-w-0">
                        <h2
                            id="book-import-title"
                            className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-100 sm:text-lg"
                        >
                            <BookPlus className="h-4 w-4 shrink-0 text-blue-400" />
                            {t('importedBooks.dialog.title')}
                        </h2>
                        <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
                            {t('importedBooks.dialog.subtitle')}
                        </p>
                    </div>
                    <button
                        type="button"
                        data-testid="book-import-close"
                        aria-label={t('importedBooks.dialog.close')}
                        onClick={onClose}
                        disabled={busy}
                        className="shrink-0 rounded-full p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 custom-scrollbar sm:px-5">
                    <div>
                        <label
                            htmlFor="book-import-url"
                            className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-300"
                        >
                            <Link2 className="h-3.5 w-3.5 text-zinc-500" />
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
                            disabled={busy}
                            onChange={(event) => {
                                setUrl(event.target.value);
                                setPreview(null);
                                setError(null);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && !busy) {
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

                    {error && (
                        <div
                            data-testid="book-import-error"
                            role="alert"
                            className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                            <p className="min-w-0 break-words text-[12px] leading-relaxed text-amber-200">
                                {error}
                            </p>
                        </div>
                    )}

                    {preview && (
                        <div
                            data-testid="book-import-preview"
                            className="rounded-xl border border-white/5 bg-zinc-950/40 p-3.5"
                        >
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-300">
                                    <Globe2 className="h-3 w-3" />
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

                <div className="flex flex-col gap-2 border-t border-white/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-end sm:px-5">
                    <button
                        type="button"
                        data-testid="book-import-preview-button"
                        onClick={() => void handlePreview()}
                        disabled={busy}
                        className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-white/10 bg-zinc-800/60 px-3 text-[13px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700/60 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {previewing ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Globe2 className="h-4 w-4" />
                        )}
                        {previewing
                            ? t('importedBooks.dialog.previewing')
                            : t('importedBooks.dialog.preview')}
                    </button>
                    <button
                        type="button"
                        data-testid="book-import-confirm"
                        onClick={() => void handleImport()}
                        disabled={busy || !preview}
                        className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-blue-500 px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-blue-500/40"
                    >
                        {importing ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <BookPlus className="h-4 w-4" />
                        )}
                        {importing
                            ? t('importedBooks.dialog.importing')
                            : t('importedBooks.dialog.confirm')}
                        {!importing && <ArrowRight className="h-3.5 w-3.5" />}
                    </button>
                </div>
            </div>
        </div>
    );
}
