// Balance / AI-cost money helpers (M3b, specs/034).
//
// The backend stores every balance as an INTEGER micro-USD (1 USD =
// 1,000,000 µUSD) and never sends money as a JSON float. The UI must keep the
// same rule: format from the integer field (`*MicroUsd`, or the integer part
// of the admin ledger), never from `balanceUsd` strings or float math, so a
// balance like 3,720 µUSD renders as `$0.00372` instead of `$0.004`.
//
// `formatUsdNumber` is the one place that formats the legacy float
// `monthSpendUsd` estimate (an analytical value, not a bill).
import { getLanguageMeta, getRuntimeLanguage, type LanguageCode } from '../i18n';

export const MICRO_USD_PER_USD = 1_000_000;

/** Max precision the admin balance API accepts for a USD string. */
export const MAX_USD_FRACTION_DIGITS = 6;
/** Admin single-adjustment cap (`MAX_ADMIN_BALANCE_DELTA_MICRO_USD` = $100). */
export const MAX_ADMIN_BALANCE_DELTA_MICRO_USD = 100_000_000;
export const MAX_ADMIN_BALANCE_DELTA_USD = '100.00';

const USD_INPUT_RE = /^\d+(\.\d{1,6})?$/;

function decimalSeparator(locale: string): string {
  try {
    const part = new Intl.NumberFormat(locale)
      .formatToParts(1.1)
      .find((item) => item.type === 'decimal');
    return part?.value ?? '.';
  } catch {
    return '.';
  }
}

function groupInteger(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  } catch {
    return String(value);
  }
}

function microUsdParts(microUsd: number): {
  negative: boolean;
  whole: number;
  fraction: string;
} {
  const raw = Number(microUsd);
  const value = Number.isFinite(raw) ? Math.trunc(raw) : 0;
  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / MICRO_USD_PER_USD);
  const remainder = abs - whole * MICRO_USD_PER_USD;
  // 2–6 fraction digits, with no floating point involved: the remainder is an
  // integer number of µUSD, padded to 6 digits before trailing zeros are cut.
  let fraction = String(remainder).padStart(6, '0').replace(/0+$/, '');
  if (fraction.length < 2) fraction = fraction.padEnd(2, '0');
  return { negative, whole, fraction };
}

/**
 * Integer µUSD → localized `$` string with 2–6 decimals, exact (no float
 * rounding): `2_000_000 → "$2.00"`, `3_720 → "$0.00372"`,
 * `-500_000 → "-$0.50"`.
 */
export function formatMicroUsd(
  microUsd: number,
  language: LanguageCode = getRuntimeLanguage(),
): string {
  const { negative, whole, fraction } = microUsdParts(microUsd);
  const locale = getLanguageMeta(language).locale;
  const sign = negative ? '-' : '';
  return `${sign}$${groupInteger(whole, locale)}${decimalSeparator(locale)}${fraction}`;
}

/** Plain integer µUSD with grouping, for the secondary `µUSD` label. */
export function formatMicroUsdAmount(
  microUsd: number,
  language: LanguageCode = getRuntimeLanguage(),
): string {
  const raw = Number(microUsd);
  const value = Number.isFinite(raw) ? Math.trunc(raw) : 0;
  return groupInteger(value, getLanguageMeta(language).locale);
}

/**
 * Format the legacy float estimate (`monthSpendUsd` / `estimatedCostUsd`).
 * These are analytical values, not ledger money; 2 decimals normally and up
 * to 4 for sub-cent amounts, matching the pre-M3 account page.
 */
export function formatUsdNumber(
  value: number,
  language: LanguageCode = getRuntimeLanguage(),
): string {
  if (!Number.isFinite(value)) return '$0.00';
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  const locale = getLanguageMeta(language).locale;
  try {
    const number = new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
    return `$${number}`;
  } catch {
    return `$${value.toFixed(digits)}`;
  }
}

/**
 * Exact USD string (`"2.00"`, `"0.00372"`) → integer µUSD. Returns `null` for
 * anything the backend would reject: non-string decimals, more than 6 digits,
 * zero/negative, scientific notation. Never goes through `parseFloat`.
 */
export function parseUsdStringToMicroUsd(text: string): number | null {
  const trimmed = String(text ?? '').trim();
  if (!USD_INPUT_RE.test(trimmed)) return null;
  const [wholeText, fractionText = ''] = trimmed.split('.');
  const whole = Number(wholeText);
  const fraction = Number(fractionText.padEnd(MAX_USD_FRACTION_DIGITS, '0'));
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(fraction)) return null;
  const microUsd = whole * MICRO_USD_PER_USD + fraction;
  if (!Number.isSafeInteger(microUsd) || microUsd <= 0) return null;
  return microUsd;
}

/** Did the user type a syntactically valid USD amount (≤6 decimals, > 0)? */
export function isValidUsdInput(text: string): boolean {
  return parseUsdStringToMicroUsd(text) !== null;
}

/**
 * A UUID for the admin adjustment idempotency key. `crypto.randomUUID` is
 * available in every browser Playwright drives; the fallback keeps the key
 * inside the backend's allowed alphabet (`[A-Za-z0-9._:-]`, ≤120 chars).
 */
export function createIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const random = () => Math.floor(Math.random() * 0xffffffff).toString(36);
  return `ui-${Date.now().toString(36)}-${random()}${random()}`;
}

// ── User summary (GET /api/user/summary, M3a fields) ──────────────────────

export interface UserBalanceFields {
  /** Book balance (integer µUSD); may be negative after an overrun settlement. */
  balanceMicroUsd: number;
  balanceUsd: string;
  /** Book balance minus active holds. */
  availableMicroUsd: number;
  availableUsd: string;
  activeHoldsMicroUsd: number;
  /** Frozen pre-M3 `users.credits` unit; never a billing amount. */
  creditsLegacy?: number;
}

// ── Admin: user ledger (GET /api/admin/users/{id}/ledger) ─────────────────

export type LedgerKind =
  | 'signup_bonus'
  | 'signup_bonus_backfill'
  | 'admin_topup'
  | 'admin_deduct'
  | 'ai_settle'
  | 'ai_refund'
  | 'adjustment'
  | 'legacy_snapshot'
  | (string & {});

export interface AdminLedgerEntry {
  id: string;
  kind: LedgerKind;
  deltaMicroUsd: number;
  deltaUsd: string;
  balanceAfterMicroUsd: number;
  balanceAfterUsd: string;
  refType: string | null;
  refId: string | null;
  reason: string | null;
  /** Admin user id for manual adjustments; null for system entries. */
  actorId: string | null;
  /** Never rendered — kept out of the UI (support/debug via backend only). */
  idempotencyKey: string | null;
  createdAtMs: number;
}

export interface AdminLedgerUser {
  id: string;
  email: string;
  username: string | null;
  status: string;
}

export interface AdminLedgerPage {
  user: AdminLedgerUser;
  balanceMicroUsd: number;
  balanceUsd: string;
  availableMicroUsd: number;
  availableUsd: string;
  activeHoldsMicroUsd: number;
  entries: AdminLedgerEntry[];
  total: number;
  limit: number;
  offset: number;
}

// ── Admin: billing summary (GET /api/admin/billing/summary) ───────────────

export interface AdminBillingGroupRow {
  key: string;
  costMicroUsd: number;
  costUsd: string;
  calls: number;
  rows: number;
  unbilledRows: number;
}

export interface AdminBillingModelRow extends AdminBillingGroupRow {
  modelId: string;
  provider: string | null;
}

export interface AdminBillingTotals {
  rows: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Real money deducted from balances (µUSD). */
  billedCostMicroUsd: number;
  billedCostUsd: string;
  /** Legacy directory-price estimate — analysis only, not a bill. */
  estimatedCostUsd: number;
  /** Rows without a price (unbilled/legacy) — never charged. */
  unbilledRows: number;
  /** Pre-0025 historical rows. */
  legacyRows: number;
  /** Settlement failures that still need retry/reconciliation. */
  settleFailedRows: number;
}

export interface AdminBillingSummary {
  from: string | null;
  to: string | null;
  totals: AdminBillingTotals;
  byDay: AdminBillingGroupRow[];
  byModel: AdminBillingModelRow[];
  byFeature: AdminBillingGroupRow[];
  /** Historical: models with at least one unpriced row in range; `billable=0`, never charged (and never back-charged). */
  unpricedModels: string[];
  /** Current: catalog models whose `billing.price_for_model()` is still null (independent of history). */
  currentUnpricedModels: string[];
  holds: { activeCount: number; activeMicroUsd: number; activeUsd: string };
  balances: {
    usersWithBalance: number;
    totalMicroUsd: number;
    totalUsd: string;
    ledgerDeltaMicroUsd: number;
  };
  prices: Array<{
    modelId: string;
    provider: string;
    inputMicroUsdPerMtok: number;
    outputMicroUsdPerMtok: number;
    priceVersion: string;
    sourceKind: string;
    sourceRef: string | null;
    verifiedAtMs: number;
  }>;
}

// ── Admin: manual balance adjustment ──────────────────────────────────────

export type AdminBalanceDirection = 'credit' | 'debit';

export interface AdminBalanceAdjustResult {
  userId: string;
  ledgerId: string;
  kind: LedgerKind;
  deltaMicroUsd: number;
  replayed: boolean;
  balanceMicroUsd: number;
  balanceUsd: string;
  availableMicroUsd: number;
  availableUsd: string;
}
