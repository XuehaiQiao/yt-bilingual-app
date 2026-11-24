// Admin console — feedback inbox tab (specs/048-feedback-quota, P2-42).
//
// One card backed by `GET|PATCH /api/admin/feedback` (`lib/admin.ts`):
//   * filter open / resolved / all — the API has no offset, so the card always
//     reads the most recent `limit` (50) rows and the footer states the total;
//   * table shows status / category / message / user-or-guest / requestId /
//     page / submitted time; the row action expands an inline editor that can
//     set status (open / resolved) and the admin note, then PATCHes and re-reads
//     the list (a resolved row leaves the open filter immediately);
//   * loading / error / empty are mutually exclusive branches: an error never
//     renders as an empty list, and stale rows stay visible behind a retryable
//     inline error (A3 IX-01 / IX-04).
//
// 0033 has no `page` column — the submission page only reaches the server log —
// so that column renders "未记录" instead of inventing a value; the hint under
// the table says so. `adminNote` is trimmed before saving and an empty editor
// sends `null` (clear). The backend requires at least one of status/adminNote,
// which is why Save is disabled until a draft actually differs from the row.
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ChevronDown,
  CircleCheck,
  Inbox,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { FEEDBACK_CATEGORIES } from '../lib/feedback';
import {
  AdminApiError,
  fetchAdminFeedback,
  updateAdminFeedback,
  type AdminFeedbackPage,
  type AdminFeedbackRow,
  type AdminFeedbackStatusFilter,
  type AdminFeedbackUpdateInput,
} from '../lib/admin';
import { Badge, type BadgeTone } from './ui/Badge';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { EmptyState, ErrorPanel, LoadingState } from './ui/StateView';
import { Segmented, type SegmentedOption } from './ui/Segmented';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from './ui/Table';
import { tabPanelProps } from './ui/Tabs';

/** Backend `feedback.DEFAULT_LIST_LIMIT`; also the UI's single page size. */
const FEEDBACK_PAGE_SIZE = 50;
/** Backend `feedback.ADMIN_NOTE_MAX`. */
const ADMIN_NOTE_MAX = 2000;
/** Table column count, for the expanded detail row's colSpan. */
const COLUMN_COUNT = 8;

type TFunc = (key: TranslationKey, params?: Record<string, string | number>) => string;

type StatusDraft = 'open' | 'resolved' | '';

const STATUS_LABEL_KEYS: Record<string, TranslationKey> = {
  open: 'admin.feedback.status.open',
  in_progress: 'admin.feedback.status.in_progress',
  resolved: 'admin.feedback.status.resolved',
  closed: 'admin.feedback.status.closed',
};

const STATUS_TONES: Record<string, BadgeTone> = {
  open: 'warning',
  in_progress: 'brand',
  resolved: 'success',
  closed: 'neutral',
};

const CATEGORY_LABEL_KEYS = new Map<string, TranslationKey>(
  FEEDBACK_CATEGORIES.map((category) => [category.id, category.labelKey]),
);

const EMPTY_TITLE_KEYS: Record<AdminFeedbackStatusFilter, TranslationKey> = {
  open: 'admin.feedback.empty.open',
  resolved: 'admin.feedback.empty.resolved',
  all: 'admin.feedback.empty.all',
};

function isAuthError(error: unknown): boolean {
  return error instanceof AdminApiError && (error.status === 401 || error.status === 403);
}

/** Localized status label; an unknown server status stays as its raw value. */
function feedbackStatusLabel(status: string, t: TFunc): string {
  const key = STATUS_LABEL_KEYS[status];
  return key ? t(key) : status;
}

function feedbackCategoryLabel(category: string, t: TFunc): string {
  const key = CATEGORY_LABEL_KEYS.get(category);
  return key ? t(key) : category;
}

/** Backend status errors get copy of their own; the raw detail is never shown. */
function feedbackErrorText(error: unknown, t: TFunc, fallback: TranslationKey): string {
  if (error instanceof AdminApiError) {
    if (error.status === 400) return t('admin.feedback.saveError.badRequest');
    if (error.status === 404) return t('admin.feedback.saveError.notFound');
    if (error.status === 503) return t('admin.feedback.saveError.unavailable');
  }
  return t(fallback);
}

function isBinaryStatus(status: string): status is 'open' | 'resolved' {
  return status === 'open' || status === 'resolved';
}

function shortUserId(userId: string | null): string | null {
  const text = (userId ?? '').trim();
  return text ? text.slice(0, 8) : null;
}

export interface AdminFeedbackPanelProps {
  /** Bumped by the console refresh button to refetch the current filter. */
  refreshNonce: number;
  onAuthError: () => void;
}

export function AdminFeedbackPanel({ refreshNonce, onAuthError }: AdminFeedbackPanelProps) {
  const { t, formatNumber, formatDate } = useI18n();

  const [filter, setFilter] = useState<AdminFeedbackStatusFilter>('open');
  const [page, setPage] = useState<AdminFeedbackPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [draftStatus, setDraftStatus] = useState<StatusDraft>('');
  const [draftNote, setDraftNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const load = useCallback(async (nextFilter: AdminFeedbackStatusFilter) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchAdminFeedback({
        status: nextFilter,
        limit: FEEDBACK_PAGE_SIZE,
      });
      if (requestId !== requestRef.current) return;
      setPage(data);
    } catch (error) {
      if (requestId !== requestRef.current) return;
      if (isAuthError(error)) {
        onAuthError();
        return;
      }
      setLoadError(feedbackErrorText(error, t, 'admin.feedback.loadError'));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [onAuthError, t]);

  useEffect(() => {
    void load(filter);
  }, [filter, load, refreshNonce]);

  const changeFilter = (next: AdminFeedbackStatusFilter) => {
    setFilter(next);
    setExpandedId(null);
    setSaveError(null);
    setSavedNotice(null);
  };

  const collapse = () => {
    setExpandedId(null);
    setSaveError(null);
  };

  const expand = (row: AdminFeedbackRow) => {
    if (expandedId === row.id) {
      collapse();
      return;
    }
    setExpandedId(row.id);
    // Only the two binary states are selectable; in_progress/closed rows start
    // with no selection so a note-only save never silently rewrites the status.
    setDraftStatus(isBinaryStatus(row.status) ? row.status : '');
    setDraftNote(row.adminNote ?? '');
    setSaveError(null);
    setSavedNotice(null);
  };

  const rowNoteDirty = (row: AdminFeedbackRow) => draftNote.trim() !== (row.adminNote ?? '');
  const rowStatusDirty = (row: AdminFeedbackRow) =>
    draftStatus !== '' && draftStatus !== row.status;
  const rowDirty = (row: AdminFeedbackRow) => rowNoteDirty(row) || rowStatusDirty(row);

  const saveRow = async (row: AdminFeedbackRow) => {
    if (saving || !rowDirty(row)) return;
    const payload: AdminFeedbackUpdateInput = {};
    if (isBinaryStatus(draftStatus) && draftStatus !== row.status) {
      payload.status = draftStatus;
    }
    if (rowNoteDirty(row)) {
      payload.adminNote = draftNote.trim() ? draftNote.trim() : null;
    }
    if (payload.status === undefined && payload.adminNote === undefined) return;

    setSaving(true);
    setSaveError(null);
    setSavedNotice(null);
    try {
      const updated = await updateAdminFeedback(row.id, payload);
      setExpandedId(null);
      setSavedNotice(t('admin.feedback.saved', { id: formatNumber(updated.id) }));
      // Re-read so the row moves between open/resolved filters right away.
      await load(filter);
    } catch (error) {
      if (isAuthError(error)) {
        onAuthError();
        return;
      }
      setSaveError(feedbackErrorText(error, t, 'admin.feedback.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const items = page?.items ?? [];
  const emptyTitle = t(EMPTY_TITLE_KEYS[filter]);

  const filterOptions: SegmentedOption[] = [
    {
      value: 'open',
      label: t('admin.feedback.filter.open'),
      testId: 'admin-feedback-filter-open',
    },
    {
      value: 'resolved',
      label: t('admin.feedback.filter.resolved'),
      testId: 'admin-feedback-filter-resolved',
    },
    {
      value: 'all',
      label: t('admin.feedback.filter.all'),
      testId: 'admin-feedback-filter-all',
    },
  ];

  const statusOptions: SegmentedOption[] = [
    {
      value: 'open',
      label: t('admin.feedback.status.open'),
      testId: 'admin-feedback-status-open',
    },
    {
      value: 'resolved',
      label: t('admin.feedback.status.resolved'),
      testId: 'admin-feedback-status-resolved',
    },
  ];

  return (
    <section
      {...tabPanelProps('admin', 'feedback')}
      data-testid="admin-panel-feedback"
      className="mt-6 space-y-6"
    >
      <Card
        variant="card"
        className="min-w-0"
        title={t('admin.feedback.title')}
        description={t('admin.feedback.subtitle')}
        icon={Inbox}
        testId="admin-feedback-card"
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              loading={loading}
              loadingLabel={t('admin.feedback.loading')}
              iconLeft={loading ? undefined : <RefreshCw aria-hidden="true" />}
              onClick={() => {
                void load(filter);
              }}
              testId="admin-feedback-refresh"
            >
              {t('admin.feedback.refresh')}
            </Button>
            {page && (
              <span
                data-testid="admin-feedback-count"
                className="text-caption tabular-nums text-fg-secondary"
              >
                {t('admin.feedback.count', {
                  shown: formatNumber(items.length),
                  total: formatNumber(page.total),
                })}
              </span>
            )}
            {page && page.total > items.length && (
              <span data-testid="admin-feedback-limit-note" className="text-micro text-fg-muted">
                {t('admin.feedback.limitNote', { limit: formatNumber(page.limit) })}
              </span>
            )}
            {savedNotice && (
              <span
                role="status"
                data-testid="admin-feedback-saved"
                className="inline-flex items-center gap-1 text-caption text-success-fg"
              >
                <CircleCheck aria-hidden="true" className="h-3.5 w-3.5" />
                {savedNotice}
              </span>
            )}
          </>
        }
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              options={filterOptions}
              value={filter}
              onChange={(next) => changeFilter(next as AdminFeedbackStatusFilter)}
              layoutId="admin-feedback-filter"
              ariaLabel={t('admin.feedback.filter.label')}
              testId="admin-feedback-filter"
            />
            <span className="text-micro text-fg-muted">{t('admin.feedback.filter.hint')}</span>
          </div>

          {loadError && (
            <div className="mt-3">
              <ErrorPanel
                level="inline"
                title={loadError}
                onRetry={() => {
                  void load(filter);
                }}
                retryLabel={t('admin.retry')}
                retryTestId="admin-feedback-load-error-retry"
                testId="admin-feedback-load-error"
              />
            </div>
          )}

          {loading && !page ? (
            <LoadingState
              kind="skeleton"
              rows={6}
              label={t('admin.feedback.loading')}
              testId="admin-feedback-loading"
              className="mt-3"
            />
          ) : null}

          {!loading && page && items.length === 0 && !loadError ? (
            <div className="mt-3">
              <EmptyState
                icon={Inbox}
                title={emptyTitle}
                hint={t('admin.feedback.empty.hint')}
                action={filter === 'all' ? undefined : {
                  label: t('admin.feedback.empty.showAll'),
                  onClick: () => changeFilter('all'),
                  testId: 'admin-feedback-empty-show-all',
                }}
                testId="admin-feedback-empty"
              />
            </div>
          ) : null}

          {items.length > 0 ? (
            <>
              <div className="mt-3 overflow-hidden rounded-control border border-line-subtle">
                <Table
                  testId="admin-feedback-table"
                  minWidth={1040}
                  caption={t('admin.feedback.title')}
                >
                  <TableHeader>
                    <tr>
                      <TableHeaderCell nowrap>{t('admin.feedback.col.status')}</TableHeaderCell>
                      <TableHeaderCell nowrap>{t('admin.feedback.col.category')}</TableHeaderCell>
                      <TableHeaderCell>{t('admin.feedback.col.message')}</TableHeaderCell>
                      <TableHeaderCell nowrap>{t('admin.feedback.col.reporter')}</TableHeaderCell>
                      <TableHeaderCell nowrap>{t('admin.feedback.col.requestId')}</TableHeaderCell>
                      <TableHeaderCell nowrap>{t('admin.feedback.col.page')}</TableHeaderCell>
                      <TableHeaderCell nowrap>{t('admin.feedback.col.time')}</TableHeaderCell>
                      <TableHeaderCell align="right" nowrap>
                        {t('admin.feedback.col.actions')}
                      </TableHeaderCell>
                    </tr>
                  </TableHeader>
                  <TableBody>
                    {items.map((row) => {
                      const expanded = expandedId === row.id;
                      const dirty = expanded && rowDirty(row);
                      const detailId = `admin-feedback-detail-${row.id}`;
                      const reporterId = shortUserId(row.userId);
                      return (
                        <Fragment key={row.id}>
                          <TableRow data-testid="admin-feedback-row" data-row-id={row.id}>
                            <TableCell nowrap>
                              <Badge
                                tone={STATUS_TONES[row.status] ?? 'neutral'}
                                testId="admin-feedback-status"
                              >
                                {feedbackStatusLabel(row.status, t)}
                              </Badge>
                            </TableCell>
                            <TableCell nowrap>
                              <span data-testid="admin-feedback-category">
                                {feedbackCategoryLabel(row.category, t)}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span
                                data-testid="admin-feedback-message"
                                title={row.message}
                                className="line-clamp-2 block max-w-[320px] break-words text-ui leading-relaxed text-fg-primary"
                              >
                                {row.message}
                              </span>
                            </TableCell>
                            <TableCell nowrap>
                              <span
                                data-testid="admin-feedback-reporter"
                                className="inline-flex min-w-0 flex-col gap-0.5"
                              >
                                {reporterId ? (
                                  <>
                                    <span className="text-ui text-fg-primary">
                                      {t('admin.feedback.reporter.user')}
                                    </span>
                                    <span className="font-mono text-micro text-fg-muted">
                                      {reporterId}
                                    </span>
                                  </>
                                ) : (
                                  <Badge testId="admin-feedback-guest">
                                    {t('admin.feedback.reporter.guest')}
                                  </Badge>
                                )}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span
                                data-testid="admin-feedback-request-id"
                                className="block max-w-[180px] break-all font-mono text-micro leading-relaxed text-fg-secondary"
                              >
                                {row.requestId || t('admin.feedback.requestId.none')}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span
                                data-testid="admin-feedback-page"
                                title={row.page ?? undefined}
                                className="block max-w-[140px] truncate text-ui text-fg-secondary"
                              >
                                {row.page?.trim() ? row.page : t('admin.feedback.page.none')}
                              </span>
                            </TableCell>
                            <TableCell nowrap>
                              <span
                                data-testid="admin-feedback-time"
                                className="text-ui tabular-nums text-fg-secondary"
                              >
                                {formatDate(row.createdAt, {
                                  dateStyle: 'short',
                                  timeStyle: 'short',
                                })}
                              </span>
                            </TableCell>
                            <TableCell align="right">
                              <Button
                                variant="ghost"
                                size="sm"
                                iconOnly
                                ariaLabel={expanded
                                  ? t('admin.feedback.collapse')
                                  : t('admin.feedback.expand', { id: formatNumber(row.id) })}
                                ariaExpanded={expanded}
                                ariaControls={detailId}
                                iconLeft={
                                  <ChevronDown
                                    aria-hidden="true"
                                    className={`h-4 w-4 transition-transform duration-200 ease-apple ${
                                      expanded ? 'rotate-180' : ''
                                    }`}
                                  />
                                }
                                onClick={() => expand(row)}
                                testId="admin-feedback-toggle"
                              />
                            </TableCell>
                          </TableRow>

                          {expanded && (
                            <TableRow hover={false} data-testid="admin-feedback-detail-row">
                              <TableCell colSpan={COLUMN_COUNT} className="bg-surface-2/40">
                                <div
                                  id={detailId}
                                  data-testid="admin-feedback-detail"
                                  className="min-w-0"
                                >
                                  <p className="text-micro font-medium text-fg-muted">
                                    {t('admin.feedback.detail.message')}
                                  </p>
                                  <p
                                    data-testid="admin-feedback-detail-message"
                                    className="mt-1 whitespace-pre-wrap break-words text-ui leading-relaxed text-fg-primary"
                                  >
                                    {row.message}
                                  </p>

                                  <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                                    <div className="min-w-0">
                                      <dt className="text-micro text-fg-muted">
                                        {t('admin.feedback.detail.contact')}
                                      </dt>
                                      <dd
                                        data-testid="admin-feedback-detail-contact"
                                        className="mt-0.5 break-all text-ui text-fg-primary"
                                      >
                                        {row.contact || t('admin.feedback.detail.contactNone')}
                                      </dd>
                                    </div>
                                    <div className="min-w-0">
                                      <dt className="text-micro text-fg-muted">
                                        {t('admin.feedback.detail.resolvedAt')}
                                      </dt>
                                      <dd
                                        data-testid="admin-feedback-detail-resolved-at"
                                        className="mt-0.5 text-ui tabular-nums text-fg-primary"
                                      >
                                        {row.resolvedAt
                                          ? formatDate(row.resolvedAt, {
                                            dateStyle: 'short',
                                            timeStyle: 'short',
                                          })
                                          : t('admin.feedback.detail.resolvedAtNone')}
                                      </dd>
                                    </div>
                                    <div className="min-w-0">
                                      <dt className="text-micro text-fg-muted">
                                        {t('admin.feedback.detail.userId')}
                                      </dt>
                                      <dd
                                        data-testid="admin-feedback-detail-user-id"
                                        className="mt-0.5 break-all font-mono text-micro text-fg-primary"
                                      >
                                        {row.userId || t('admin.feedback.reporter.guest')}
                                      </dd>
                                    </div>
                                  </dl>

                                  <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                                    <div className="min-w-0">
                                      <span className="text-caption font-medium text-fg-secondary">
                                        {t('admin.feedback.detail.status')}
                                      </span>
                                      <div className="mt-1.5">
                                        <Segmented
                                          options={statusOptions}
                                          value={draftStatus}
                                          onChange={(next) =>
                                            setDraftStatus(next as StatusDraft)}
                                          layoutId={`admin-feedback-status-${row.id}`}
                                          ariaLabel={t('admin.feedback.detail.status')}
                                          testId="admin-feedback-status-editor"
                                        />
                                      </div>
                                      {!isBinaryStatus(row.status) && (
                                        <p
                                          data-testid="admin-feedback-status-hint"
                                          className="mt-1.5 text-micro leading-relaxed text-fg-muted"
                                        >
                                          {t('admin.feedback.detail.statusHint', {
                                            status: feedbackStatusLabel(row.status, t),
                                          })}
                                        </p>
                                      )}
                                    </div>

                                    <div className="min-w-0">
                                      <label
                                        htmlFor={`admin-feedback-note-${row.id}`}
                                        className="text-caption font-medium text-fg-secondary"
                                      >
                                        {t('admin.feedback.detail.note')}
                                      </label>
                                      {/* Input shell (A2 C9): the wrapper owns the focus
                                          ring, the textarea only clears the native outline. */}
                                      <span className="mt-1.5 block rounded-control-lg border border-line-subtle bg-surface-2/60 focus-within:ring-2 focus-within:ring-brand/60">
                                        <textarea
                                          className="w-full resize-y rounded-control-lg bg-transparent px-3 py-2.5 text-ui leading-relaxed text-fg-primary outline-none placeholder:text-fg-muted"
                                          id={`admin-feedback-note-${row.id}`}
                                          data-testid="admin-feedback-note"
                                          value={draftNote}
                                          rows={3}
                                          maxLength={ADMIN_NOTE_MAX}
                                          onChange={(event) => {
                                            setDraftNote(event.target.value);
                                            if (saveError) setSaveError(null);
                                          }}
                                          placeholder={t('admin.feedback.detail.notePlaceholder')}
                                          aria-describedby={`admin-feedback-note-hint-${row.id}`}
                                        />
                                      </span>
                                      <div className="mt-1 flex items-center justify-between gap-2">
                                        <p
                                          id={`admin-feedback-note-hint-${row.id}`}
                                          className="text-micro leading-relaxed text-fg-muted"
                                        >
                                          {t('admin.feedback.detail.notePlaceholder')}
                                        </p>
                                        <span
                                          data-testid="admin-feedback-note-count"
                                          className="shrink-0 text-micro tabular-nums text-fg-muted"
                                        >
                                          {t('admin.feedback.detail.noteCount', {
                                            count: formatNumber(Array.from(draftNote).length),
                                            max: String(ADMIN_NOTE_MAX),
                                          })}
                                        </span>
                                      </div>
                                    </div>
                                  </div>

                                  <div className="mt-3 flex flex-wrap items-center gap-2">
                                    <Button
                                      variant="primary"
                                      size="md"
                                      loading={saving}
                                      loadingLabel={t('admin.feedback.saving')}
                                      onClick={() => {
                                        void saveRow(row);
                                      }}
                                      disabled={!dirty}
                                      testId="admin-feedback-save"
                                    >
                                      {t('admin.feedback.save')}
                                    </Button>
                                    <Button
                                      variant="secondary"
                                      size="md"
                                      onClick={collapse}
                                      disabled={saving}
                                      testId="admin-feedback-cancel"
                                    >
                                      {t('admin.feedback.cancel')}
                                    </Button>
                                    {dirty && !saving && (
                                      <span
                                        data-testid="admin-feedback-dirty"
                                        className="text-caption text-warning-fg"
                                      >
                                        {t('admin.feedback.dirty')}
                                      </span>
                                    )}
                                    {saveError && (
                                      <p
                                        role="alert"
                                        data-testid="admin-feedback-error"
                                        className="flex items-start gap-1.5 text-caption leading-relaxed text-danger-fg"
                                      >
                                        <TriangleAlert
                                          aria-hidden="true"
                                          className="mt-0.5 h-3.5 w-3.5 shrink-0"
                                        />
                                        <span>{saveError}</span>
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <p className="mt-2 text-micro leading-relaxed text-fg-muted">
                {t('admin.feedback.pageHint')}
              </p>
            </>
          ) : null}
        </div>
      </Card>
    </section>
  );
}
