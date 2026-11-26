// Identity-scoped browser storage (P2-50, cache audit /tmp/cache-audit/frontend.md §4).
//
// Why this module exists: before v1.1.1 every "user-private" localStorage key
// was a browser-wide singleton, so the next account on the same profile (or the
// next guest) inherited the previous identity's book/video/sentence progress.
// The backend session lives in an httpOnly cookie (one identity per browser
// profile), so the fix is a frontend namespace keyed by the identity that owns
// the cookie.
//
// Scope model (§4.2):
//   device  → device preferences only: layout / language / audio / toggles /
//             PWA counters / onboarding. Those keys stay **unscoped** and are
//             deliberately not routed through this module (audit P3-5).
//   guest   → shared by every guest session of this browser profile (same
//             semantics as the existing `ln_guest` cookie).
//   u:<id>  → a signed-in account, `id` is `GET /api/auth/me`'s user id.
//
// Key shape: `yt_bilingual.v2.<scope>.<name>`; sessionStorage uses
// `yt_bilingual.v2.session.<scope>.<name>`. The old (v1) keys are migrated once
// on the first boot of this module (§4.3) and then left untouched so a rollback
// to the previous build still sees its data.
//
// Attribution rule for legacy keys: an already-shared v1 device cannot tell
// which account produced a key, so the first identity that boots after the
// upgrade claims it (documented in specs/023 §缓存与本地数据). If that is a
// guest, the data is copied into the guest bucket and then merged into the
// first account that logs in on this profile (`mergeGuestScopeIntoUser`). The
// account page's 「清除本机学习数据」 button is the user-facing escape hatch.

/**
 * Which identity owns the current read/write namespace.
 *
 * `device` is intentionally only used for device-level data; user-private
 * stores must never be written under it (that would recreate the v1 bug).
 */
export type StorageScope = 'device' | 'guest' | `u:${string}`;

/** All v2 localStorage/sessionStorage keys share this prefix. */
export const STORAGE_V2_PREFIX = 'yt_bilingual.v2';
/** Written once, after the first legacy-key copy. Kept forever (idempotence). */
const MIGRATED_KEY = `${STORAGE_V2_PREFIX}.migrated`;
const SESSION_NAMESPACE = `${STORAGE_V2_PREFIX}.session`;

/**
 * Store names used by the `lib/*` modules. Kept here so the migration table and
 * the readers can never drift apart (a typo would silently orphan data).
 */
export const STORAGE_STORES = {
    progress: 'progress',
    booksProgress: 'books_progress',
    importedBooksProgress: 'imported_books_progress',
    vocabLevel: 'vocab_level',
    lastModel: 'last_model',
    guestMastered: 'guest_mastered_words',
} as const;

/** sessionStorage store names (tab-scoped: jobs, discover search state). */
export const SESSION_STORES = {
    pendingJob: 'pending_job',
    discoverLast: 'discover_last',
} as const;

/** Dynamic `sentence-lv<lv>-day<d>` / `sentence-lv<lv>-rev<d>` legacy keys. */
const SENTENCE_LEGACY_PATTERN = /^sentence-lv\d+-(?:day|rev)\d+$/;
const SENTENCE_STORE_PATTERN = /^sentence-lv\d+-(?:day|rev)\d+$/;

// v1 keys that belonged to a learner (copied to the booting identity).
const LEGACY_USER_STORES: readonly { legacyKey: string; name: string }[] = [
    { legacyKey: 'yt_bilingual_progress', name: STORAGE_STORES.progress },
    { legacyKey: 'yt_bilingual_books_progress', name: STORAGE_STORES.booksProgress },
    {
        legacyKey: 'yt_bilingual_imported_books_progress',
        name: STORAGE_STORES.importedBooksProgress,
    },
    { legacyKey: 'yt_bilingual_vocab_level', name: STORAGE_STORES.vocabLevel },
    { legacyKey: 'yt_bilingual_last_model', name: STORAGE_STORES.lastModel },
];

// Guest-only v1 stores: always copied to the guest bucket, never to a user.
const LEGACY_GUEST_STORES: readonly { legacyKey: string; name: string }[] = [
    {
        legacyKey: 'yt_bilingual_guest_mastered_words',
        name: STORAGE_STORES.guestMastered,
    },
];

// P0-1/P0-2 (P2-49) made the server the only source of favorites/subscriptions;
// the old global mirrors have no reader left and are private data, so the
// one-time migration deletes them instead of copying them into a new scope.
const OBSOLETE_PRIVATE_MIRRORS: readonly string[] = ['yt_bilingual_favorites', 'yt_bilingual_subs'];

const LEGACY_PENDING_JOB_KEY = 'yt_bilingual_pending_job';
const LEGACY_DISCOVER_PREFIX = 'yt_bilingual_discover_last:';

/** Stores that hold user-private *learning* data (cleared by the settings button). */
const LEARNING_STORE_NAMES: ReadonlySet<string> = new Set<string>([
    STORAGE_STORES.progress,
    STORAGE_STORES.booksProgress,
    STORAGE_STORES.importedBooksProgress,
    STORAGE_STORES.vocabLevel,
    STORAGE_STORES.lastModel,
    STORAGE_STORES.guestMastered,
]);

/** Legacy learning keys removed by 「清除本机学习数据」 (see clearLocalLearningData). */
const LEGACY_LEARNING_KEYS: ReadonlySet<string> = new Set<string>([
    ...LEGACY_USER_STORES.map((entry) => entry.legacyKey),
    ...LEGACY_GUEST_STORES.map((entry) => entry.legacyKey),
    ...OBSOLETE_PRIVATE_MIRRORS,
]);

interface MigrationRecord {
    at: number;
    scope: StorageScope;
    copied: string[];
    dropped: string[];
}

let currentScope: StorageScope = 'guest';
const scopeListeners = new Set<() => void>();

// ── scope ────────────────────────────────────────────────────────────────

export function currentStorageScope(): StorageScope {
    return currentScope;
}

export function isUserScope(scope: StorageScope = currentScope): scope is `u:${string}` {
    return scope.startsWith('u:');
}

/** The user id of a `u:<id>` scope, or `null` for guest/device scopes. */
export function userIdOfScope(scope: StorageScope): string | null {
    return scope.startsWith('u:') ? scope.slice(2) : null;
}

/**
 * Activate an identity namespace.
 *
 * Overloads mirror the audit API: `setStorageScope('user', id)` /
 * `setStorageScope('guest' | 'device')`. An empty user id degrades to `guest`
 * (never to device: private stores must not share a device bucket).
 *
 * Called by `AuthProvider` before it publishes the new status, so the first
 * render under a new identity already reads the right namespace (§4.2).
 */
export function setStorageScope(next: 'guest' | 'device'): void;
export function setStorageScope(next: 'user', userId: string): void;
export function setStorageScope(next: 'guest' | 'device' | 'user', userId?: string): void {
    const normalized: StorageScope =
        next === 'user' ? (userId ? `u:${userId}` : 'guest') : next;
    const changed = normalized !== currentScope;
    currentScope = normalized;
    const migrated = migrateLegacyOnce();
    clearForeignSessionKeys();
    // Notify when the namespace changed, or on the first boot when the one-time
    // migration copied legacy values into the (unchanged) guest bucket: mounted
    // readers such as the model bar must re-read them.
    if (!changed && !migrated) return;
    for (const listener of scopeListeners) {
        try {
            listener();
        } catch {
            // A broken listener must not stop the others.
        }
    }
}

/**
 * Subscribe to scope activation (migration may have changed the visible data).
 * Returns an unsubscribe function.
 */
export function subscribeStorageScope(listener: () => void): () => void {
    scopeListeners.add(listener);
    return () => {
        scopeListeners.delete(listener);
    };
}

// ── keys & storage primitives ────────────────────────────────────────────

function localStorageSafe(): Storage | null {
    try {
        return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
        return null;
    }
}

function sessionStorageSafe(): Storage | null {
    try {
        return typeof window === 'undefined' ? null : window.sessionStorage;
    } catch {
        return null;
    }
}

export function keyForScope(scope: StorageScope, name: string): string {
    return `${STORAGE_V2_PREFIX}.${scope}.${name}`;
}

/** localStorage key of `name` under the active identity. */
export function scopedKey(name: string): string {
    return keyForScope(currentScope, name);
}

/** sessionStorage key of `name` under the active identity. */
export function sessionScopedKey(name: string): string {
    return `${SESSION_NAMESPACE}.${currentScope}.${name}`;
}

function parseJSON<T>(raw: string | null, fallback: T): T {
    if (raw === null) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

/** JSON read from the active scope; corrupted values fall back (never throw). */
export function readScoped<T>(name: string, fallback: T): T {
    const store = localStorageSafe();
    if (!store) return fallback;
    try {
        return parseJSON(store.getItem(scopedKey(name)), fallback);
    } catch {
        return fallback;
    }
}

/** JSON write to the active scope (quota/private mode degrade silently). */
export function writeScoped(name: string, value: unknown): void {
    const store = localStorageSafe();
    if (!store) return;
    try {
        store.setItem(scopedKey(name), JSON.stringify(value));
    } catch {
        // Storage full / blocked: progress is a convenience, never a blocker.
    }
}

/** Raw-string read (settings flags and sentence marks are plain strings). */
export function readScopedText(name: string): string | null {
    const store = localStorageSafe();
    if (!store) return null;
    try {
        return store.getItem(scopedKey(name));
    } catch {
        return null;
    }
}

export function writeScopedText(name: string, value: string): void {
    const store = localStorageSafe();
    if (!store) return;
    try {
        store.setItem(scopedKey(name), value);
    } catch {
        // Non-fatal: the in-memory state still applies for this session.
    }
}

export function removeScoped(name: string): void {
    const store = localStorageSafe();
    if (!store) return;
    try {
        store.removeItem(scopedKey(name));
    } catch {
        // Nothing to do.
    }
}

export function hasScoped(name: string): boolean {
    const store = localStorageSafe();
    if (!store) return false;
    try {
        return store.getItem(scopedKey(name)) !== null;
    } catch {
        return false;
    }
}

export function readScopedSession<T>(name: string, fallback: T): T {
    const store = sessionStorageSafe();
    if (!store) return fallback;
    try {
        return parseJSON(store.getItem(sessionScopedKey(name)), fallback);
    } catch {
        return fallback;
    }
}

export function writeScopedSession(name: string, value: unknown): void {
    const store = sessionStorageSafe();
    if (!store) return;
    try {
        store.setItem(sessionScopedKey(name), JSON.stringify(value));
    } catch {
        // Losing a pending job only costs a manual resubmit.
    }
}

export function removeScopedSession(name: string): void {
    const store = sessionStorageSafe();
    if (!store) return;
    try {
        store.removeItem(sessionScopedKey(name));
    } catch {
        // Nothing to do.
    }
}

function storageKeys(store: Storage | null): string[] {
    if (!store) return [];
    const keys: string[] = [];
    try {
        for (let i = 0; i < store.length; i += 1) {
            const key = store.key(i);
            if (key) keys.push(key);
        }
    } catch {
        // Private mode: treat as empty.
    }
    return keys;
}

function clearKeysWithPrefix(store: Storage | null, prefix: string): number {
    if (!store) return 0;
    let removed = 0;
    for (const key of storageKeys(store)) {
        if (!key.startsWith(prefix)) continue;
        try {
            store.removeItem(key);
            removed += 1;
        } catch {
            // Ignore: a stuck key is not worth failing the whole clear.
        }
    }
    return removed;
}

// ── one-time legacy migration (§4.3) ─────────────────────────────────────

/**
 * Copy v1 keys into the identity that booted first. Idempotent: the marker is
 * only informational — each individual copy also requires the target key to be
 * absent, so a failed marker write cannot duplicate or overwrite data.
 */
function migrateLegacyOnce(): boolean {
    const store = localStorageSafe();
    if (!store) return false;
    let marker: MigrationRecord | null = null;
    try {
        marker = parseJSON<MigrationRecord | null>(store.getItem(MIGRATED_KEY), null);
    } catch {
        marker = null;
    }
    if (marker) return false;

    const copied: string[] = [];
    const dropped: string[] = [];

    // Guest-only tables always land in the guest bucket, even when the first
    // boot after the upgrade is already signed in (an account never reads them).
    for (const { legacyKey, name } of LEGACY_GUEST_STORES) {
        if (copyLegacyKey(store, legacyKey, 'guest', name)) copied.push(legacyKey);
    }

    // Learner data belongs to the identity that boots first (documented rule).
    for (const { legacyKey, name } of LEGACY_USER_STORES) {
        if (copyLegacyKey(store, legacyKey, currentScope, name)) copied.push(legacyKey);
    }

    // Dynamic sentence keys (one key per level/day + one per review grid).
    for (const legacyKey of storageKeys(store)) {
        if (!SENTENCE_LEGACY_PATTERN.test(legacyKey)) continue;
        if (copyLegacyKey(store, legacyKey, currentScope, legacyKey)) copied.push(legacyKey);
    }

    // Tab-scoped state: attribute it to the tab's current identity, then drop
    // the unattributed v1 copies (they can never be safely attributed later).
    copied.push(...migrateLegacySessionState());

    for (const legacyKey of OBSOLETE_PRIVATE_MIRRORS) {
        try {
            if (store.getItem(legacyKey) !== null) {
                store.removeItem(legacyKey);
                dropped.push(legacyKey);
            }
        } catch {
            // Ignore: a leftover mirror has no reader in this build.
        }
    }

    const record: MigrationRecord = {
        at: Date.now(),
        scope: currentScope,
        copied: Array.from(new Set(copied)),
        dropped,
    };
    try {
        store.setItem(MIGRATED_KEY, JSON.stringify(record));
    } catch {
        // Retried on the next boot; the per-key copy guard keeps it idempotent.
    }
    return record.copied.length > 0 || record.dropped.length > 0;
}

/** Copy one raw v1 value into `scope` unless the target already exists. */
function copyLegacyKey(
    store: Storage,
    legacyKey: string,
    scope: StorageScope,
    name: string,
): boolean {
    const target = keyForScope(scope, name);
    try {
        const raw = store.getItem(legacyKey);
        if (raw === null || store.getItem(target) !== null) return false;
        store.setItem(target, raw);
        return true;
    } catch {
        return false;
    }
}

function migrateLegacySessionState(): string[] {
    const store = sessionStorageSafe();
    if (!store) return [];
    const copied: string[] = [];
    try {
        const pending = store.getItem(LEGACY_PENDING_JOB_KEY);
        if (pending !== null) {
            const target = sessionScopedKey(SESSION_STORES.pendingJob);
            if (store.getItem(target) === null) {
                store.setItem(target, pending);
                copied.push(LEGACY_PENDING_JOB_KEY);
            }
            store.removeItem(LEGACY_PENDING_JOB_KEY);
        }
        for (const key of storageKeys(store)) {
            if (!key.startsWith(LEGACY_DISCOVER_PREFIX)) continue;
            const language = key.slice(LEGACY_DISCOVER_PREFIX.length);
            const name = `${SESSION_STORES.discoverLast}:${language}`;
            const target = sessionScopedKey(name);
            const raw = store.getItem(key);
            if (raw !== null && store.getItem(target) === null) {
                store.setItem(target, raw);
                copied.push(key);
            }
            store.removeItem(key);
        }
    } catch {
        // sessionStorage unavailable: nothing to migrate.
    }
    return copied;
}

/**
 * Drop sessionStorage entries that belong to another identity. Tab-scoped state
 * (pending job, last discover search) must never survive an account switch
 * (§4.4); unlike learning progress it is not worth preserving across reloads.
 */
export function clearForeignSessionKeys(): void {
    const store = sessionStorageSafe();
    if (!store) return;
    const keepPrefix = `${SESSION_NAMESPACE}.${currentScope}.`;
    const allPrefix = `${SESSION_NAMESPACE}.`;
    for (const key of storageKeys(store)) {
        if (key.startsWith(allPrefix) && !key.startsWith(keepPrefix)) {
            try {
                store.removeItem(key);
            } catch {
                // Ignore.
            }
        }
    }
    // Legacy (v1) tab keys can no longer be attributed to an identity: the
    // migration above already copied the ones that booted with the v2 build.
    try {
        store.removeItem(LEGACY_PENDING_JOB_KEY);
    } catch {
        // Ignore.
    }
    for (const key of storageKeys(store)) {
        if (!key.startsWith(LEGACY_DISCOVER_PREFIX)) continue;
        try {
            store.removeItem(key);
        } catch {
            // Ignore.
        }
    }
}

// ── guest → account claim merge (§4.3) ───────────────────────────────────

export interface GuestMergeResult {
    /** Store names that were merged into the account bucket. */
    merged: string[];
    /** True when the guest bucket was emptied after a complete merge. */
    cleared: boolean;
    /** Target keys that could not be written (quota/private mode). */
    failed: string[];
    /**
     * Guest marks that are intentionally dropped: 「我会了」 is local-only for
     * guests and has no server equivalent at claim time (§4.3 recommendation).
     */
    droppedGuestMastered: boolean;
}

/**
 * Merge the guest bucket into `u:<userId>` and clear it.
 *
 * Merge rules (audit §4.3): progress maps keep the newer `updated` entry;
 * sentence day marks and review grids are OR-ed; learned settings (level/model)
 * keep the account's own value and only fall back to the guest value. Everything
 * else in the guest bucket is session-level and is discarded by the clear.
 *
 * The clear only runs when every write succeeded, so a quota error can never
 * silently delete the only copy.
 */
export function mergeGuestScopeIntoUser(userId: string): GuestMergeResult {
    const result: GuestMergeResult = {
        merged: [],
        cleared: false,
        failed: [],
        droppedGuestMastered: false,
    };
    const store = localStorageSafe();
    if (!store || !userId) return result;

    const guestScope: StorageScope = 'guest';
    const userScope: StorageScope = `u:${userId}`;
    const guestPrefix = `${STORAGE_V2_PREFIX}.${guestScope}.`;
    const guestNames = storageKeys(store)
        .filter((key) => key.startsWith(guestPrefix))
        .map((key) => key.slice(guestPrefix.length))
        .filter(Boolean);
    if (guestNames.length === 0) {
        // Nothing to merge; still clear stale guest session state.
        clearGuestScope();
        result.cleared = true;
        return result;
    }

    const mapStores: readonly string[] = [
        STORAGE_STORES.progress,
        STORAGE_STORES.booksProgress,
        STORAGE_STORES.importedBooksProgress,
    ];
    for (const name of guestNames) {
        try {
            if (mapStores.includes(name)) {
                if (mergeProgressMap(store, guestScope, userScope, name)) result.merged.push(name);
                continue;
            }
            if (SENTENCE_STORE_PATTERN.test(name)) {
                if (mergeSentenceMark(store, guestScope, userScope, name)) result.merged.push(name);
                continue;
            }
            if (name === STORAGE_STORES.vocabLevel || name === STORAGE_STORES.lastModel) {
                if (mergeTextWhenMissing(store, guestScope, userScope, name)) result.merged.push(name);
                continue;
            }
            if (name === STORAGE_STORES.guestMastered) {
                result.droppedGuestMastered = true;
            }
        } catch {
            result.failed.push(name);
        }
    }

    if (result.failed.length === 0) {
        clearGuestScope();
        result.cleared = true;
    }
    return result;
}

function mergeProgressMap(
    store: Storage,
    guestScope: StorageScope,
    userScope: StorageScope,
    name: string,
): boolean {
    const guestRaw = store.getItem(keyForScope(guestScope, name));
    if (guestRaw === null) return false;
    const guestMap = parseJSON<Record<string, unknown>>(guestRaw, {});
    if (!isRecord(guestMap) || Object.keys(guestMap).length === 0) return false;
    const userRaw = store.getItem(keyForScope(userScope, name));
    const parsedUser = parseJSON<unknown>(userRaw, {});
    const userMap: Record<string, unknown> = isRecord(parsedUser) ? parsedUser : {};
    for (const [id, entry] of Object.entries(guestMap)) {
        if (!isRecord(entry)) continue;
        const existing = userMap[id];
        const guestUpdated = numberOr(entry.updated, 0);
        const userUpdated = isRecord(existing) ? numberOr(existing.updated, 0) : -1;
        if (!isRecord(existing) || guestUpdated > userUpdated) userMap[id] = entry;
    }
    store.setItem(keyForScope(userScope, name), JSON.stringify(userMap));
    return true;
}

function mergeSentenceMark(
    store: Storage,
    guestScope: StorageScope,
    userScope: StorageScope,
    name: string,
): boolean {
    const guestValue = store.getItem(keyForScope(guestScope, name));
    if (guestValue === null) return false;
    const userValue = store.getItem(keyForScope(userScope, name));
    if (userValue === null) {
        store.setItem(keyForScope(userScope, name), guestValue);
        return true;
    }
    // Day marks are "1"/"0"; review grids are 4-char strings of the same kind.
    const length = Math.max(userValue.length, guestValue.length);
    let merged = '';
    for (let i = 0; i < length; i += 1) {
        merged += userValue[i] === '1' || guestValue[i] === '1' ? '1' : '0';
    }
    if (merged !== userValue) store.setItem(keyForScope(userScope, name), merged);
    return true;
}

function mergeTextWhenMissing(
    store: Storage,
    guestScope: StorageScope,
    userScope: StorageScope,
    name: string,
): boolean {
    const guestValue = store.getItem(keyForScope(guestScope, name));
    if (guestValue === null || guestValue === '') return false;
    const userValue = store.getItem(keyForScope(userScope, name));
    if (userValue !== null && userValue !== '') return false;
    store.setItem(keyForScope(userScope, name), guestValue);
    return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Remove every guest-scoped key (learning + tab state). */
export function clearGuestScope(): void {
    const prefix = `${STORAGE_V2_PREFIX}.guest.`;
    clearKeysWithPrefix(localStorageSafe(), prefix);
    clearKeysWithPrefix(sessionStorageSafe(), `${SESSION_NAMESPACE}.guest.`);
}

// ── user-facing escape hatch (account · settings) ────────────────────────

/**
 * 「清除本机学习数据」: remove this browser's learning data for every identity
 * (book/video/sentence progress, guest mastered table, level/model choice,
 * tab-scoped discover/job state). Device preferences (layout, language, audio,
 * toggles, PWA counters, onboarding) are deliberately kept.
 *
 * Every identity is cleared because the v1 → v2 attribution rule above can put
 * another account's data under this device's first-boot namespace; a
 * single-scope clear could leave the user unable to self-heal.
 *
 * Returns the number of storage entries removed; the caller reloads the page
 * (mounted components keep their in-memory copies otherwise).
 */
export function clearLocalLearningData(): number {
    const local = localStorageSafe();
    const session = sessionStorageSafe();
    let removed = 0;

    const isLearningName = (name: string): boolean =>
        LEARNING_STORE_NAMES.has(name) || SENTENCE_STORE_PATTERN.test(name);

    for (const key of storageKeys(local)) {
        if (key.startsWith(`${STORAGE_V2_PREFIX}.`) && !key.startsWith(`${STORAGE_V2_PREFIX}.session.`)) {
            const rest = key.slice(`${STORAGE_V2_PREFIX}.`.length);
            const dot = rest.indexOf('.');
            if (dot === -1) continue;
            const name = rest.slice(dot + 1);
            if (isLearningName(name)) removed += removeKey(local, key);
            continue;
        }
        if (LEGACY_LEARNING_KEYS.has(key) || SENTENCE_LEGACY_PATTERN.test(key)) {
            removed += removeKey(local, key);
        }
    }

    for (const key of storageKeys(session)) {
        if (key.startsWith(`${SESSION_NAMESPACE}.`)) {
            const rest = key.slice(`${SESSION_NAMESPACE}.`.length);
            const dot = rest.indexOf('.');
            if (dot === -1) continue;
            const name = rest.slice(dot + 1);
            if (name === SESSION_STORES.pendingJob || name.startsWith(`${SESSION_STORES.discoverLast}:`)) {
                removed += removeKey(session, key);
            }
            continue;
        }
        if (key === LEGACY_PENDING_JOB_KEY || key.startsWith(LEGACY_DISCOVER_PREFIX)) {
            removed += removeKey(session, key);
        }
    }

    return removed;
}

function removeKey(store: Storage | null, key: string): number {
    if (!store) return 0;
    try {
        store.removeItem(key);
        return 1;
    } catch {
        return 0;
    }
}

/** Test/debug helper: the migration record written on first boot. */
export function readMigrationRecord(): MigrationRecord | null {
    const store = localStorageSafe();
    return store ? parseJSON<MigrationRecord | null>(store.getItem(MIGRATED_KEY), null) : null;
}
