// Import wizard for custom word lists (specs/038-custom-wordlists + specs/046).
//
// Text files (three steps)
//   1. pick a `.csv` / `.tsv` / `.txt` (≤2 MB, ≤10000 rows) by drag/drop or
//      file picker. The file is parsed locally; nothing is uploaded yet.
//   2. preview the first 5 rows, map the columns (word is required;
//      translation / phonetic / CEFR / example are optional), and read the live
//      「共 N 行 · 有效 M · 跳过 K」 stats with the first 5 skip reasons.
//   3. name the list (same name → automatic `(2)`) and POST the validated
//      entries. Cancelling at any step writes nothing.
//
// Anki `.apkg` (four steps, specs/046 §3)
//   1. pick a `.apkg` (≤50 MB). The package is uploaded to
//      `POST /api/wordlists/apkg-parse` — unlike text it cannot be read locally.
//   2. configure: deck (only that deck is imported), note type (a model inside
//      the deck), then the word / translation / phonetic fields; the first five
//      converted rows preview live, with the filtered count, the skipped
//      other-model count and the server's truncation hint when applicable.
//   3. the chosen notes become a two/three-column `ParsedWordlistFile`, so the
//      existing map + validation + confirm steps below are reused unchanged.
//   4. import through the same `/api/wordlists/import` path.
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
    defaultApkgFieldMap,
    defaultColumnMap,
    defaultWordlistName,
    isApkgFileName,
    isApkgSizeAllowed,
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
    type ApkgFieldMap,
    type ParsedWordlistFile,
    type WordlistColumnMap,
    type WordlistColumnRole,
    type WordlistSkipReason,
} from '../lib/wordlistParse';
import {
    importCustomWordlist,
    parseApkgWordlist,
    WordlistsApiError,
    type ApkgWordlistResult,
    type CustomWordlist,
} from '../lib/wordlists';
import { toast } from '../lib/toast';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { LevelBadge } from './VocabularyRows';

type Step = 'file' | 'apkg' | 'map' | 'confirm';

/** Text files keep the three steps; APKG adds the deck/model/field config. */
const TEXT_STEP_ORDER: readonly Step[] = ['file', 'map', 'confirm'];
const APKG_STEP_ORDER: readonly Step[] = ['file', 'apkg', 'map', 'confirm'];

const STEP_LABEL_KEYS: Record<Step, TranslationKey> = {
    file: 'vocab.custom.import.step.file',
    apkg: 'vocab.custom.import.step.apkg',
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

/** APKG field roles the config step maps onto one note type (specs/046 §3). */
const APKG_FIELD_ROLES = ['word', 'translation', 'phonetic'] as const;
type ApkgFieldRole = (typeof APKG_FIELD_ROLES)[number];

const APKG_FIELD_LABEL_KEYS: Record<ApkgFieldRole, TranslationKey> = {
    word: 'vocab.custom.import.apkg.wordField',
    translation: 'vocab.custom.import.apkg.translationField',
    phonetic: 'vocab.custom.import.apkg.phoneticField',
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
    /** True while the APKG upload+parse runs (the browse button says 「正在解析」). */
    const [parsingApkg, setParsingApkg] = useState(false);
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
    // ── APKG state (specs/046 §3): the upload result + the chosen config ──
    const [apkg, setApkg] = useState<ApkgWordlistResult | null>(null);
    const [apkgDeckId, setApkgDeckId] = useState('');
    const [apkgModelId, setApkgModelId] = useState('');
    const [apkgFields, setApkgFields] = useState<ApkgFieldMap>({
        word: null,
        translation: null,
        phonetic: null,
    });
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Every open starts from a clean wizard; closing discards the parsed file
    // (cancel has zero side effects, specs/038 §7).
    useEffect(() => {
        if (!open) return;
        setStep('file');
        setError(null);
        setParsing(false);
        setParsingApkg(false);
        setFileName('');
        setFileSize(0);
        setParsed(null);
        setMap({ word: null, translation: null, phonetic: null, cefr: null, example: null });
        setName('');
        setImporting(false);
        setDragging(false);
        setApkg(null);
        setApkgDeckId('');
        setApkgModelId('');
        setApkgFields({ word: null, translation: null, phonetic: null });
    }, [open]);

    // Moving between steps moves focus inside the dialog (the Dialog owns the
    // trap); the file step keeps its own initial focus on the browse button.
    useEffect(() => {
        if (!open || step === 'file') return;
        const selector = step === 'apkg'
            ? '[data-testid="wordlist-import-apkg-deck"]'
            : step === 'map'
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

    const stepOrder = apkg ? APKG_STEP_ORDER : TEXT_STEP_ORDER;

    // ── APKG derivations: notes of the chosen deck, then of the chosen model ─
    const apkgDeckNotes = useMemo(
        () => (apkg && apkgDeckId
            ? apkg.notes.filter((note) => note.deckId === apkgDeckId)
            : []),
        [apkg, apkgDeckId],
    );

    // Models that actually have notes in the selected deck, most notes first
    // (the same order the default picks from).
    const apkgDeckModels = useMemo(() => {
        if (!apkg) return [];
        const counts = new Map<string, number>();
        for (const note of apkgDeckNotes) {
            counts.set(note.modelId, (counts.get(note.modelId) ?? 0) + 1);
        }
        return apkg.models
            .filter((model) => (counts.get(model.id) ?? 0) > 0)
            .map((model) => ({ ...model, noteCount: counts.get(model.id) ?? 0 }))
            .sort((left, right) => right.noteCount - left.noteCount);
    }, [apkg, apkgDeckNotes]);

    const activeApkgModel = apkgDeckModels.find((model) => model.id === apkgModelId) ?? null;
    const apkgFieldNames = activeApkgModel?.fields ?? [];

    const apkgSelectedNotes = useMemo(
        () => apkgDeckNotes.filter((note) => note.modelId === apkgModelId),
        [apkgDeckNotes, apkgModelId],
    );

    const apkgOtherModelNotes = apkgDeckNotes.length - apkgSelectedNotes.length;
    const apkgOtherDeckNotes = (apkg?.notes.length ?? 0) - apkgDeckNotes.length;

    const apkgCell = useCallback(
        (note: { fields: string[] }, column: number | null): string => (
            column == null ? '' : (note.fields[column] ?? '').trim()
        ),
        [],
    );

    const apkgPreviewRows = useMemo(
        () => apkgSelectedNotes.slice(0, 5).map((note) => ({
            word: apkgCell(note, apkgFields.word),
            translation: apkgCell(note, apkgFields.translation),
            phonetic: apkgCell(note, apkgFields.phonetic),
        })),
        [apkgSelectedNotes, apkgFields, apkgCell],
    );

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

    /** Default model for a deck = the one with the most notes in it. */
    const apkgModelDefaultsForDeck = useCallback((deckId: string): {
        modelId: string;
        fields: ApkgFieldMap;
    } => {
        if (!apkg) return { modelId: '', fields: { word: null, translation: null, phonetic: null } };
        const counts = new Map<string, number>();
        for (const note of apkg.notes) {
            if (note.deckId !== deckId) continue;
            counts.set(note.modelId, (counts.get(note.modelId) ?? 0) + 1);
        }
        const model = apkg.models
            .filter((entry) => (counts.get(entry.id) ?? 0) > 0)
            .sort((left, right) => (counts.get(right.id) ?? 0) - (counts.get(left.id) ?? 0))[0];
        return {
            modelId: model?.id ?? '',
            fields: defaultApkgFieldMap(model?.fields ?? []),
        };
    }, [apkg]);

    const applyApkgDeck = useCallback((deckId: string) => {
        const defaults = apkgModelDefaultsForDeck(deckId);
        setApkgDeckId(deckId);
        setApkgModelId(defaults.modelId);
        setApkgFields(defaults.fields);
        setError(null);
    }, [apkgModelDefaultsForDeck]);

    const applyApkgModel = useCallback((modelId: string) => {
        const model = apkg?.models.find((entry) => entry.id === modelId) ?? null;
        setApkgModelId(modelId);
        setApkgFields(defaultApkgFieldMap(model?.fields ?? []));
        setError(null);
    }, [apkg]);

    /** APKG upload failures map onto the localized copy by HTTP status. */
    const apkgErrorMessage = useCallback((failure: unknown): string => {
        if (failure instanceof WordlistsApiError) {
            if (failure.status === 403) return t('vocab.custom.import.loginRequired');
            if (failure.status === 413) return t('vocab.custom.import.apkg.error.tooLarge');
            if (failure.status === 503) return t('vocab.custom.import.apkg.error.unavailable');
            if (failure.status === 400) return t('vocab.custom.import.apkg.error.invalid');
        }
        return t('vocab.custom.import.apkg.error.read');
    }, [t]);

    /**
     * `.apkg` is uploaded (never read as text): the backend unzips the package
     * and returns decks/models/notes, then the wizard opens the config step.
     */
    const readApkgFile = async (file: File) => {
        setError(null);
        if (!isApkgSizeAllowed(file.size)) {
            setError(t('vocab.custom.import.apkg.error.tooLarge'));
            return;
        }
        setParsing(true);
        setParsingApkg(true);
        try {
            const result = await parseApkgWordlist(file);
            if (result.decks.length === 0 || result.models.length === 0 || result.notes.length === 0) {
                setError(t('vocab.custom.import.apkg.error.noNotes'));
                return;
            }
            const largestDeck = [...result.decks].sort((left, right) => right.noteCount - left.noteCount)[0];
            const deckCounts = new Map<string, number>();
            for (const note of result.notes) {
                if (note.deckId !== largestDeck.id) continue;
                deckCounts.set(note.modelId, (deckCounts.get(note.modelId) ?? 0) + 1);
            }
            const model = result.models
                .filter((entry) => (deckCounts.get(entry.id) ?? 0) > 0)
                .sort((left, right) => (deckCounts.get(right.id) ?? 0) - (deckCounts.get(left.id) ?? 0))[0];
            const resolvedName = result.fileName || file.name;
            setFileName(resolvedName);
            setFileSize(file.size);
            setParsed(null);
            setApkg(result);
            setApkgDeckId(largestDeck.id);
            setApkgModelId(model?.id ?? '');
            setApkgFields(defaultApkgFieldMap(model?.fields ?? []));
            setName(defaultWordlistName(resolvedName));
            setStep('apkg');
        } catch (failure) {
            setError(apkgErrorMessage(failure));
        } finally {
            setParsing(false);
            setParsingApkg(false);
        }
    };

    const readFile = async (file: File) => {
        setError(null);
        // `.apkg` first: it must never be decoded with File.text().
        if (isApkgFileName(file.name)) {
            await readApkgFile(file);
            return;
        }
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
            setApkg(null);
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

    /**
     * APKG → `ParsedWordlistFile`: only the chosen deck+model, column order
     * word / translation / phonetic (the two optional columns are skipped when
     * the field is 「不使用」), so the existing map/validation step applies.
     */
    const goNextFromApkg = () => {
        if (!apkg || !activeApkgModel) {
            setError(t('vocab.custom.import.apkg.error.noNotes'));
            return;
        }
        if (apkgFields.word == null || apkgFields.word >= apkgFieldNames.length) {
            setError(t('vocab.custom.import.apkg.needWord'));
            return;
        }
        if (apkgSelectedNotes.length === 0) {
            setError(t('vocab.custom.import.apkg.error.noNotes'));
            return;
        }
        const columnIndexes = [
            apkgFields.word,
            ...(apkgFields.translation != null ? [apkgFields.translation] : []),
            ...(apkgFields.phonetic != null ? [apkgFields.phonetic] : []),
        ];
        const rows = apkgSelectedNotes.map((note) => columnIndexes.map((column) => (
            (note.fields[column] ?? '').trim()
        )));
        if (rows.every((cells) => !cells[0])) {
            setError(t('vocab.custom.import.apkg.noValid'));
            return;
        }
        if (rows.length > WORDLIST_MAX_ROWS) {
            setError(t('vocab.custom.import.error.tooManyRows'));
            return;
        }
        const header = columnIndexes.map((column) => (
            apkgFieldNames[column]?.trim()
            || t('vocab.custom.import.column', { index: formatNumber(column + 1) })
        ));
        const translationColumn = apkgFields.translation == null ? null : 1;
        const phoneticColumn = apkgFields.phonetic == null
            ? null
            : (apkgFields.translation == null ? 1 : 2);
        setParsed({
            delimiter: ',',
            header,
            rows,
            lineNumbers: rows.map((_, index) => index + 1),
            columnCount: columnIndexes.length,
        });
        setMap({
            word: 0,
            translation: translationColumn,
            phonetic: phoneticColumn,
            cefr: null,
            example: null,
        });
        if (!name.trim()) setName(defaultWordlistName(fileName));
        setError(null);
        setStep('map');
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
        setApkg(null);
        setApkgDeckId('');
        setApkgModelId('');
        setApkgFields({ word: null, translation: null, phonetic: null });
    };

    /** Map → back returns to the APKG config when the file was an APKG. */
    const backFromMap = () => {
        setError(null);
        if (apkg) setStep('apkg');
        else resetToFileStep();
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
        current: formatNumber(stepOrder.indexOf(step) + 1),
        total: formatNumber(stepOrder.length),
    });

    const renderStepIndicator = () => (
        <ol
            data-testid="wordlist-import-steps"
            aria-label={stepLabel}
            className="mb-4 flex flex-wrap items-center gap-1.5"
        >
            {stepOrder.map((item, index) => {
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
                    {parsing
                        ? t(parsingApkg
                            ? 'vocab.custom.import.apkg.parsing'
                            : 'vocab.custom.import.reading')
                        : t('vocab.custom.import.browse')}
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
                accept=".csv,.tsv,.txt,.apkg,text/csv,text/tab-separated-values,text/plain,application/zip,application/octet-stream"
                className="sr-only"
                onChange={(event) => onInputChange(event.target.files)}
            />
        </div>
    );

    const apkgFieldLabel = (column: number): string => (
        apkgFieldNames[column]?.trim()
        || t('vocab.custom.import.column', { index: formatNumber(column + 1) })
    );

    const apkgUsedFields = new Map<number, ApkgFieldRole>();
    for (const role of APKG_FIELD_ROLES) {
        const column = apkgFields[role];
        if (column != null) apkgUsedFields.set(column, role);
    }

    const renderApkgStep = () => (
        <div className="flex flex-col gap-4">
            {renderStepIndicator()}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-line-subtle bg-surface-2/30 px-3 py-2 text-caption text-fg-secondary">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                    <FileSpreadsheet className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
                    <span
                        className="min-w-0 truncate"
                        data-testid="wordlist-import-apkg-file-name"
                    >
                        {fileName}
                    </span>
                    <span className="shrink-0 tabular-nums text-fg-muted">{formatBytes(fileSize)}</span>
                </span>
                <span data-testid="wordlist-import-apkg-total" className="tabular-nums text-fg-muted">
                    {t('vocab.custom.import.apkg.noteTotal', {
                        count: formatNumber(apkg?.total ?? 0),
                    })}
                </span>
            </div>

            {apkg?.truncated && (
                <p
                    role="status"
                    data-testid="wordlist-import-apkg-truncated"
                    className="flex items-start gap-1.5 rounded-control border border-warning/20 bg-warning/5 px-3 py-2 text-caption leading-relaxed text-warning-fg"
                >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>
                        {t('vocab.custom.import.apkg.truncated', {
                            count: formatNumber(WORDLIST_MAX_ROWS),
                        })}
                    </span>
                </p>
            )}

            <section aria-labelledby="wordlist-import-apkg-config-title" className="flex flex-col gap-2">
                <h3
                    id="wordlist-import-apkg-config-title"
                    className="text-caption font-medium text-fg-strong"
                >
                    {t('vocab.custom.import.apkg.configTitle')}
                </h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="flex items-center gap-2">
                        <label
                            htmlFor="wordlist-import-apkg-deck"
                            className="w-24 shrink-0 text-caption text-fg-secondary"
                        >
                            {t('vocab.custom.import.apkg.deck')}
                        </label>
                        <select
                            id="wordlist-import-apkg-deck"
                            data-testid="wordlist-import-apkg-deck"
                            value={apkgDeckId}
                            onChange={(event) => applyApkgDeck(event.target.value)}
                            className="h-control-md min-w-0 flex-1 rounded-control border border-line-subtle bg-surface-2/60 px-2 text-ui text-fg-primary transition-colors hover:bg-surface-3/60"
                        >
                            {(apkg?.decks ?? []).map((deck) => (
                                <option key={deck.id} value={deck.id}>
                                    {t('vocab.custom.import.apkg.option', {
                                        name: deck.name,
                                        count: formatNumber(deck.noteCount),
                                    })}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="flex items-center gap-2">
                        <label
                            htmlFor="wordlist-import-apkg-model"
                            className="w-24 shrink-0 text-caption text-fg-secondary"
                        >
                            {t('vocab.custom.import.apkg.model')}
                        </label>
                        <select
                            id="wordlist-import-apkg-model"
                            data-testid="wordlist-import-apkg-model"
                            value={apkgModelId}
                            disabled={apkgDeckModels.length === 0}
                            onChange={(event) => applyApkgModel(event.target.value)}
                            className="h-control-md min-w-0 flex-1 rounded-control border border-line-subtle bg-surface-2/60 px-2 text-ui text-fg-primary transition-colors hover:bg-surface-3/60"
                        >
                            {apkgDeckModels.map((model) => (
                                <option key={model.id} value={model.id}>
                                    {t('vocab.custom.import.apkg.option', {
                                        name: model.name,
                                        count: formatNumber(model.noteCount),
                                    })}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
                {apkgFieldNames.length === 0 && (
                    <p
                        role="alert"
                        data-testid="wordlist-import-apkg-no-fields"
                        className="flex items-start gap-1.5 text-caption leading-relaxed text-danger-fg"
                    >
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{t('vocab.custom.import.apkg.error.noFields')}</span>
                    </p>
                )}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {APKG_FIELD_ROLES.map((role) => {
                        const required = role === 'word';
                        const value = apkgFields[role];
                        const selectId = `wordlist-import-apkg-${role}`;
                        return (
                            <div key={role} className="flex items-center gap-2">
                                <label
                                    htmlFor={selectId}
                                    className="w-24 shrink-0 text-caption text-fg-secondary"
                                >
                                    {t(APKG_FIELD_LABEL_KEYS[role])}
                                </label>
                                <select
                                    id={selectId}
                                    data-testid={selectId}
                                    value={value == null ? '' : String(value)}
                                    disabled={apkgFieldNames.length === 0}
                                    onChange={(event) => {
                                        const next = event.target.value === ''
                                            ? null
                                            : Number(event.target.value);
                                        setApkgFields((previous) => ({ ...previous, [role]: next }));
                                        setError(null);
                                    }}
                                    className="h-control-md min-w-0 flex-1 rounded-control border border-line-subtle bg-surface-2/60 px-2 text-ui text-fg-primary transition-colors hover:bg-surface-3/60"
                                >
                                    {required && value == null && (
                                        <option value="">
                                            {t('vocab.custom.import.apkg.pickField')}
                                        </option>
                                    )}
                                    {!required && (
                                        <option value="">{t('vocab.custom.import.apkg.none')}</option>
                                    )}
                                    {apkgFieldNames.map((_, column) => {
                                        const usedBy = apkgUsedFields.get(column);
                                        const disabled = usedBy != null && usedBy !== role;
                                        return (
                                            <option key={column} value={column} disabled={disabled}>
                                                {apkgFieldLabel(column)}
                                            </option>
                                        );
                                    })}
                                </select>
                            </div>
                        );
                    })}
                </div>
            </section>

            <section aria-labelledby="wordlist-import-apkg-stats-title" className="flex flex-col gap-1">
                <h3
                    id="wordlist-import-apkg-stats-title"
                    className="text-caption font-medium text-fg-strong"
                >
                    {t('vocab.custom.import.apkg.statsTitle')}
                </h3>
                <p
                    data-testid="wordlist-import-apkg-stats"
                    className="text-caption tabular-nums text-fg-secondary"
                >
                    {t('vocab.custom.import.apkg.stats', {
                        total: formatNumber(apkgDeckNotes.length),
                        filtered: formatNumber(apkgSelectedNotes.length),
                    })}
                </p>
                <p
                    data-testid="wordlist-import-apkg-skipped"
                    className="text-caption tabular-nums text-fg-muted"
                >
                    {t('vocab.custom.import.apkg.skipped', {
                        decks: formatNumber(apkgOtherDeckNotes),
                        models: formatNumber(apkgOtherModelNotes),
                    })}
                </p>
            </section>

            <section aria-labelledby="wordlist-import-apkg-preview-title" className="flex flex-col gap-2">
                <h3
                    id="wordlist-import-apkg-preview-title"
                    data-testid="wordlist-import-apkg-preview-title"
                    className="text-caption font-medium text-fg-strong"
                >
                    {t('vocab.custom.import.apkg.preview')}
                </h3>
                <div className="divide-y divide-line-subtle overflow-hidden rounded-card border border-line-subtle bg-surface-2/30">
                    {apkgPreviewRows.length === 0 ? (
                        <p className="px-3 py-3 text-caption text-fg-muted">
                            {t('vocab.custom.import.previewEmpty')}
                        </p>
                    ) : apkgPreviewRows.map((row, index) => (
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
                            </div>
                            {row.translation && (
                                <p className="mt-0.5 break-words text-caption text-fg-secondary">
                                    {row.translation}
                                </p>
                            )}
                        </div>
                    ))}
                </div>
            </section>
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
                {apkg ? (
                    <span data-testid="wordlist-import-apkg-map-note" className="text-fg-muted">
                        {t('vocab.custom.import.apkg.mapNote', {
                            deck: apkg.decks.find((deck) => deck.id === apkgDeckId)?.name ?? '',
                            model: activeApkgModel?.name ?? '',
                        })}
                    </span>
                ) : (
                    <span className="text-fg-muted">
                        {t('vocab.custom.import.delimiter', {
                            delimiter: parsed?.delimiter === '\t'
                                ? t('vocab.custom.import.delimiter.tab')
                                : t('vocab.custom.import.delimiter.comma'),
                        })}
                    </span>
                )}
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
    ) : step === 'apkg' ? (
        <>
            <Button
                variant="secondary"
                onClick={resetToFileStep}
                disabled={parsing}
                testId="wordlist-import-back"
                className="w-full sm:w-auto"
            >
                {t('vocab.custom.import.back')}
            </Button>
            <Button
                variant="primary"
                onClick={goNextFromApkg}
                disabled={parsing || !activeApkgModel || apkgFields.word == null}
                testId="wordlist-import-next"
                className="w-full sm:w-auto"
            >
                {t('vocab.custom.import.next')}
            </Button>
        </>
    ) : step === 'map' ? (
        <>
            <Button
                variant="secondary"
                onClick={backFromMap}
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
            {step === 'apkg' && renderApkgStep()}
            {step === 'map' && renderMapStep()}
            {step === 'confirm' && renderConfirmStep()}
        </Dialog>
    );
}
