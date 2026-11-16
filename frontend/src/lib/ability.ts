// CEFR ability-profile client (M1 / docs/项目计划-CEFR能力标定.md §7.4).
//
// Contract: GET /api/ability/profile, POST /api/ability/self-assess and
// GET /api/ability/can-do. Every request goes through `apiFetch` (guest cookie,
// optional API key, runtime language for localized content).
//
// Honesty rules owned by this module:
//   - the server's status/interval/note are passed through unchanged;
//   - a self-report never becomes a CEFR band (`self_report` keeps `cefr:null`);
//   - no interval is synthesized from a numeric estimate if the server did not
//     send one (`noEvidence` stays visibly empty);
//   - `se` / numeric confidence are typed for completeness but are never turned
//     into a point label or a percentage by the UI.
import { apiFetch } from './api';
import { getRuntimeLanguage, type LanguageCode } from '../i18n';
import { bundledSelfAssessItems, type BundledSelfAssessItem } from '../content/selfAssess';

export type AbilitySkillKey =
    | 'vocabulary'
    | 'grammar'
    | 'reading'
    | 'listening'
    | 'speaking'
    | 'writing';

export type AbilitySkillStatus =
    | 'uncalibrated'
    | 'measured'
    | 'estimated'
    | 'self_report'
    | 'insufficient'
    | 'not_measured';

export interface AbilityEstimate {
    low?: number | null;
    high?: number | null;
    /** `lemma` for the word-count interval. */
    unit?: string | null;
}

export interface AbilityPrecision {
    /** `high` / `medium` / `low` — already a label, never a raw score. */
    label?: string | null;
    se?: number | null;
}

export interface AbilityValidity {
    label?: string | null;
    flags?: string[] | null;
}

export interface AbilitySelfReport {
    /** Displayed with 「仅参考」; never copied into `cefr`. */
    band?: string | null;
    items?: number | null;
    caveat?: string | null;
}

export interface AbilitySkillProfile {
    status: AbilitySkillStatus | string;
    /** Point/representative level; null for self_report / insufficient. */
    cefr?: string | null;
    low?: string | null;
    high?: string | null;
    /** Pre-formatted interval, e.g. `A2–B2`. */
    label?: string | null;
    method?: string | null;
    evidenceCount?: number | null;
    precision?: AbilityPrecision | null;
    validity?: AbilityValidity | null;
    /** `high` / `medium` / `low` — rendered as a three-tier label. */
    evidenceStrength?: string | null;
    lastEvidenceAt?: number | null;
    stale?: boolean | null;
    estimate?: AbilityEstimate | null;
    note?: string | null;
    /** Reading (M1): number of reading items answered. */
    items?: number | null;
    selfReport?: AbilitySelfReport | null;
    /** Grammar (M3) only; non-null would be a contract violation in M1. */
    band?: string | null;
}

export interface AbilityComposite {
    derivedFrom?: string[] | null;
    cefr?: string | null;
    label?: string | null;
    status?: string | null;
    note?: string | null;
}

export interface AbilityInputOutputGap {
    available?: boolean;
    inputBand?: string | null;
    outputBand?: string | null;
    note?: string | null;
}

export interface AbilityCanDoEntryObject {
    id?: string;
    skill?: string;
    band?: string | null;
    /** Statement in the response language; one of these is present. */
    statement?: string;
    text?: string;
    statementZh?: string;
    statementVi?: string;
    /** `cefr-aligned` / `product-operational` (or a human-readable label). */
    basis?: string | null;
    source?: string | null;
    /** Observable condition; shown as a secondary line when present. */
    observable?: string | null;
    /** True when the server marks it as a generic (untested-skill) statement. */
    generic?: boolean;
}

export type AbilityCanDoEntry = string | AbilityCanDoEntryObject;

export interface AbilityCanDo {
    level?: string | null;
    /** Section-level basis/source note, if the server sends one. */
    basis?: string | null;
    note?: string | null;
    bySkill?: Record<string, AbilityCanDoEntry[]> | null;
}

/** `GET /api/ability/can-do` response (tolerant of the exact M1 shape). */
export interface AbilityCanDoResponse {
    level?: string | null;
    skill?: string | null;
    lang?: string | null;
    basis?: string | null;
    note?: string | null;
    items?: AbilityCanDoEntry[] | null;
    canDo?: AbilityCanDo | null;
}

export interface AbilityEvidence {
    id?: string | number;
    skill?: string | null;
    /** `placement_answer` / `self_assess` / `watch_behavior` / … */
    type?: string | null;
    observedAt?: number | null;
    band?: string | null;
    /** Server-provided qualitative result, e.g. 「答案落在 A2–B2」. */
    result?: string | null;
    weight?: number | null;
}

export interface AbilitySelfAssessItem {
    id: string;
    skill?: string | null;
    band?: string | null;
    statement: string;
}

export interface AbilitySelfAssessment {
    items?: AbilitySelfAssessItem[] | null;
    caveat?: string | null;
    status?: string | null;
}

export interface AbilityProfile {
    schemaVersion?: string | null;
    primary?: string | null;
    vocabulary?: AbilitySkillProfile | null;
    composite?: AbilityComposite | null;
    skills?: Partial<Record<'reading' | 'listening' | 'speaking' | 'writing', AbilitySkillProfile>> | null;
    grammar?: AbilitySkillProfile | null;
    inputOutputGap?: AbilityInputOutputGap | null;
    canDo?: AbilityCanDo | null;
    conflicts?: unknown[] | null;
    preliminary?: boolean;
    sampleSize?: number | null;
    calibrationVersion?: string | null;
    disclaimer?: string | null;
    updatedAt?: number | null;
    evidence?: AbilityEvidence[] | null;
    /** Localized self-assessment bank; absent on older servers (fallback used). */
    selfAssessment?: AbilitySelfAssessment | null;
}

export interface SelfAssessAnswerInput {
    itemId: string;
    /** 0 = not yet · 1 = barely · 2 = mostly · 3 = easily. */
    rating: number;
}

export interface SelfAssessInput {
    clientRequestId: string;
    answers: SelfAssessAnswerInput[];
    durationMs?: number;
    /** Response language for the embedded refreshed profile; defaults to UI lang. */
    lang?: LanguageCode;
}

export interface SelfAssessResponse {
    sessionId?: string | null;
    status?: string | null;
    reused?: boolean;
    evidenceAdded?: number | null;
    profile?: AbilityProfile | null;
    disclaimer?: string | null;
}

/** Typed HTTP failure so the screen can map 429 / 503 / 403 honestly. */
export class AbilityApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'AbilityApiError';
        this.status = status;
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await apiFetch(path, init);
    if (!response.ok) {
        throw new AbilityApiError(response.status, `HTTP ${response.status}`);
    }
    return (await response.json()) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accept both the documented top-level profile response and a defensive
 * `{profile: …}` wrapper. Unknown fields are left untouched: the UI reads only
 * what the contract names.
 */
function normalizeProfile(raw: unknown): AbilityProfile {
    if (!isRecord(raw)) return {};
    if (!isRecord(raw.vocabulary) && isRecord(raw.profile)) {
        return raw.profile as AbilityProfile;
    }
    return raw as AbilityProfile;
}

/** Current skill portrait + evidence summary + can-do + disclaimer. */
export async function getAbilityProfile(
    lang: LanguageCode = getRuntimeLanguage(),
): Promise<AbilityProfile> {
    const raw = await request<unknown>(`/api/ability/profile?lang=${encodeURIComponent(lang)}`);
    return normalizeProfile(raw);
}

/** Public can-do descriptors for one band × skill, already localized. */
export function getCanDo(
    level: string,
    skill: AbilitySkillKey | string,
    lang: LanguageCode = getRuntimeLanguage(),
): Promise<AbilityCanDoResponse> {
    const query = `level=${encodeURIComponent(level)}&skill=${encodeURIComponent(skill)}&lang=${encodeURIComponent(lang)}`;
    return request<AbilityCanDoResponse>(`/api/ability/can-do?${query}`);
}

/** Submit the 20-item self-assessment; the response embeds the refreshed profile. */
export function selfAssess(input: SelfAssessInput): Promise<SelfAssessResponse> {
    return request<SelfAssessResponse>('/api/ability/self-assess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            clientRequestId: input.clientRequestId,
            answers: input.answers.map(({ itemId, rating }) => ({ itemId, rating })),
            durationMs: input.durationMs,
            lang: input.lang ?? getRuntimeLanguage(),
        }),
    });
}

// ── Pure helpers shared by the screen ─────────────────────────────────────

/** `canDo.bySkill` entry → statement text, tolerating plain strings. */
export function canDoText(entry: AbilityCanDoEntry): string {
    if (typeof entry === 'string') return entry;
    return (
        entry.statement ||
        entry.text ||
        entry.statementZh ||
        entry.statementVi ||
        ''
    ).trim();
}

/** `canDo.bySkill` entry → basis token (`cefr-aligned` / `product-operational`). */
export function canDoBasis(entry: AbilityCanDoEntry): string | null {
    if (typeof entry === 'string') return null;
    return entry.basis?.trim() || null;
}

export function canDoObservable(entry: AbilityCanDoEntry): string | null {
    if (typeof entry === 'string') return null;
    return entry.observable?.trim() || null;
}

export function canDoSource(entry: AbilityCanDoEntry): string | null {
    if (typeof entry === 'string') return null;
    return entry.source?.trim() || null;
}

/**
 * Self-assessment bank: the server's localized content wins; when an older
 * backend omits it (or sends fewer than the 12-answer minimum), fall back to
 * the bundled 20-item content so the flow still works.
 */
export function resolveSelfAssessItems(
    profile: AbilityProfile | null,
    language: LanguageCode = getRuntimeLanguage(),
): AbilitySelfAssessItem[] {
    const rawItems: unknown[] = Array.isArray(profile?.selfAssessment?.items)
        ? profile.selfAssessment.items
        : [];
    const normalized: AbilitySelfAssessItem[] = rawItems
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
                id: typeof item.id === 'string' ? item.id.trim() : '',
                skill: typeof item.skill === 'string' ? item.skill : null,
                band: typeof item.band === 'string' ? item.band : null,
                statement: typeof item.statement === 'string' ? item.statement.trim() : '',
            }))
        .filter((item) => item.id.length > 0 && item.statement.length > 0);
    if (normalized.length >= 12) return normalized.slice(0, 20);
    return bundledSelfAssessItems(language).map((item: BundledSelfAssessItem) => ({ ...item }));
}
