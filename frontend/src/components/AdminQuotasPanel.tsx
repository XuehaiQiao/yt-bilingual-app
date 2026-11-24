// Admin console — daily AI quota tab (specs/047-quota-admin, P2-30).
//
// Two cards, both backed by `lib/admin.ts`:
//   * global defaults — the 8 quota features (`QUOTA_FEATURES`), their current
//     default, where that value comes from (backend default vs env/config) and
//     a read-only daily budget summary. Saving only submits the rows that
//     actually changed; a row can also be reset to inherit env (`null`).
//   * single user — search (8-result cap) → pick a user → default / override /
//     effective / used / remaining / source per feature. An empty override
//     means "inherit", `0` means "disabled", and every write needs a 1–200
//     character reason (audited by the backend).
//
// `0` is never formatted as a bare zero: it means the feature is off, and the
// UI says so. Layout follows the console contract: tables own their horizontal
// scroll (`<Table minWidth>`), the page itself never overflows at 375px.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CircleCheck,
  RotateCcw,
  Search,
  TriangleAlert,
  UserRound,
  Wallet,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { displayUsername } from '../lib/username';
import { formatUsdNumber } from '../lib/billing';
import {
  AdminApiError,
  adminFeatureLabel,
  fetchAdminQuotas,
  fetchAdminUserQuotas,
  fetchAdminUsers,
  updateAdminQuotaDefaults,
  updateAdminUserQuotas,
  type AdminQuotaDefaults,
  type AdminQuotaSource,
  type AdminQuotaUser,
  type AdminQuotaUserFeature,
  type AdminUserRow,
} from '../lib/admin';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { ErrorPanel, LoadingState } from './ui/StateView';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from './ui/Table';
import { tabPanelProps } from './ui/Tabs';

/** Backend `quota_config.MAX_LIMIT`: `0` = off, no "unlimited". */
const MAX_QUOTA_LIMIT = 1_000_000;
const MAX_REASON_CHARS = 200;
const SEARCH_LIMIT = 8;
const SEARCH_DEBOUNCE_MS = 300;

type TFunc = (key: TranslationKey, params?: Record<string, string | number>) => string;

type LimitDraft = { kind: 'inherit' } | { kind: 'value'; value: number } | { kind: 'invalid' };

function parseLimitText(raw: string): LimitDraft {
  const text = raw.trim();
  if (text === '') return { kind: 'inherit' };
  if (!/^\d+$/.test(text)) return { kind: 'invalid' };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_QUOTA_LIMIT) {
    return { kind: 'invalid' };
  }
  return { kind: 'value', value };
}

function isAuthError(error: unknown): boolean {
  return (
    error instanceof AdminApiError && (error.status === 401 || error.status === 403)
  );
}

/** Localized status-specific copy; backend detail strings are never rendered. */
function quotaErrorText(error: unknown, t: TFunc, fallback: TranslationKey): string {
  if (error instanceof AdminApiError) {
    if (error.status === 400) return t('admin.quotas.error.badRequest');
    if (error.status === 404) return t('admin.quotas.error.notFound');
    if (error.status === 503) return t('admin.quotas.error.unavailable');
  }
  return t(fallback);
}

function validReason(text: string): boolean {
  const length = Array.from(text.trim()).length;
  return length >= 1 && length <= MAX_REASON_CHARS;
}

function initialDefaultDraft(data: AdminQuotaDefaults): Record<string, string | null> {
  return Object.fromEntries(
    data.features.map((row) => [row.feature, String(row.defaultLimit)]),
  );
}

function initialOverrideDraft(data: AdminQuotaUser): Record<string, string> {
  return Object.fromEntries(
    data.features.map((row) => [
      row.feature,
      row.overrideLimit === null ? '' : String(row.overrideLimit),
    ]),
  );
}

function QuotaSourceBadge({
  source,
  testId,
}: {
  source: AdminQuotaSource;
  testId: string;
}) {
  const { t } = useI18n();
  const key: TranslationKey = source === 'user_override'
    ? 'admin.quotas.source.user_override'
    : source === 'default'
      ? 'admin.quotas.source.default'
      : 'admin.quotas.source.config';
  return (
    <Badge tone={source === 'user_override' ? 'brand' : 'neutral'} testId={testId}>
      {t(key)}
    </Badge>
  );
}

function LimitValue({
  limit,
  testId,
}: {
  limit: number;
  testId: string;
}) {
  const { t, formatNumber } = useI18n();
  if (limit === 0) {
    return (
      <Badge tone="warning" testId={testId}>
        {t('admin.quotas.off')}
      </Badge>
    );
  }
  return (
    <span data-testid={testId} className="tabular-nums">
      {formatNumber(limit)}
    </span>
  );
}

export interface AdminQuotasPanelProps {
  /** Bumped by the console refresh button to refetch both cards. */
  refreshNonce: number;
  onAuthError: () => void;
}

export function AdminQuotasPanel({ refreshNonce, onAuthError }: AdminQuotasPanelProps) {
  const { t, language, formatNumber } = useI18n();

  // ── Global defaults ─────────────────────────────────────────────────
  const [defaults, setDefaults] = useState<AdminQuotaDefaults | null>(null);
  const [defaultsLoading, setDefaultsLoading] = useState(true);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [defaultDraft, setDefaultDraft] = useState<Record<string, string | null>>({});
  const [defaultsSaving, setDefaultsSaving] = useState(false);
  const [defaultsSaveError, setDefaultsSaveError] = useState<string | null>(null);
  const [defaultsSaved, setDefaultsSaved] = useState(false);
  const defaultsRequestRef = useRef(0);

  const applyDefaults = useCallback((data: AdminQuotaDefaults) => {
    setDefaults(data);
    setDefaultDraft(initialDefaultDraft(data));
    setDefaultsSaved(false);
    setDefaultsSaveError(null);
  }, []);

  const loadDefaults = useCallback(async () => {
    const requestId = ++defaultsRequestRef.current;
    setDefaultsLoading(true);
    setDefaultsError(null);
    try {
      const data = await fetchAdminQuotas();
      if (requestId !== defaultsRequestRef.current) return;
      applyDefaults(data);
    } catch (error) {
      if (requestId !== defaultsRequestRef.current) return;
      if (isAuthError(error)) {
        onAuthError();
        return;
      }
      setDefaultsError(quotaErrorText(error, t, 'admin.quotas.defaults.loadError'));
    } finally {
      if (requestId === defaultsRequestRef.current) setDefaultsLoading(false);
    }
  }, [applyDefaults, onAuthError, t]);

  useEffect(() => {
    void loadDefaults();
  }, [loadDefaults, refreshNonce]);

  const defaultsAnalysis = useMemo(() => {
    const changes: Record<string, number | null> = {};
    const invalid: string[] = [];
    if (!defaults) return { changes, invalid, dirty: false };
    for (const row of defaults.features) {
      const draft = defaultDraft[row.feature];
      if (draft === undefined) continue;
      // The table always displays the *effective default* (stored value, or the
      // env value when nothing is stored), so that number is the baseline.
      // Typing it back is not a change; only a stored default can be reverted.
      if (draft === null) {
        if (row.source === 'default') changes[row.feature] = null;
        continue;
      }
      const parsed = parseLimitText(draft);
      if (parsed.kind !== 'value') {
        invalid.push(row.feature);
        continue;
      }
      if (parsed.value !== row.defaultLimit) changes[row.feature] = parsed.value;
    }
    return {
      changes,
      invalid,
      dirty: Object.keys(changes).length > 0 || invalid.length > 0,
    };
  }, [defaultDraft, defaults]);

  const updateDefaultDraft = (feature: string, value: string) => {
    setDefaultDraft((previous) => ({ ...previous, [feature]: value }));
    setDefaultsSaved(false);
    setDefaultsSaveError(null);
  };

  const revertDefaultRow = (feature: string) => {
    setDefaultDraft((previous) => ({ ...previous, [feature]: null }));
    setDefaultsSaved(false);
    setDefaultsSaveError(null);
  };

  const revertAllDefaults = () => {
    if (!defaults) return;
    setDefaultDraft(
      Object.fromEntries(defaults.features.map((row) => [row.feature, null])),
    );
    setDefaultsSaved(false);
    setDefaultsSaveError(null);
  };

  const saveDefaults = async () => {
    if (!defaults || defaultsSaving) return;
    if (defaultsAnalysis.invalid.length > 0) {
      setDefaultsSaveError(t('admin.quotas.error.invalidValues'));
      return;
    }
    if (Object.keys(defaultsAnalysis.changes).length === 0) return;
    setDefaultsSaving(true);
    setDefaultsSaveError(null);
    setDefaultsSaved(false);
    try {
      const data = await updateAdminQuotaDefaults(defaultsAnalysis.changes);
      applyDefaults(data);
      setDefaultsSaved(true);
    } catch (error) {
      if (isAuthError(error)) {
        onAuthError();
        return;
      }
      setDefaultsSaveError(quotaErrorText(error, t, 'admin.quotas.defaults.saveError'));
    } finally {
      setDefaultsSaving(false);
    }
  };

  // ── Single-user quotas ──────────────────────────────────────────────
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<AdminUserRow[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchRequestRef = useRef(0);

  const [selectedUser, setSelectedUser] = useState<{
    id: string;
    label: string;
    email: string | null;
  } | null>(null);
  const [userQuotas, setUserQuotas] = useState<AdminQuotaUser | null>(null);
  const [userLoading, setUserLoading] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  const [overrideDraft, setOverrideDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [userSaving, setUserSaving] = useState(false);
  const [userSaveError, setUserSaveError] = useState<string | null>(null);
  const [userSaved, setUserSaved] = useState<'saved' | 'cleared' | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  // Snapshot the override count when the dialog opens: the live count drops to
  // 0 after a successful clear while the dialog is still animating out.
  const [clearCount, setClearCount] = useState(0);
  const userRequestRef = useRef(0);

  const applyUserQuotas = useCallback((data: AdminQuotaUser) => {
    setUserQuotas(data);
    setOverrideDraft(initialOverrideDraft(data));
    setUserSaveError(null);
    setUserSaved(null);
  }, []);

  const loadUserQuotas = useCallback(
    async (userId: string) => {
      const requestId = ++userRequestRef.current;
      setUserLoading(true);
      setUserError(null);
      try {
        const data = await fetchAdminUserQuotas(userId);
        if (requestId !== userRequestRef.current) return;
        applyUserQuotas(data);
      } catch (error) {
        if (requestId !== userRequestRef.current) return;
        if (isAuthError(error)) {
          onAuthError();
          return;
        }
        setUserError(quotaErrorText(error, t, 'admin.quotas.users.loadError'));
      } finally {
        if (requestId === userRequestRef.current) setUserLoading(false);
      }
    },
    [applyUserQuotas, onAuthError, t],
  );

  useEffect(() => {
    const query = searchText.trim();
    if (!query) {
      searchRequestRef.current += 1;
      setSearchResults(null);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      const requestId = ++searchRequestRef.current;
      void (async () => {
        try {
          const page = await fetchAdminUsers({ search: query, limit: SEARCH_LIMIT });
          if (requestId !== searchRequestRef.current) return;
          setSearchResults(page.users);
          setSearchError(null);
        } catch (error) {
          if (requestId !== searchRequestRef.current) return;
          if (isAuthError(error)) {
            onAuthError();
            return;
          }
          setSearchResults(null);
          setSearchError(quotaErrorText(error, t, 'admin.quotas.error.search'));
        } finally {
          if (requestId === searchRequestRef.current) setSearchLoading(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [onAuthError, searchText, t]);

  useEffect(() => {
    if (!selectedUser) {
      userRequestRef.current += 1;
      setUserQuotas(null);
      setUserLoading(false);
      setUserError(null);
      setOverrideDraft({});
      return;
    }
    void loadUserQuotas(selectedUser.id);
  }, [loadUserQuotas, refreshNonce, selectedUser]);

  const selectUser = (row: AdminUserRow) => {
    setSelectedUser({
      id: row.userId,
      label: displayUsername(row.username, row.email),
      email: row.email ?? null,
    });
    setSearchText('');
    setSearchResults(null);
    setSearchError(null);
    setUserQuotas(null);
    setOverrideDraft({});
    setUserError(null);
    setUserSaveError(null);
    setUserSaved(null);
    setReason('');
  };

  const overrideAnalysis = useMemo(() => {
    const changes: Record<string, number | null> = {};
    const invalid: string[] = [];
    if (!userQuotas) return { changes, invalid, dirty: false };
    for (const row of userQuotas.features) {
      const draft = overrideDraft[row.feature] ?? '';
      const parsed = parseLimitText(draft);
      if (parsed.kind === 'invalid') {
        invalid.push(row.feature);
        continue;
      }
      const intended = parsed.kind === 'inherit' ? null : parsed.value;
      if (intended !== row.overrideLimit) changes[row.feature] = intended;
    }
    return {
      changes,
      invalid,
      dirty: Object.keys(changes).length > 0 || invalid.length > 0,
    };
  }, [overrideDraft, userQuotas]);

  const updateOverrideDraft = (feature: string, value: string) => {
    setOverrideDraft((previous) => ({ ...previous, [feature]: value }));
    setUserSaved(null);
    setUserSaveError(null);
  };

  const overrideCount = userQuotas
    ? userQuotas.features.filter((row) => row.overrideLimit !== null).length
    : 0;
  const reasonCount = Array.from(reason).length;

  const validateUserWrite = (): string | null => {
    if (overrideAnalysis.invalid.length > 0) {
      return t('admin.quotas.error.invalidValues');
    }
    if (!validReason(reason)) return t('admin.quotas.error.reason');
    return null;
  };

  const saveUserQuotas = async () => {
    if (!userQuotas || userSaving) return;
    if (Object.keys(overrideAnalysis.changes).length === 0) return;
    const validationError = validateUserWrite();
    if (validationError) {
      setUserSaveError(validationError);
      return;
    }
    setUserSaving(true);
    setUserSaveError(null);
    setUserSaved(null);
    try {
      const data = await updateAdminUserQuotas(userQuotas.user.id, {
        overrides: overrideAnalysis.changes,
        reason: reason.trim(),
      });
      applyUserQuotas(data);
      setReason('');
      setUserSaved('saved');
    } catch (error) {
      if (isAuthError(error)) {
        onAuthError();
        return;
      }
      setUserSaveError(quotaErrorText(error, t, 'admin.quotas.users.saveError'));
    } finally {
      setUserSaving(false);
    }
  };

  const clearUserOverrides = async () => {
    if (!userQuotas) return;
    const cleared: Record<string, null> = {};
    for (const row of userQuotas.features) {
      if (row.overrideLimit !== null) cleared[row.feature] = null;
    }
    if (Object.keys(cleared).length === 0) return;
    const validationError = validateUserWrite();
    if (validationError) {
      setUserSaveError(validationError);
      throw new Error(validationError);
    }
    try {
      const data = await updateAdminUserQuotas(userQuotas.user.id, {
        overrides: cleared,
        reason: reason.trim(),
      });
      applyUserQuotas(data);
      setReason('');
      setUserSaved('cleared');
    } catch (error) {
      if (isAuthError(error)) {
        onAuthError();
        throw new Error(t('admin.error.forbidden'));
      }
      const message = quotaErrorText(error, t, 'admin.quotas.users.saveError');
      setUserSaveError(message);
      throw new Error(message);
    }
  };

  const requestClearOverrides = () => {
    if (!userQuotas || overrideCount === 0) return;
    const validationError = validateUserWrite();
    if (validationError) {
      setUserSaveError(validationError);
      return;
    }
    setClearCount(overrideCount);
    setClearOpen(true);
  };

  const defaultsRevertible = defaults
    ? defaults.features.some(
      (row) => defaultDraft[row.feature] === null || row.source === 'default',
    )
    : false;
  const selectedStatus = userQuotas?.user.status ?? null;

  return (
    <section
      {...tabPanelProps('admin', 'quotas')}
      data-testid="admin-panel-quotas"
      className="mt-6 space-y-6"
    >
      <div className="min-w-0">
        <h2
          id="admin-quotas-title"
          className="text-section font-semibold tracking-tight text-fg-primary"
        >
          {t('admin.quotas.title')}
        </h2>
        <p className="mt-1 max-w-2xl text-caption leading-relaxed text-fg-secondary">
          {t('admin.quotas.subtitle')}
        </p>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-3">
        {/* ── Global defaults ─────────────────────────────────────────── */}
        <Card
          variant="card"
          className="min-w-0 xl:col-span-2"
          title={t('admin.quotas.defaults.title')}
          description={t('admin.quotas.defaults.subtitle')}
          icon={RotateCcw}
          testId="admin-quota-defaults"
          footer={
            defaults ? (
              <>
                <Button
                  variant="primary"
                  size="md"
                  loading={defaultsSaving}
                  loadingLabel={t('admin.quotas.defaults.saving')}
                  iconLeft={defaultsSaving ? undefined : <Check aria-hidden="true" />}
                  onClick={() => {
                    void saveDefaults();
                  }}
                  disabled={!defaultsAnalysis.dirty}
                  testId="admin-quota-defaults-save"
                >
                  {t('admin.quotas.defaults.save')}
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  iconLeft={<RotateCcw aria-hidden="true" />}
                  onClick={revertAllDefaults}
                  disabled={!defaultsRevertible || defaultsSaving}
                  testId="admin-quota-defaults-reset"
                >
                  {t('admin.quotas.defaults.reset')}
                </Button>
                {defaultsAnalysis.dirty && !defaultsSaving && (
                  <span
                    data-testid="admin-quota-defaults-dirty"
                    className="text-caption text-warning-fg"
                  >
                    {t('admin.quotas.defaults.dirty')}
                  </span>
                )}
                {defaultsSaved && (
                  <span
                    role="status"
                    data-testid="admin-quota-defaults-saved"
                    className="inline-flex items-center gap-1 text-caption text-success-fg"
                  >
                    <CircleCheck aria-hidden="true" className="h-3.5 w-3.5" />
                    {t('admin.quotas.defaults.saved')}
                  </span>
                )}
              </>
            ) : undefined
          }
        >
          {defaultsError ? (
            <ErrorPanel
              level="inline"
              title={defaultsError}
              onRetry={() => {
                void loadDefaults();
              }}
              retryLabel={t('admin.retry')}
              retryTestId="admin-quota-defaults-retry"
              testId="admin-quota-defaults-load-error"
            />
          ) : defaultsLoading && !defaults ? (
            <LoadingState
              kind="skeleton"
              rows={6}
              label={t('admin.quotas.defaults.loading')}
              testId="admin-quota-defaults-loading"
            />
          ) : defaults ? (
            <>
              <div className="rounded-control border border-line-subtle overflow-hidden">
                <Table
                  testId="admin-quota-defaults-table"
                  minWidth={640}
                  caption={t('admin.quotas.defaults.title')}
                >
                  <TableHeader>
                    <tr>
                      <TableHeaderCell nowrap>{t('admin.quotas.col.feature')}</TableHeaderCell>
                      <TableHeaderCell nowrap>{t('admin.quotas.col.default')}</TableHeaderCell>
                      <TableHeaderCell nowrap>{t('admin.quotas.col.source')}</TableHeaderCell>
                      <TableHeaderCell align="right" nowrap>
                        {t('admin.quotas.col.restore')}
                      </TableHeaderCell>
                    </tr>
                  </TableHeader>
                  <TableBody>
                    {defaults.features.map((row) => {
                      const label = adminFeatureLabel(row.feature, t);
                      // `null` is the pending "fall back to env" marker; keep it
                      // distinct from an empty string (which is invalid input).
                      const draft = defaultDraft[row.feature] ?? null;
                      const parsed = draft === null ? null : parseLimitText(draft);
                      const invalid = parsed?.kind === 'invalid';
                      const zero = parsed?.kind === 'value' && parsed.value === 0;
                      return (
                        <TableRow key={row.feature} data-testid="admin-quota-default-row">
                          <TableCell nowrap>
                            <span className="font-medium text-fg-strong">{label}</span>
                          </TableCell>
                          <TableCell>
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                              <span className={`inline-flex rounded-control border bg-surface-2/60 focus-within:ring-2 focus-within:ring-brand/60 ${
                                  invalid ? 'border-danger/50' : 'border-line-subtle'
                                }`}>
                                <input
                                  className="h-control-md w-24 rounded-control bg-transparent px-2 text-ui tabular-nums text-fg-strong outline-none"
                                  type="text"
                                  inputMode="numeric"
                                  autoComplete="off"
                                  value={draft ?? ''}
                                  placeholder={
                                    draft === null
                                      ? t('admin.quotas.defaults.revertPendingShort')
                                      : '0–1000000'
                                  }
                                  aria-label={`${t('admin.quotas.col.default')} · ${label}`}
                                  aria-invalid={invalid || undefined}
                                  data-testid="admin-quota-default-input"
                                  onChange={(event) =>
                                    updateDefaultDraft(row.feature, event.target.value)
                                  }
                                />
                              </span>
                              {zero && (
                                <Badge tone="warning" testId="admin-quota-default-off">
                                  {t('admin.quotas.off')}
                                </Badge>
                              )}
                              {draft === null && (
                                <span
                                  data-testid="admin-quota-default-revert-pending"
                                  className="text-micro text-warning-fg"
                                >
                                  {t('admin.quotas.defaults.revertPending')}
                                </span>
                              )}
                              {invalid && (
                                <span className="text-micro text-danger-fg">
                                  {t('admin.quotas.error.invalidValue')}
                                </span>
                              )}
                            </span>
                          </TableCell>
                          <TableCell>
                            <QuotaSourceBadge
                              source={row.source}
                              testId="admin-quota-default-source"
                            />
                          </TableCell>
                          <TableCell align="right">
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              iconLeft={<RotateCcw aria-hidden="true" />}
                              ariaLabel={t('admin.quotas.defaults.restoreRow', { feature: label })}
                              onClick={() => revertDefaultRow(row.feature)}
                              disabled={row.source === 'config' || defaultsSaving}
                              testId="admin-quota-default-restore"
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {defaultsAnalysis.invalid.length > 0 && (
                <p
                  role="alert"
                  data-testid="admin-quota-defaults-validation"
                  className="mt-3 flex items-start gap-1.5 text-caption leading-relaxed text-danger-fg"
                >
                  <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {t('admin.quotas.error.invalidValues')}:{' '}
                    {defaultsAnalysis.invalid
                      .map((feature) => adminFeatureLabel(feature, t))
                      .join('、')}
                  </span>
                </p>
              )}
              {defaultsSaveError && (
                <p
                  role="alert"
                  data-testid="admin-quota-defaults-error"
                  className="mt-3 flex items-start gap-1.5 text-caption leading-relaxed text-danger-fg"
                >
                  <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{defaultsSaveError}</span>
                </p>
              )}
              <p className="mt-3 text-micro leading-relaxed text-fg-muted">
                {t('admin.quotas.defaults.envNote')}
              </p>
            </>
          ) : null}
        </Card>

        {/* ── Budgets (read-only this phase) ──────────────────────────── */}
        <Card
          variant="card"
          className="min-w-0"
          title={t('admin.quotas.budgets.title')}
          description={t('admin.quotas.budgets.hint')}
          icon={Wallet}
          testId="admin-quota-budgets"
        >
          <dl className="grid min-w-0 grid-cols-1 gap-3">
            <div className="min-w-0 rounded-control border border-line-subtle bg-surface-2/30 px-3 py-2">
              <dt className="text-caption text-fg-secondary">
                {t('admin.quotas.budgets.user')}
              </dt>
              <dd
                data-testid="admin-quota-budget-user"
                className="mt-1 text-section font-semibold tabular-nums text-fg-primary"
              >
                {defaults ? formatUsdNumber(defaults.budgets.userDailyUsd, language) : '—'}
              </dd>
            </div>
            <div className="min-w-0 rounded-control border border-line-subtle bg-surface-2/30 px-3 py-2">
              <dt className="text-caption text-fg-secondary">
                {t('admin.quotas.budgets.global')}
              </dt>
              <dd
                data-testid="admin-quota-budget-global"
                className="mt-1 text-section font-semibold tabular-nums text-fg-primary"
              >
                {defaults ? formatUsdNumber(defaults.budgets.globalDailyUsd, language) : '—'}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-micro leading-relaxed text-fg-muted">
            {t('admin.quotas.budgets.note')}
          </p>
        </Card>
      </div>

      {/* ── Single user ───────────────────────────────────────────────── */}
      <Card
        variant="card"
        className="min-w-0"
        title={t('admin.quotas.users.title')}
        description={t('admin.quotas.users.subtitle')}
        icon={UserRound}
        testId="admin-quota-user-card"
        footer={
          userQuotas ? (
            <>
              <Button
                variant="primary"
                size="md"
                loading={userSaving}
                loadingLabel={t('admin.quotas.users.saving')}
                iconLeft={userSaving ? undefined : <Check aria-hidden="true" />}
                onClick={() => {
                  void saveUserQuotas();
                }}
                disabled={!overrideAnalysis.dirty}
                testId="admin-quota-user-save"
              >
                {t('admin.quotas.users.save')}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={requestClearOverrides}
                disabled={overrideCount === 0 || userSaving}
                testId="admin-quota-user-clear"
              >
                {t('admin.quotas.users.clear')}
              </Button>
              {overrideAnalysis.dirty && !userSaving && (
                <span
                  data-testid="admin-quota-user-dirty"
                  className="text-caption text-warning-fg"
                >
                  {t('admin.quotas.users.dirty')}
                </span>
              )}
              {userSaved && (
                <span
                  role="status"
                  data-testid="admin-quota-user-saved"
                  className="inline-flex items-center gap-1 text-caption text-success-fg"
                >
                  <CircleCheck aria-hidden="true" className="h-3.5 w-3.5" />
                  {userSaved === 'cleared'
                    ? t('admin.quotas.users.cleared')
                    : t('admin.quotas.users.saved')}
                </span>
              )}
            </>
          ) : undefined
        }
      >
        <div className="min-w-0">
          <label className="relative block min-w-0 max-w-md rounded-control-lg focus-within:ring-2 focus-within:ring-brand/60">
            <span className="sr-only">{t('admin.quotas.users.searchAria')}</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            />
            <input
              className="h-control-lg w-full rounded-control-lg border border-line-subtle bg-surface-2/60 pl-9 pr-3 text-ui text-fg-strong placeholder:text-fg-muted outline-none"
              type="search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={t('admin.quotas.users.searchPlaceholder')}
              aria-label={t('admin.quotas.users.searchAria')}
              data-testid="admin-quota-user-search"
            />
          </label>
          <p className="mt-1 text-micro text-fg-muted">
            {t('admin.quotas.users.searchHint', { limit: formatNumber(SEARCH_LIMIT) })}
          </p>

          {searchLoading && (
            <LoadingState
              size="sm"
              label={t('admin.quotas.users.searching')}
              testId="admin-quota-user-search-loading"
              className="mt-2"
            />
          )}
          {searchError && (
            <p
              role="alert"
              data-testid="admin-quota-search-error"
              className="mt-2 flex items-start gap-1.5 text-caption leading-relaxed text-danger-fg"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{searchError}</span>
            </p>
          )}
          {searchResults && searchResults.length > 0 && (
            <ul
              data-testid="admin-quota-user-results"
              className="mt-2 max-w-md divide-y divide-line-subtle overflow-hidden rounded-control border border-line-subtle bg-surface-2/40"
            >
              {searchResults.map((row) => (
                <li key={row.userId} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => selectUser(row)}
                    data-testid="admin-quota-user-option"
                    className="flex w-full min-w-0 items-center justify-between gap-3 px-3 py-2 text-left transition-colors duration-200 ease-apple hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-brand/60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-ui font-medium text-fg-strong">
                        {displayUsername(row.username, row.email)}
                      </span>
                      <span className="block truncate text-caption text-fg-secondary">
                        {row.email}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-micro text-fg-muted">{row.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {searchResults && searchResults.length === 0 && !searchLoading && (
            <p
              data-testid="admin-quota-search-empty"
              className="mt-2 text-caption text-fg-muted"
            >
              {t('admin.quotas.users.searchEmpty')}
            </p>
          )}

          {selectedUser && (
            <div
              data-testid="admin-quota-user-selected"
              className="mt-3 flex min-w-0 flex-wrap items-center gap-2 rounded-control border border-line-subtle bg-surface-2/40 px-3 py-2"
            >
              <UserRound aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
              <span className="min-w-0 truncate text-ui font-medium text-fg-strong">
                {userQuotas?.user.username
                  ? displayUsername(userQuotas.user.username, userQuotas.user.email)
                  : selectedUser.label}
              </span>
              {selectedUser.email && (
                <span className="min-w-0 truncate text-caption text-fg-secondary">
                  {selectedUser.email}
                </span>
              )}
              {selectedStatus && (
                <Badge
                  tone={selectedStatus === 'banned' ? 'danger' : 'success'}
                  testId="admin-quota-user-status"
                >
                  {selectedStatus === 'banned'
                    ? t('admin.users.statusBanned')
                    : selectedStatus === 'active'
                      ? t('admin.users.statusActive')
                      : selectedStatus}
                </Badge>
              )}
            </div>
          )}

          {userLoading && !userQuotas ? (
            <LoadingState
              kind="skeleton"
              rows={6}
              label={t('admin.quotas.users.loading')}
              testId="admin-quota-user-loading"
              className="mt-3"
            />
          ) : null}

          {userError && (
            <div className="mt-3">
              <ErrorPanel
                level="inline"
                title={userError}
                onRetry={
                  selectedUser
                    ? () => {
                      void loadUserQuotas(selectedUser.id);
                    }
                    : undefined
                }
                retryLabel={t('admin.retry')}
                retryTestId="admin-quota-user-retry"
                testId="admin-quota-user-load-error"
              />
            </div>
          )}

          {userQuotas && !userError ? (
            <>
              <div className="mt-3 rounded-control border border-line-subtle overflow-hidden">
                <Table
                  testId="admin-quota-user-table"
                  minWidth={880}
                  caption={t('admin.quotas.users.title')}
                >
                  <TableHeader>
                    <tr>
                      <TableHeaderCell nowrap>{t('admin.quotas.col.feature')}</TableHeaderCell>
                      <TableHeaderCell numeric nowrap>
                        {t('admin.quotas.users.col.default')}
                      </TableHeaderCell>
                      <TableHeaderCell nowrap>{t('admin.quotas.users.col.override')}</TableHeaderCell>
                      <TableHeaderCell numeric nowrap>
                        {t('admin.quotas.users.col.effective')}
                      </TableHeaderCell>
                      <TableHeaderCell numeric nowrap>
                        {t('admin.quotas.users.col.used')}
                      </TableHeaderCell>
                      <TableHeaderCell numeric nowrap>
                        {t('admin.quotas.users.col.remaining')}
                      </TableHeaderCell>
                      <TableHeaderCell nowrap>{t('admin.quotas.col.source')}</TableHeaderCell>
                    </tr>
                  </TableHeader>
                  <TableBody>
                    {userQuotas.features.map((row: AdminQuotaUserFeature) => {
                      const label = adminFeatureLabel(row.feature, t);
                      const draft = overrideDraft[row.feature] ?? '';
                      const parsed = parseLimitText(draft);
                      const invalid = parsed.kind === 'invalid';
                      const overrideDisabled = parsed.kind === 'value' && parsed.value === 0;
                      return (
                        <TableRow key={row.feature} data-testid="admin-quota-user-row">
                          <TableCell nowrap>
                            <span className="font-medium text-fg-strong">{label}</span>
                          </TableCell>
                          <TableCell numeric nowrap>
                            <LimitValue
                              limit={row.defaultLimit}
                              testId="admin-quota-user-default"
                            />
                          </TableCell>
                          <TableCell>
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                              <span className={`inline-flex rounded-control border bg-surface-2/60 focus-within:ring-2 focus-within:ring-brand/60 ${
                                  invalid ? 'border-danger/50' : 'border-line-subtle'
                                }`}>
                                <input
                                  className="h-control-sm w-20 rounded-control bg-transparent px-2 text-caption tabular-nums text-fg-strong outline-none"
                                  type="text"
                                  inputMode="numeric"
                                  autoComplete="off"
                                  value={draft}
                                  placeholder={t('admin.quotas.users.inherit')}
                                  aria-label={`${t('admin.quotas.users.col.override')} · ${label}`}
                                  aria-invalid={invalid || undefined}
                                  data-testid="admin-quota-user-override"
                                  onChange={(event) =>
                                    updateOverrideDraft(row.feature, event.target.value)
                                  }
                                />
                              </span>
                              {overrideDisabled && (
                                <Badge tone="warning" testId="admin-quota-user-override-off">
                                  {t('admin.quotas.off')}
                                </Badge>
                              )}
                              {invalid && (
                                <span className="text-micro text-danger-fg">
                                  {t('admin.quotas.error.invalidValue')}
                                </span>
                              )}
                            </span>
                          </TableCell>
                          <TableCell numeric nowrap>
                            <LimitValue
                              limit={row.effectiveLimit}
                              testId="admin-quota-user-effective"
                            />
                          </TableCell>
                          <TableCell numeric nowrap>
                            <span data-testid="admin-quota-user-used" className="tabular-nums">
                              {formatNumber(row.usedToday)}
                            </span>
                          </TableCell>
                          <TableCell numeric nowrap>
                            <span
                              data-testid="admin-quota-user-remaining"
                              className="tabular-nums"
                            >
                              {formatNumber(row.remaining)}
                            </span>
                          </TableCell>
                          <TableCell>
                            <QuotaSourceBadge
                              source={row.source}
                              testId="admin-quota-user-source"
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <div className="mt-4 max-w-md">
                <label htmlFor="admin-quota-user-reason" className="block min-w-0">
                  <span className="flex flex-wrap items-center justify-between gap-2 text-caption text-fg-secondary">
                    <span>{t('admin.quotas.users.reason')}</span>
                    <span className="tabular-nums text-fg-muted">
                      {t('admin.quotas.users.reasonCount', {
                        count: formatNumber(reasonCount),
                        max: formatNumber(MAX_REASON_CHARS),
                      })}
                    </span>
                  </span>
                  <span className="mt-1 block rounded-control-lg focus-within:ring-2 focus-within:ring-brand/60">
                    <input
                      className="h-control-lg w-full rounded-control-lg border border-line-subtle bg-surface-2/60 px-3 text-ui text-fg-strong placeholder:text-fg-muted outline-none"
                      id="admin-quota-user-reason"
                      type="text"
                      value={reason}
                      maxLength={MAX_REASON_CHARS}
                      onChange={(event) => {
                        setReason(event.target.value);
                        setUserSaved(null);
                        setUserSaveError(null);
                      }}
                      placeholder={t('admin.quotas.users.reasonPlaceholder')}
                      data-testid="admin-quota-user-reason"
                    />
                  </span>
                </label>
                <p className="mt-1 text-micro leading-relaxed text-fg-muted">
                  {t('admin.quotas.users.reasonHint')}
                </p>
              </div>

              {userSaveError && (
                <p
                  role="alert"
                  data-testid="admin-quota-user-error"
                  className="mt-3 flex items-start gap-1.5 text-caption leading-relaxed text-danger-fg"
                >
                  <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{userSaveError}</span>
                </p>
              )}
            </>
          ) : null}

          {!selectedUser && !searchLoading && !searchResults && (
            <p
              data-testid="admin-quota-user-empty"
              className="mt-4 rounded-control border border-dashed border-line-subtle px-3 py-6 text-center text-caption text-fg-muted"
            >
              {t('admin.quotas.users.empty')}
            </p>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={clearOpen}
        title={t('admin.quotas.users.clearConfirmTitle', {
          count: formatNumber(clearCount),
        })}
        description={t('admin.quotas.users.clearConfirmDesc', {
          count: formatNumber(clearCount),
        })}
        confirmLabel={t('admin.quotas.users.clearConfirmAction')}
        onConfirm={clearUserOverrides}
        onClose={() => setClearOpen(false)}
        testId="admin-quota-clear-confirm"
      />
    </section>
  );
}
