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
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import {
    ImportedBooksApiError,
    importPublicDomainBook,
    previewImportedBook,
    type ImportPreview,
} from '../lib/importedBooks';
import { Dialog } from './ui/Dialog';

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
    }, [open, initialUrl]);

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
        <Dialog
            open={open}
            onClose={onClose}
            size="md"
            sheet
            testId="book-import-dialog"
            loading={busy}
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
                <>
                    <button
                        type="button"
                        data-testid="book-import-preview-button"
                        onClick={() => void handlePreview()}
                        disabled={busy}
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
                        disabled={busy || !preview}
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
            }
        >
            <div className="space-y-4">
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
        </Dialog>
    );
}
