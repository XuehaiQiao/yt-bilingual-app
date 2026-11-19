// Persistent library for browser-local videos.
//
// The video itself never enters the database: only a FileSystemFileHandle (a
// pointer that Chromium can re-open after a reload), a small JPEG cover, the
// last playback position and the raw subtitle text live in IndexedDB. Keeping
// the subtitle *text* is what lets a saved episode reopen with its transcript
// without asking the user to pick the .srt again.
//
// Failure policy: every entry point rejects with a LocalVideoLibraryError that
// carries a stable `code` plus a readable English message. The UI maps the code
// to localized copy; nothing here ever renders (or throws into) the page.
//
// Handles are only available in secure contexts through `showOpenFilePicker`.
// Plain `http://192.168.x.x` keeps the old `<input type=file>` path and simply
// cannot persist anything — callers must say so instead of failing silently.

export const LOCAL_VIDEO_DB_NAME = 'linguatrack-local-video';
export const LOCAL_VIDEO_DB_VERSION = 1;
export const LOCAL_VIDEO_STORE_NAME = 'videos';

/** Extensions the picker advertises and the library accepts. */
export const SUPPORTED_LOCAL_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'ogv'] as const;

export interface LocalVideoRecord {
    /** Fingerprint of name + size + lastModified; stable across reloads. */
    id: string;
    name: string;
    size: number;
    lastModified: number;
    /** Chromium FileSystemFileHandle; absent when only metadata was saved. */
    fileHandle?: FileSystemFileHandle;
    /** 320×180 JPEG data URL captured from the first decoded frame. */
    coverDataUrl?: string;
    duration: number;
    progress: number;
    subtitleName?: string;
    /** Raw SRT/VTT text, so the transcript can be rebuilt without the file. */
    subtitleText?: string;
    lastOpenedAt: number;
}

/** Extra context handed from the Content shelf to the App session. */
export interface LocalVideoOpenMeta {
    fileHandle?: FileSystemFileHandle;
    /** The saved row that was clicked, if any. */
    record?: LocalVideoRecord;
}

export type LocalVideoLibraryErrorCode =
    | 'unsupported'
    | 'unavailable'
    | 'read'
    | 'write'
    | 'delete'
    | 'clone'
    | 'picker';

/** Readable, code-tagged error for every IndexedDB / file-system failure. */
export class LocalVideoLibraryError extends Error {
    readonly code: LocalVideoLibraryErrorCode;

    constructor(code: LocalVideoLibraryErrorCode, message: string) {
        super(message);
        this.name = 'LocalVideoLibraryError';
        this.code = code;
    }
}

/** In-memory handles keep working after IndexedDB structured-clones them. */
const liveHandles = new Map<string, FileSystemFileHandle>();

function hydrate(record: LocalVideoRecord): LocalVideoRecord {
    const live = liveHandles.get(record.id);
    return live ? { ...record, fileHandle: live } : record;
}

function normalizeError(error: unknown, fallback: LocalVideoLibraryErrorCode): LocalVideoLibraryError {
    if (error instanceof LocalVideoLibraryError) return error;
    if (
        typeof DOMException !== 'undefined'
        && error instanceof DOMException
        && error.name === 'DataCloneError'
    ) {
        return new LocalVideoLibraryError(
            'clone',
            'The local video record could not be stored: the file handle is not cloneable in this browser.',
        );
    }
    const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
    return new LocalVideoLibraryError(fallback, `Local video library ${fallback} failed${detail}.`);
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
        return Promise.reject(new LocalVideoLibraryError(
            'unsupported',
            'IndexedDB is not available in this browser, so local videos cannot be remembered.',
        ));
    }
    if (!databasePromise) {
        databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
            let request: IDBOpenDBRequest;
            try {
                request = indexedDB.open(LOCAL_VIDEO_DB_NAME, LOCAL_VIDEO_DB_VERSION);
            } catch (error) {
                databasePromise = null;
                reject(normalizeError(error, 'unavailable'));
                return;
            }
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(LOCAL_VIDEO_STORE_NAME)) {
                    db.createObjectStore(LOCAL_VIDEO_STORE_NAME, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => db.close();
                resolve(db);
            };
            request.onerror = () => {
                databasePromise = null;
                reject(normalizeError(request.error, 'unavailable'));
            };
            request.onblocked = () => {
                databasePromise = null;
                reject(new LocalVideoLibraryError(
                    'unavailable',
                    'The local video library is blocked by another tab; close it and try again.',
                ));
            };
        });
    }
    return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>, code: LocalVideoLibraryErrorCode): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(normalizeError(request.error, code));
    });
}

function transactionDone(
    transaction: IDBTransaction,
    code: LocalVideoLibraryErrorCode,
): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(normalizeError(transaction.error, code));
        transaction.onabort = () => reject(normalizeError(transaction.error, code));
    });
}

/** All saved local videos, most recently opened first. */
export async function listLocalVideos(): Promise<LocalVideoRecord[]> {
    try {
        const db = await openDatabase();
        const transaction = db.transaction(LOCAL_VIDEO_STORE_NAME, 'readonly');
        const records = await requestResult(
            transaction.objectStore(LOCAL_VIDEO_STORE_NAME).getAll(),
            'read',
        );
        return (records as LocalVideoRecord[])
            .map(hydrate)
            .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
    } catch (error) {
        throw normalizeError(error, 'read');
    }
}

/** One saved row, or null when the id is unknown. */
export async function getLocalVideo(id: string): Promise<LocalVideoRecord | null> {
    try {
        const db = await openDatabase();
        const transaction = db.transaction(LOCAL_VIDEO_STORE_NAME, 'readonly');
        const record = await requestResult<LocalVideoRecord | undefined>(
            transaction.objectStore(LOCAL_VIDEO_STORE_NAME).get(id),
            'read',
        );
        return record ? hydrate(record) : null;
    } catch (error) {
        throw normalizeError(error, 'read');
    }
}

/** Insert or replace a row. Handles are cached in memory for this session. */
export async function putLocalVideo(record: LocalVideoRecord): Promise<void> {
    try {
        const db = await openDatabase();
        const transaction = db.transaction(LOCAL_VIDEO_STORE_NAME, 'readwrite');
        const done = transactionDone(transaction, 'write');
        try {
            transaction.objectStore(LOCAL_VIDEO_STORE_NAME).put(record);
            await done;
        } catch (error) {
            // `put` can throw DataCloneError synchronously, before `done` is
            // awaited; abort and observe the transaction rejection so it is
            // never an unhandled promise.
            try { transaction.abort(); } catch { /* already finished */ }
            await done.catch(() => {});
            throw error;
        }
    } catch (error) {
        throw normalizeError(error, 'write');
    }
    if (record.fileHandle) liveHandles.set(record.id, record.fileHandle);
}

/** Remove a row and forget its live handle. */
export async function deleteLocalVideo(id: string): Promise<void> {
    try {
        const db = await openDatabase();
        const transaction = db.transaction(LOCAL_VIDEO_STORE_NAME, 'readwrite');
        const done = transactionDone(transaction, 'delete');
        try {
            transaction.objectStore(LOCAL_VIDEO_STORE_NAME).delete(id);
            await done;
        } catch (error) {
            try { transaction.abort(); } catch { /* already finished */ }
            await done.catch(() => {});
            throw error;
        }
    } catch (error) {
        throw normalizeError(error, 'delete');
    }
    liveHandles.delete(id);
}

/** `name::size::lastModified` — the stated fingerprint for a local file. */
export function buildLocalVideoId(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
    return `${file.name}::${file.size}::${file.lastModified}`;
}

/** True only where the File System Access picker (and its handles) exists. */
export function canPersistLocalVideoHandles(): boolean {
    if (typeof window === 'undefined') return false;
    return window.isSecureContext === true
        && typeof (window as LocalVideoPickerWindow).showOpenFilePicker === 'function';
}

/** True for the five container formats the picker and player claim to support. */
export function isSupportedLocalVideoFile(file: Pick<File, 'name'>): boolean {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    return (SUPPORTED_LOCAL_VIDEO_EXTENSIONS as readonly string[]).includes(extension);
}

interface LocalVideoPickerOptions {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

interface LocalVideoPickerWindow extends Window {
    showOpenFilePicker?: (options?: LocalVideoPickerOptions) => Promise<FileSystemFileHandle[]>;
}

/**
 * Open the Chromium file picker for one video. Returns null when the user
 * cancels; throws a LocalVideoLibraryError when the API is missing or fails.
 */
export async function pickLocalVideoHandle(): Promise<FileSystemFileHandle | null> {
    if (typeof window === 'undefined') return null;
    const picker = (window as LocalVideoPickerWindow).showOpenFilePicker;
    if (window.isSecureContext !== true || typeof picker !== 'function') {
        throw new LocalVideoLibraryError(
            'unsupported',
            'File handles need a secure context and a browser with showOpenFilePicker.',
        );
    }
    try {
        const handles = await picker.call(window, {
            multiple: false,
            types: [{
                description: 'Video',
                accept: {
                    'video/mp4': ['.mp4', '.m4v'],
                    'video/webm': ['.webm'],
                    'video/quicktime': ['.mov'],
                    'video/ogg': ['.ogv'],
                },
            }],
        });
        return handles?.[0] ?? null;
    } catch (error) {
        if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
            return null;
        }
        throw normalizeError(error, 'picker');
    }
}

export type LocalVideoHandleFileResult =
    | { ok: true; file: File }
    | { ok: false; reason: 'permission' | 'lost' | 'unsupported' };

interface FileHandleWithPermissions extends FileSystemFileHandle {
    queryPermission?: (options?: { mode?: 'read' }) => Promise<PermissionState>;
    requestPermission?: (options?: { mode?: 'read' }) => Promise<PermissionState>;
}

/**
 * Resolve a saved handle back into a File. Permission prompts belong to the
 * caller's click task; this function only asks when the browser reports
 * `prompt` (or has no permission API) and reuses an existing `granted`.
 */
export async function readLocalVideoFromHandle(
    handle: FileSystemFileHandle,
): Promise<LocalVideoHandleFileResult> {
    if (!handle || typeof handle.getFile !== 'function') {
        // A structured-cloned mock/foreign handle without methods: the record
        // exists, but this session cannot reopen it.
        return { ok: false, reason: 'unsupported' };
    }
    const withPermissions = handle as FileHandleWithPermissions;
    if (typeof withPermissions.queryPermission === 'function') {
        let permission: PermissionState;
        try {
            permission = await withPermissions.queryPermission({ mode: 'read' });
            if (permission !== 'granted' && typeof withPermissions.requestPermission === 'function') {
                permission = await withPermissions.requestPermission({ mode: 'read' });
            }
        } catch {
            return { ok: false, reason: 'permission' };
        }
        if (permission !== 'granted') return { ok: false, reason: 'permission' };
    }
    try {
        return { ok: true, file: await handle.getFile() };
    } catch (error) {
        if (
            typeof DOMException !== 'undefined'
            && error instanceof DOMException
            && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
        ) {
            return { ok: false, reason: 'permission' };
        }
        return { ok: false, reason: 'lost' };
    }
}
