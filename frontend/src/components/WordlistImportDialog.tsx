// Three-step import wizard for custom word lists (specs/038-custom-wordlists).
//
// Step 1 — pick a `.csv` / `.tsv` / `.txt` (≤2 MB, ≤5000 rows) by drag/drop or
//           file picker. The file is parsed locally; nothing is uploaded yet.
// Step 2 — preview the first 5 rows, map the columns (word is required;
//           translation / phonetic / CEFR / example are optional), and read the
//           live 「共 N 行 · 有效 M · 跳过 K」 stats with the first 5 skip reasons.
// Step 3 — name the list (same name → automatic `(2)`) and POST the validated
//           entries. Cancelling at any step writes nothing.
//
// Limits and row validation live in `lib/wordlistParse` (pure, reusable by the
// Playwright check); this component owns the File object, the wizard state and
// the localized copy. The shared `Dialog` owns the modal contract.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { AlertCircle, FileSpreadsheet, UploadCloud } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { cn } from '../lib/cn';
import {
    defaultColumnMap,
    defaultWordlistName,
    isWordlistFileName,
    isWordlistSizeAllowed,
    parseWordlistFile,
    uniqueWordlistName,
    validateWordlistRows,
    WORDLIST_CEFR_LEVELS,
    WORDLIST_COLUMN_ROLES,
    WORDLIST_MAX_LISTS,
    WORDLIST_MAX_NAME_LENGTH,
    WORDLIST_MAX_ROWS,
    type ParsedWordlistFile,
    type WordlistColumnMap,
    type WordlistColumnRole,
    type WordlistSkipReason,
} from '../lib/wordlistParse';
import {
    importCustomWordlist,
    WordlistsApiError,
    type CustomWordlist,
} from '../lib/wordlists';
import { toast } from '../lib/toast';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { LevelBadge } from './VocabularyRows';

type Step = 'file' | 'map' | 'confirm';

const STEP_ORDER: readonly Step[] = ['file', 'map', 'confirm'];

const STEP_LABEL_KEYS: Record<Step, TranslationKey> = {
    file: 'vocab.custom.import.step.file',
    map: 'vocab.custom.import.step.map',
    confirm: 'vocab.custom.import.step.confirm',
};

const SKIP_REASON_KEYS: Record<WordlistSkipReason, TranslationKey> = {
    empty: 'vocab.custom.import.skip.empty',
    notEnglish: 'vocab.custom.import.skip.notEnglish',
    tooLong: 'vocab.custom.import.skip.tooLong',
    tooManyWords: 'vocab.custom.import.skip.tooManyWords',
    duplicate: 'vocab.custom.import.skip.duplicate',
};

const COLUMN_LABEL_KEYS: Record<WordlistColumnRole, TranslationKey> = {
    word: 'vocab.custom.import.map.word',
    translation: 'vocab.custom.import.map.translation',
    phonetic: 'vocab.custom.import.map.phonetic',
    cefr: 'vocab.custom.import.map.cefr',
    example: 'vocab.custom.import.map.example',
};

export interface WordlistImportDialogProps {
    open: boolean;
    onClose: () => void;
    /** The screen appends/refreshes the tab and switches to the new list. */
    onImported: (list: CustomWordlist, skipped: number) => void;
    /** Names already used by the account (for the automatic `(2)` suffix). */
    existingNames: readonly string[];
    /** Current number of custom lists (client pre-check for the 10-list cap). */
    listCount: number;
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function WordlistImportDialog({
    open,
    onClose,
    onImported,
    existingNames,
    listCount,
}: WordlistImportDialogProps) {
    const { t, formatNumber } = useI18n();
    const [step, setStep] = useState<Step>('file');
    const [error, setError] = useState<string | null>(null);
    const [parsing, setParsing] = useState(false);
    const [fileName, setFileName] = useState('');
    const [fileSize, setFileSize] = useState(0);
    const [parsed, setParsed] = useState<ParsedWordlistFile | null>(null);
    const [map, setMap] = useState<WordlistColumnMap>({
        word: null,
        translation: null,
        phonetic: null,
        cefr: null,
        example: null,
    });
    const [name, setName] = useState('');
    const [importing, setImporting] = useState(false);
    const [dragging, setDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Every open starts from a clean wizard; closing discards the parsed file
    // (cancel has zero side effects, specs/038 §7).
    useEffect(() => {
        if (!open) return;
        setStep('file');
        setError(null);
        setParsing(false);
        setFileName('');
        setFileSize(0);
        setParsed(null);
        setMap({ word: null, translation: null, phonetic: null, cefr: null, example: null });
        setName('');
        setImporting(false);
        setDragging(false);
    }, [open]);

    // Moving between steps moves focus inside the dialog (the Dialog owns the
    // trap); the file step keeps its own initial focus on the browse button.
    useEffect(() => {
        if (!open || step === 'file') return;
        const selector = step === 'map'
            ? '[data-testid="wordlist-import-map-word"]'
            : '[data-testid="wordlist-import-name"]';
        const timer = window.setTimeout(() => {
            document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
        }, 0);
        return () => window.clearTimeout(timer);
    }, [open, step]);

    const validation = useMemo(
        () => (parsed ? validateWordlistRows(parsed.rows, parsed.lineNumbers, map) : null),
        [parsed, map],
    );

    const finalName = useMemo(
        () => uniqueWordlistName(name, existingNames),
        [name, existingNames],
    );

    const columnCount = parsed?.columnCount ?? 0;

    const columnLabel = useCallback(
        (index: number): string => {
            const header = parsed?.header?.[index]?.trim();
            return header
                ? header
                : t('vocab.custom.import.column', { index: formatNumber(index + 1) });
        },
        [parsed, t, formatNumber],
    );

    const openFilePicker = () => fileInputRef.current?.click();

    const readFile = async (file: File) => {
        setError(null);
        if (!isWordlistFileName(file.name)) {
            setError(t('vocab.custom.import.error.unsupported'));
            return;
        }
        if (!isWordlistSizeAllowed(file.size)) {
            setError(t('vocab.custom.import.error.tooLarge'));
            return;
        }
        setParsing(true);
        try {
            const text = await file.text();
            if (text.includes('\uFFFD')) {
                setError(t('vocab.custom.import.error.encoding'));
                return;
            }
            let next: ParsedWordlistFile;
            try {
                next = parseWordlistFile(text);
            } catch {
                setError(t('vocab.custom.import.error.parse'));
                return;
            }
            if (next.rows.length > WORDLIST_MAX_ROWS) {
                setError(t('vocab.custom.import.error.tooManyRows'));
                return;
            }
            if (next.rows.length === 0) {
                setError(t('vocab.custom.import.error.empty'));
                return;
            }
            setFileName(file.name);
            setFileSize(file.size);
            setParsed(next);
            setMap(defaultColumnMap(next.rows, next.header, next.columnCount));
            const suggested = defaultWordlistName(file.name);
            setName(suggested);
            setStep('map');
        } catch {
            setError(t('vocab.custom.import.error.read'));
        } finally {
            setParsing(false);
        }
    };

    const onInputChange = (fileList: FileList | null) => {
        const file = fileList?.[0];
        if (file) void readFile(file);
        // Reset so picking the same file twice still fires `change`.
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const onDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void readFile(file);
    };

    const resetToFileStep = () => {
        setStep('file');
        setError(null);
        setParsed(null);
        setFileName('');
        setFileSize(0);
        setName('');
    };

    const goNext = () => {
        if (!validation) return;
        if (validation.blocked) {
            setError(t(
                validation.blocked === 'mostlyInvalid'
                    ? 'vocab.custom.import.blocked.mostlyInvalid'
                    : 'vocab.custom.import.blocked.noValid',
            ));
            return;
        }
        if (map.word == null) {
            setError(t('vocab.custom.import.map.needWord'));
            return;
        }
        setError(null);
        setStep('confirm');
    };

    const submit = async () => {
        if (importing || !validation || validation.blocked) return;
        const trimmed = name.trim();
        if (!trimmed) {
            setError(t('vocab.custom.import.nameRequired'));
            return;
        }
        if (trimmed.length > WORDLIST_MAX_NAME_LENGTH) {
            setError(t('vocab.custom.import.nameTooLong'));
            return;
        }
        if (listCount >= WORDLIST_MAX_LISTS) {
            setError(t('vocab.custom.import.limit'));
            return;
        }
        setImporting(true);
        setError(null);
        try {
            const result = await importCustomWordlist({
                name: finalName || trimmed,
                filename: fileName,
                items: validation.entries,
            });
            // The client already filtered invalid/duplicate rows, so the server
            // usually reports 0 more skips; show the honest total (a stricter
            // server rule still adds to it instead of being hidden).
            const skippedTotal = validation.skippedCount + result.skipped;
            toast.success(
                skippedTotal > 0
                    ? t('vocab.custom.import.successSkipped', {
                        name: result.list.name,
                        count: formatNumber(validation.valid),
                        skipped: formatNumber(skippedTotal),
                    })
                    : t('vocab.custom.import.success', {
                        name: result.list.name,
                        count: formatNumber(validation.valid),
                    }),
                { dedupeKey: 'wordlist:imported' },
            );
            onImported(result.list, skippedTotal);
            onClose();
        } catch (err) {
            setError(
                err instanceof WordlistsApiError && err.status === 403
                    ? t('vocab.custom.import.loginRequired')
                    : t('vocab.custom.import.error'),
            );
        } finally {
            setImporting(false);
        }
    };

    const previewRows = useMemo(() => {
        if (!parsed) return [];
        return parsed.rows.slice(0, 5).map((cells) => {
            const value = (role: WordlistColumnRole): string => {
                const column = map[role];
                return column == null ? '' : (cells[column] ?? '').trim();
            };
            return {
                word: value('word'),
                translation: value('translation'),
                phonetic: value('phonetic'),
                cefr: value('cefr').toUpperCase(),
                example: value('example'),
            };
        });
    }, [parsed, map]);

    const showHeader = parsed?.header != null;
    const hasFile = parsed != null;
    const canContinue = Boolean(validation && !validation.blocked && map.word != null);

    const usedColumns = new Map<number, WordlistColumnRole>();
    for (const role of WORDLIST_COLUMN_ROLES) {
        const column = map[role];
        if (column != null) usedColumns.set(column, role);
    }

    const stepLabel = t('vocab.custom.import.stepLabel', {
        current: formatNumber(STEP_ORDER.indexOf(step) + 1),
        total: formatNumber(STEP_ORDER.length),
    });

    const renderStepIndicator = () => (
        <ol
            data-testid="wordlist-import-steps"
            aria-label={stepLabel}
            className="mb-4 flex flex-wrap items-center gap-1.5"
        >
            {STEP_ORDER.map((item, index) => {
                const active = item === step;
                return (
                    <li
                        key={item}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-micro font-medium',
                            active
                                ? 'border-brand/20 bg-brand/10 text-brand-300'
                                : 'border-line-subtle bg-surface-2/40 text-fg-muted',
                        )}
                    >
                        <span className="tabular-nums">{formatNumber(index + 1)}</span>
                        <span>{t(STEP_LABEL_KEYS[item])}</span>
                    </li>
                );
            })}
        </ol>
    );

    const renderFileStep = () => (
        <div className="flex flex-col gap-4">
            {renderStepIndicator()}
            <div
                data-testid="wordlist-import-dropzone"
                onDragEnter={(event) => {
                    event.preventDefault();
                    setDragging(true);
                }}
                onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                }}
                onDragLeave={(event) => {
                    event.preventDefault();
                    setDragging(false);
                }}
                onDrop={onDrop}
                className={cn(
                    'flex flex-col items-center justify-center gap-3 rounded-card border-2 border-dashed px-4 py-10 text-center transition-colors',
                    dragging
                        ? 'border-brand/40 bg-brand/5'
                        : 'border-line-strong bg-surface-2/30',
                )}
            >
                <UploadCloud className="h-9 w-9 text-fg-muted" aria-hidden="true" />
                <p className="text-ui font-medium text-fg-strong">{t('vocab.custom.import.drop')}</p>
                <Button
                    variant="secondary"
                    size="md"
                    onClick={openFilePicker}
                    loading={parsing}
                    testId="wordlist-import-browse"
                >
                    {parsing ? t('vocab.custom.import.reading') : t('vocab.custom.import.browse')}
                </Button>
                <p className="text-caption leading-relaxed text-fg-secondary">
                    {t('vocab.custom.import.formats')}
                </p>
                <p className="max-w-md text-micro leading-relaxed text-fg-muted">
                    {t('vocab.custom.import.ankiHint')}
                </p>
            </div>
            <input
                ref={fileInputRef}
                data-testid="wordlist-import-file"
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                className="sr-only"
                onChange={(event) => onInputChange(event.target.files)}
            />
        </div>
    );

    const renderMapStep = () => (
        <div className="flex flex-col gap-4">
            {renderStepIndicator()}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-line-subtle bg-surface-2/30 px-3 py-2 text-caption text-fg-secondary">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                    <FileSpreadsheet className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
                    <span className="min-w-0 truncate" data-testid="wordlist-import-file-name">
                        {fileName}
                    </span>
                    <span className="shrink-0 tabular-nums text-fg-muted">{formatBytes(fileSize)}</span>
                </span>
                <span className="text-fg-muted">
                    {t('vocab.custom.import.delimiter', {
                        delimiter: parsed?.delimiter === '\t'
                            ? t('vocab.custom.import.delimiter.tab')
                            : t('vocab.custom.import.delimiter.comma'),
                    })}
                </span>
                <span data-testid="wordlist-import-header-note" className="text-fg-muted">
                    {showHeader
                        ? t('vocab.custom.import.header')
                        : t('vocab.custom.import.headerNone')}
                </span>
            </div>

            <section aria-labelledby="wordlist-import-map-title" className="flex flex-col gap-2">
                <h3 id="wordlist-import-map-title" className="text-caption font-medium text-fg-strong">
                    {t('vocab.custom.import.map.title')}
                </h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {WORDLIST_COLUMN_ROLES.map((role) => {
                        const selectId = `wordlist-import-map-${role}`;
                        const value = map[role];
                        const required = role === 'word';
                        return (
                            <div key={role} className="flex items-center gap-2">
                                <label
                                    htmlFor={selectId}
                                    className="w-24 shrink-0 text-caption text-fg-secondary"
                                >
                                    {t(COLUMN_LABEL_KEYS[role])}
                                </label>
                                <select
                                    id={selectId}
                                    data-testid={selectId}
                                    value={value == null ? '' : String(value)}
                                    onChange={(event) => {
                                        const next = event.target.value === ''
                                            ? null
                                            : Number(event.target.value);
                                        setMap((prev) => ({ ...prev, [role]: next }));
                                        setError(null);
                                    }}
                                    className="h-control-md min-w-0 flex-1 rounded-control border border-line-subtle bg-surface-2/60 px-2 text-ui text-fg-primary transition-colors hover:bg-surface-3/60"
                                >
                                    {!required && (
                                        <option value="">{t('vocab.custom.import.map.none')}</option>
                                    )}
                                    {Array.from({ length: columnCount }, (_, index) => {
                                        const usedBy = usedColumns.get(index);
                                        const disabled = usedBy != null && usedBy !== role;
                                        return (
                                            <option key={index} value={index} disabled={disabled}>
                                                {columnLabel(index)}
                                            </option>
                                        );
                                    })}
                                </select>
                            </div>
                        );
                    })}
                </div>
            </section>

            {validation && (
                <section aria-labelledby="wordlist-import-stats-title" className="flex flex-col gap-2">
                    <h3 id="wordlist-import-stats-title" className="text-caption font-medium text-fg-strong">
                        {t('vocab.custom.import.statsTitle')}
                    </h3>
                    <p
                        data-testid="wordlist-import-stats"
                        className="text-caption tabular-nums text-fg-secondary"
                    >
                        {t('vocab.custom.import.stats', {
                            total: formatNumber(validation.total),
                            valid: formatNumber(validation.valid),
                            skipped: formatNumber(validation.skippedCount),
                        })}
                    </p>
                    {validation.skipped.length > 0 && (
                        <div className="rounded-control border border-warning/20 bg-warning/5 px-3 py-2">
                            <p className="text-micro font-medium text-warning-fg">
                                {t('vocab.custom.import.skipTitle')}
                            </p>
                            <ul className="mt-1 flex flex-col gap-0.5">
                                {validation.skipped.slice(0, 5).map((row) => (
                                    <li
                                        key={`${row.line}-${row.reason}-${row.value}`}
                                        className="break-words text-micro leading-relaxed text-fg-secondary"
                                    >
                                        {t('vocab.custom.import.skipRow', {
                                            line: formatNumber(row.line),
                                            reason: t(SKIP_REASON_KEYS[row.reason]),
                                        })}
                                        {row.value ? ` · ${row.value}` : ''}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {validation.blocked && (
                        <p
                            role="alert"
                            data-testid="wordlist-import-blocked"
                            className="flex items-start gap-1.5 text-caption leading-relaxed text-danger-fg"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>
                                {validation.blocked === 'mostlyInvalid'
                                    ? t('vocab.custom.import.blocked.mostlyInvalid')
                                    : t('vocab.custom.import.blocked.noValid')}
                            </span>
                        </p>
                    )}
                </section>
            )}
            <section aria-labelledby="wordlist-import-preview-title" className="flex flex-col gap-2">
                <h3
                    id="wordlist-import-preview-title"
                    data-testid="wordlist-import-preview-title"
                    className="text-caption font-medium text-fg-strong"
                >
                    {t('vocab.custom.import.preview')}
                </h3>
                <div className="divide-y divide-line-subtle overflow-hidden rounded-card border border-line-subtle bg-surface-2/30">
                    {previewRows.length === 0 ? (
                        <p className="px-3 py-3 text-caption text-fg-muted">
                            {t('vocab.custom.import.previewEmpty')}
                        </p>
                    ) : previewRows.map((row, index) => (
                        <div key={`${row.word}-${index}`} className="px-3 py-2">
                            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                                <span className="min-w-0 break-words text-ui font-semibold text-fg-primary">
                                    {row.word || '—'}
                                </span>
                                {row.phonetic && (
                                    <span className="min-w-0 break-words text-caption text-fg-muted">
                                        {row.phonetic}
                                    </span>
                                )}
                                {row.cefr && (WORDLIST_CEFR_LEVELS as readonly string[]).includes(row.cefr) && (
                                    <LevelBadge level={row.cefr} />
                                )}
                            </div>
                            {row.translation && (
                                <p className="mt-0.5 break-words text-caption text-fg-secondary">
                                    {row.translation}
                                </p>
                            )}
                            {row.example && (
                                <p className="mt-0.5 break-words text-micro leading-relaxed text-fg-muted">
                                    {row.example}
                                </p>
                            )}
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );

    const renderConfirmStep = () => (
        <div className="flex flex-col gap-4">
            {renderStepIndicator()}
            <div className="rounded-control border border-line-subtle bg-surface-2/30 px-3 py-2 text-caption text-fg-secondary">
                <span className="inline-flex items-center gap-1.5">
                    <FileSpreadsheet className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
                    <span className="min-w-0 break-words">{fileName}</span>
                </span>
                <p className="mt-1 tabular-nums text-fg-muted">
                    {t('vocab.custom.import.stats', {
                        total: formatNumber(validation?.total ?? 0),
                        valid: formatNumber(validation?.valid ?? 0),
                        skipped: formatNumber(validation?.skippedCount ?? 0),
                    })}
                </p>
            </div>
            <div className="flex flex-col gap-1.5">
                <label htmlFor="wordlist-import-name" className="text-caption font-medium text-fg-strong">
                    {t('vocab.custom.import.name')}
                </label>
                <input
                    id="wordlist-import-name"
                    data-testid="wordlist-import-name"
                    type="text"
                    value={name}
                    maxLength={WORDLIST_MAX_NAME_LENGTH}
                    onChange={(event) => {
                        setName(event.target.value);
                        setError(null);
                    }}
                    placeholder={t('vocab.custom.import.namePlaceholder')}
                    className="h-control-lg w-full min-w-0 rounded-control border border-line-subtle bg-surface-2/60 px-3 text-ui text-fg-primary placeholder:text-fg-muted"
                />
                <p className="text-micro leading-relaxed text-fg-muted">
                    {t('vocab.custom.import.nameHint')}
                </p>
                {finalName && finalName !== name.trim() && (
                    <p
                        data-testid="wordlist-import-rename"
                        className="text-caption leading-relaxed text-warning-fg"
                    >
                        {t('vocab.custom.import.rename', { name: finalName })}
                    </p>
                )}
            </div>
            {validation && (
                <p data-testid="wordlist-import-summary" className="text-caption leading-relaxed text-fg-secondary">
                    {t('vocab.custom.import.summary', {
                        count: formatNumber(validation.valid),
                        name: finalName || name.trim(),
                    })}
                </p>
            )}
        </div>
    );

    const footer = step === 'file' ? (
        <Button
            variant="secondary"
            onClick={onClose}
            disabled={parsing}
            testId="wordlist-import-cancel"
            className="w-full sm:w-auto"
        >
            {t('common.cancel')}
        </Button>
    ) : step === 'map' ? (
        <>
            <Button
                variant="secondary"
                onClick={resetToFileStep}
                testId="wordlist-import-back"
                className="w-full sm:w-auto"
            >
                {t('vocab.custom.import.back')}
            </Button>
            <Button
                variant="primary"
                onClick={goNext}
                disabled={!canContinue}
                testId="wordlist-import-next"
                className="w-full sm:w-auto"
            >
                {t('vocab.custom.import.next')}
            </Button>
        </>
    ) : (
        <>
            <Button
                variant="secondary"
                onClick={() => {
                    setStep('map');
                    setError(null);
                }}
                disabled={importing}
                testId="wordlist-import-back"
                className="w-full sm:w-auto"
            >
                {t('vocab.custom.import.back')}
            </Button>
            <Button
                variant="primary"
                onClick={() => { void submit(); }}
                loading={importing}
                disabled={!hasFile || !validation || validation.blocked != null}
                testId="wordlist-import-submit"
                className="w-full sm:w-auto"
            >
                {importing
                    ? t('vocab.custom.import.importing')
                    : t('vocab.custom.import.submit', {
                        count: formatNumber(validation?.valid ?? 0),
                    })}
            </Button>
        </>
    );

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={t('vocab.custom.import.title')}
            description={t('vocab.custom.import.description')}
            size="lg"
            loading={importing}
            error={error}
            footer={footer}
            testId="wordlist-import-dialog"
            initialFocus="[data-testid='wordlist-import-browse']"
        >
            {step === 'file' && renderFileStep()}
            {step === 'map' && renderMapStep()}
            {step === 'confirm' && renderConfirmStep()}
        </Dialog>
    );
}
