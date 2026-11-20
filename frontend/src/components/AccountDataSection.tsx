// Account lifecycle UI (M2b for specs/033): the "data & account" block on the
// profile page — data export, permanent account deletion, and the 7-day
// cooldown card shown while `users.status = deletion_pending`.
//
// All rules live in the backend (`account_lifecycle` / `account_export`): this
// file never decides the cooldown, the quotas or whether a download token is
// valid — it renders the state the API returns and maps stable error codes to
// localized copy (`lib/accountLifecycle.ts`).
//
// Two independent blocks:
//   PendingDeletionCard   — only rendered while the session user is pending:
//                           due date, cancel (password), jump to export.
//   AccountDataSection    — exports (create / poll / download / delete temp
//                           files) plus the danger zone that opens the delete
//                           dialog (password + username + DELETE + optional
//                           reason). Hidden delete entry while pending, since
//                           the request already exists.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CalendarClock,
  Check,
  Download,
  FileDown,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { useAuth } from '../lib/auth';
import { toast } from '../lib/toast';
import {
  DELETE_CONFIRM_WORD,
  LifecycleApiError,
  cancelDeletion,
  clearExportToken,
  createExport,
  deleteExport,
  downloadExport,
  fetchDeletionState,
  fetchExports,
  lifecycleErrorText,
  readExportToken,
  requestDeletion,
  storeExportToken,
  type CreateExportResult,
  type DeletionState,
  type ExportJob,
  type ExportJobStatus,
} from '../lib/accountLifecycle';

const EXPORT_POLL_MS = 3000;

const FIELD_CLASS =
  'mt-1 w-full rounded-xl bg-zinc-800/50 border border-white/10 px-3 py-2 text-sm text-white ' +
  'placeholder:text-zinc-600 outline-none focus-visible:border-brand/60 focus-visible:ring-2 ' +
  'focus-visible:ring-brand/15';
const LABEL_CLASS = 'block text-xs font-medium text-zinc-400';
const INLINE_ERROR_CLASS =
  'mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-red-400';

const EXPORT_BADGE: Record<ExportJobStatus, string> = {
  queued: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  running: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  ready: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  failed: 'bg-red-500/10 text-red-400 border-red-500/20',
  expired: 'bg-zinc-800/70 text-zinc-500 border-white/5',
};

const EXPORT_STATUS_KEYS: Record<ExportJobStatus, TranslationKey> = {
  queued: 'account.export.status.queued',
  running: 'account.export.status.running',
  ready: 'account.export.status.ready',
  failed: 'account.export.status.failed',
  expired: 'account.export.status.expired',
};

function formatBytes(bytes: number | null, formatNumber: (value: number) => string): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : size < 10 ? 1 : 0;
  return `${formatNumber(Number(size.toFixed(digits)))} ${units[unit]}`;
}

/** A ready job whose file expired before the cleanup worker relabelled it. */
function effectiveStatus(job: ExportJob): ExportJobStatus {
  if (job.status === 'ready' && !job.downloadable) return 'expired';
  return job.status;
}

function StatusBadge({ status }: { status: ExportJobStatus }) {
  const { t } = useI18n();
  return (
    <span
      data-testid="account-export-status"
      data-status={status}
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${EXPORT_BADGE[status]}`}
    >
      {t(EXPORT_STATUS_KEYS[status])}
    </span>
  );
}

function InlineError({ testId, message }: { testId: string; message: string }) {
  return (
    <p role="alert" data-testid={testId} className={INLINE_ERROR_CLASS}>
      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

// ── Export: password confirmation ──────────────────────────────────────────

interface ExportDialogProps {
  onClose: () => void;
  onCreated: (result: CreateExportResult) => void;
}

function ExportDialog({ onClose, onCreated }: ExportDialogProps) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!password) {
      setError(t('account.export.passwordRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await createExport(password);
      // The token only exists in this response: keep it tab-scoped so a reload
      // can still download the ready file.
      storeExportToken(result.jobId, result.downloadToken);
      onCreated(result);
    } catch (err) {
      setError(lifecycleErrorText(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-blue-400"><FileDown className="w-5 h-5" /></span>
          <span className="truncate">{t('account.export.confirmTitle')}</span>
        </span>
      }
      size="sm"
      loading={saving}
      testId="account-export-dialog"
      initialFocus='[data-testid="account-export-password"]'
      footer={
        <>
          <Button
            variant="secondary"
            size="md"
            onClick={onClose}
            disabled={saving}
            testId="account-export-cancel"
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => { void submit(); }}
            loading={saving}
            loadingLabel={t('account.export.submitting')}
            iconLeft={<FileDown className="w-4 h-4" />}
            testId="account-export-submit"
          >
            {t('account.export.action')}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-zinc-300">{t('account.export.confirmDesc')}</p>
      <label className="mt-4 block">
        <span className={LABEL_CLASS}>{t('account.export.password')}</span>
        <input
          data-testid="account-export-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={t('account.export.passwordPlaceholder')}
          className={FIELD_CLASS}
        />
      </label>
      {error && <InlineError testId="account-export-error" message={error} />}
      <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">{t('account.export.limits')}</p>
    </Dialog>
  );
}

// ── Exports card ───────────────────────────────────────────────────────────

interface ExportsCardProps {
  pending: boolean;
}

function ExportsCard({ pending }: ExportsCardProps) {
  const { t, formatDate, formatNumber } = useI18n();
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const requestId = ++requestRef.current;
    if (!quiet) setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchExports();
      if (requestId !== requestRef.current) return;
      setJobs(data.jobs);
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setLoadError(lifecycleErrorText(error, t));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while a job is queued/running; the interval disappears as soon as
  // the backend reports a terminal state.
  const hasActiveJob = jobs.some((job) => job.status === 'queued' || job.status === 'running');
  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = window.setInterval(() => { void load(true); }, EXPORT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveJob, load]);

  const handleCreated = () => {
    setCreateOpen(false);
    toast.success(t('account.export.created'));
    void load(true);
  };

  const handleDownload = async (job: ExportJob) => {
    const token = readExportToken(job.id);
    if (!token) {
      setActionError(t('account.export.tokenMissing'));
      return;
    }
    setDownloadingId(job.id);
    setActionError(null);
    try {
      const { blob, filename } = await downloadExport(job.id, token);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(t('account.export.downloadReady'));
      void load(true);
    } catch (error) {
      const message = lifecycleErrorText(error, t);
      setActionError(message);
      toast.error(message);
      if (error instanceof LifecycleApiError && error.code === 'export_token_invalid') {
        clearExportToken(job.id);
      }
      if (
        error instanceof LifecycleApiError
        && (error.code === 'export_expired'
          || error.code === 'export_token_invalid'
          || error.code === 'export_failed'
          || error.code === 'export_not_found'
          || error.status === 410)
      ) {
        void load(true);
      }
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async (job: ExportJob) => {
    setDeletingId(job.id);
    setActionError(null);
    try {
      await deleteExport(job.id);
      clearExportToken(job.id);
      toast.success(t('account.export.deleted'));
      await load(true);
    } catch (error) {
      const message = lifecycleErrorText(error, t);
      setActionError(message);
      toast.error(message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div
      id="account-data-export"
      data-testid="account-export-card"
      className="scroll-mt-24 rounded-2xl border border-white/5 bg-zinc-900/40 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <FileDown className="w-4 h-4 text-blue-400/90" />
            {t('account.export.title')}
          </h3>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-zinc-500">
            {t('account.export.desc')}
          </p>
          <p data-testid="account-export-limits" className="mt-1 text-[11px] leading-relaxed text-zinc-600">
            {t('account.export.limits')}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="account-export-refresh"
            onClick={() => { void load(); }}
            disabled={loading}
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-white/5 bg-zinc-800/60 text-xs font-medium text-zinc-300 hover:bg-zinc-700/60 hover:text-zinc-100 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('account.export.refresh')}
          </button>
          <Button
            variant="primary"
            size="md"
            onClick={() => setCreateOpen(true)}
            iconLeft={<FileDown className="w-4 h-4" />}
            testId="account-export-create"
          >
            {t('account.export.action')}
          </Button>
        </div>
      </div>

      {pending && (
        <p
          data-testid="account-export-pending-note"
          className="mt-3 rounded-xl border border-amber-500/15 bg-amber-500/[0.05] px-3 py-2 text-xs leading-relaxed text-amber-200/90"
        >
          {t('account.pending.restricted')}
        </p>
      )}

      <div className="mt-4">
        <p className="text-[11px] font-medium text-zinc-500">{t('account.export.jobs')}</p>

        {loadError ? (
          <div className="mt-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3">
            <p role="alert" data-testid="account-export-load-error" className="flex items-start gap-1.5 text-xs leading-relaxed text-amber-200">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{loadError}</span>
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { void load(); }}
              iconLeft={<RefreshCw className="w-3.5 h-3.5" />}
              className="mt-2"
            >
              {t('account.export.retry')}
            </Button>
          </div>
        ) : loading && jobs.length === 0 ? (
          <p className="mt-2 inline-flex items-center gap-2 text-xs text-zinc-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t('account.export.loading')}
          </p>
        ) : jobs.length === 0 ? (
          <p data-testid="account-export-empty" className="mt-2 text-xs text-zinc-500">
            {t('account.export.empty')}
          </p>
        ) : (
          <ul data-testid="account-export-list" className="mt-2 space-y-2">
            {jobs.map((job) => {
              const status = effectiveStatus(job);
              const token = readExportToken(job.id);
              const canDownload = status === 'ready' && job.downloadable;
              const busy = downloadingId === job.id || deletingId === job.id;
              return (
                <li
                  key={job.id}
                  data-testid="account-export-row"
                  data-job-id={job.id}
                  data-status={status}
                  className="rounded-xl border border-white/5 bg-zinc-950/40 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <StatusBadge status={status} />
                      <span className="font-mono text-[11px] text-zinc-500">{job.id.slice(0, 12)}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {canDownload && token && (
                        <button
                          type="button"
                          data-testid="account-export-download"
                          onClick={() => { void handleDownload(job); }}
                          disabled={busy}
                          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-xs font-medium text-emerald-300 hover:bg-emerald-500/15 transition-colors disabled:opacity-50"
                        >
                          {downloadingId === job.id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Download className="w-3.5 h-3.5" />}
                          {downloadingId === job.id
                            ? t('account.export.downloading')
                            : t('account.export.download')}
                        </button>
                      )}
                      {status !== 'queued' && status !== 'running' && status !== 'expired' && (
                        <button
                          type="button"
                          data-testid="account-export-delete"
                          onClick={() => { void handleDelete(job); }}
                          disabled={busy}
                          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-white/5 bg-zinc-800/60 text-xs font-medium text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-200 transition-colors disabled:opacity-50"
                        >
                          {deletingId === job.id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Trash2 className="w-3.5 h-3.5" />}
                          {deletingId === job.id
                            ? t('account.export.deleting')
                            : t('account.export.delete')}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500 tabular-nums">
                    <span>{t('account.export.requestedAt', {
                      date: formatDate(job.requestedAt, { dateStyle: 'short', timeStyle: 'short' }),
                    })}</span>
                    {job.expiresAt && job.status !== 'expired' && (
                      <span>
                        {t('account.export.expiresAt', {
                          date: formatDate(job.expiresAt, { dateStyle: 'short', timeStyle: 'short' }),
                        })}
                      </span>
                    )}
                    {job.sizeBytes ? (
                      <span>{t('account.export.size', { size: formatBytes(job.sizeBytes, formatNumber) })}</span>
                    ) : null}
                    {job.downloadedAt && (
                      <span>
                        {t('account.export.downloadedAt', {
                          date: formatDate(job.downloadedAt, { dateStyle: 'short', timeStyle: 'short' }),
                        })}
                      </span>
                    )}
                  </div>

                  {status === 'ready' && canDownload && !token && (
                    <p
                      data-testid="account-export-token-missing"
                      className="mt-2 text-[11px] leading-relaxed text-amber-300/90"
                    >
                      {t('account.export.tokenMissing')}
                    </p>
                  )}
                  {status === 'failed' && (
                    <p className="mt-2 text-[11px] leading-relaxed text-red-300/90">
                      {t('account.errors.exportFailed')}
                    </p>
                  )}
                  {status === 'expired' && (
                    <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                      {t('account.export.error.expired')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {actionError && <InlineError testId="account-export-action-error" message={actionError} />}
      </div>

      {createOpen && <ExportDialog onClose={() => setCreateOpen(false)} onCreated={handleCreated} />}
    </div>
  );
}

// ── Delete account dialog ──────────────────────────────────────────────────

interface DeleteAccountDialogProps {
  onClose: () => void;
  onSubmitted: () => void;
}

function DeleteAccountDialog({ onClose, onSubmitted }: DeleteAccountDialogProps) {
  const { t } = useI18n();
  const { user } = useAuth();
  const expectedUsername = user?.username ?? '';
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!password.trim()) {
      setError(t('account.delete.validation.password'));
      return;
    }
    if (!username.trim() || !confirmText.trim()) {
      setError(t('account.delete.validation.fields'));
      return;
    }
    if (username.trim() !== expectedUsername) {
      setError(t('account.delete.validation.username'));
      return;
    }
    if (confirmText.trim() !== DELETE_CONFIRM_WORD) {
      setError(t('account.delete.validation.confirm'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await requestDeletion({
        password,
        username,
        confirm: confirmText,
        reason,
      });
      onSubmitted();
    } catch (err) {
      setError(lifecycleErrorText(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-red-400"><AlertTriangle className="w-5 h-5" /></span>
          <span className="truncate">{t('account.delete.dialogTitle')}</span>
        </span>
      }
      description={t('account.delete.warningTitle')}
      size="md"
      loading={saving}
      testId="account-delete-dialog"
      initialFocus='[data-testid="account-delete-password"]'
      footer={
        <>
          <Button
            variant="secondary"
            size="md"
            onClick={onClose}
            disabled={saving}
            testId="account-delete-cancel"
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            size="md"
            onClick={() => { void submit(); }}
            loading={saving}
            loadingLabel={t('account.delete.submitting')}
            iconLeft={<Trash2 className="w-4 h-4" />}
            testId="account-delete-submit"
          >
            {t('account.delete.submit')}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-zinc-300">{t('account.delete.warning')}</p>

      <div className="mt-3 space-y-2 rounded-xl border border-red-500/15 bg-red-500/[0.04] p-3">
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-red-200/90">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{t('account.delete.backup')}</span>
        </p>
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-zinc-400">
          <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{t('account.delete.noEmail')}</span>
        </p>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL_CLASS}>{t('account.delete.password')}</span>
          <input
            data-testid="account-delete-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              if (error) setError(null);
            }}
            placeholder={t('account.export.passwordPlaceholder')}
            className={FIELD_CLASS}
          />
        </label>
        <label className="block">
          <span className={LABEL_CLASS}>{t('account.delete.username')}</span>
          <input
            data-testid="account-delete-username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              if (error) setError(null);
            }}
            placeholder={expectedUsername || t('account.delete.usernameHint')}
            className={FIELD_CLASS}
          />
          <span className="mt-1 block text-[11px] text-zinc-500">
            {t('account.delete.usernameHint')}
            {expectedUsername ? (
              <span className="ml-1 font-mono text-zinc-400">{expectedUsername}</span>
            ) : null}
          </span>
        </label>
        <label className="block">
          <span className={LABEL_CLASS}>{t('account.delete.confirm')}</span>
          <input
            data-testid="account-delete-confirm"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            value={confirmText}
            onChange={(event) => {
              setConfirmText(event.target.value);
              if (error) setError(null);
            }}
            placeholder={DELETE_CONFIRM_WORD}
            className={FIELD_CLASS}
          />
          <span className="mt-1 block text-[11px] text-zinc-500">{t('account.delete.confirmHint')}</span>
        </label>
        <label className="block">
          <span className={LABEL_CLASS}>{t('account.delete.reason')}</span>
          <input
            data-testid="account-delete-reason"
            type="text"
            maxLength={200}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('account.delete.reasonPlaceholder')}
            className={FIELD_CLASS}
          />
        </label>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">{t('account.delete.passwordHint')}</p>

      {error && <InlineError testId="account-delete-error" message={error} />}
    </Dialog>
  );
}

// ── Cooldown (pending) card + cancel dialog ────────────────────────────────

interface CancelDeletionDialogProps {
  onClose: () => void;
  onCancelled: () => void;
}

function CancelDeletionDialog({ onClose, onCancelled }: CancelDeletionDialogProps) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!password) {
      setError(t('account.delete.validation.password'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await cancelDeletion(password);
      onCancelled();
    } catch (err) {
      setError(lifecycleErrorText(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-emerald-400"><ShieldCheck className="w-5 h-5" /></span>
          <span className="truncate">{t('account.pending.cancelTitle')}</span>
        </span>
      }
      size="sm"
      loading={saving}
      testId="account-pending-cancel-dialog"
      initialFocus='[data-testid="account-pending-cancel-password"]'
      footer={
        <>
          <Button
            variant="secondary"
            size="md"
            onClick={onClose}
            disabled={saving}
            testId="account-pending-cancel-dismiss"
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="tinted"
            size="md"
            tone="success"
            onClick={() => { void submit(); }}
            loading={saving}
            iconLeft={<Check className="w-4 h-4" />}
            testId="account-pending-cancel-submit"
          >
            {t('account.pending.cancel')}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-zinc-300">{t('account.pending.cancelDesc')}</p>
      <label className="mt-4 block">
        <span className={LABEL_CLASS}>{t('account.export.password')}</span>
        <input
          data-testid="account-pending-cancel-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={t('account.export.passwordPlaceholder')}
          className={FIELD_CLASS}
        />
      </label>
      {error && <InlineError testId="account-pending-cancel-error" message={error} />}
    </Dialog>
  );
}

/**
 * Cooldown banner on the account page. Only mounted while the session user is
 * `deletion_pending`; cancelling refreshes `/api/auth/me` so every consumer of
 * `user.status` (including the app-wide banner) returns to normal.
 */
export function PendingDeletionCard() {
  const { t, formatDate } = useI18n();
  const { refreshSession } = useAuth();
  const [state, setState] = useState<DeletionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await fetchDeletionState());
    } catch (err) {
      setError(lifecycleErrorText(err, t));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const goToExport = () => {
    document.getElementById('account-data-export')?.scrollIntoView({
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
  };

  const handleCancelled = async () => {
    setCancelOpen(false);
    toast.success(t('account.pending.cancelled'));
    await refreshSession();
  };

  const dueAt = state?.dueAt ?? state?.deletion?.dueAt ?? null;

  return (
    <>
      <section
        data-testid="account-pending-card"
        aria-label={t('account.pending.title')}
        className="mt-6 rounded-2xl border border-red-500/25 bg-red-500/[0.06] p-4 sm:p-5"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-red-500/25 bg-red-500/10 text-red-400">
            <CalendarClock className="w-4 h-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-red-200">{t('account.pending.title')}</p>
            <p className="mt-1 text-xs leading-relaxed text-red-200/80">
              {t('account.pending.notice')}
            </p>
            {dueAt ? (
              <p
                data-testid="account-pending-due"
                className="mt-2 text-sm font-medium text-zinc-100 tabular-nums"
              >
                {t('account.pending.due', {
                  date: formatDate(dueAt, { dateStyle: 'long', timeStyle: 'short' }),
                })}
              </p>
            ) : loading ? (
              <p className="mt-2 inline-flex items-center gap-2 text-xs text-zinc-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('account.export.loading')}
              </p>
            ) : null}

            {error && (
              <div className="mt-2">
                <InlineError testId="account-pending-load-error" message={error} />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { void load(); }}
                  iconLeft={<RefreshCw className="w-3.5 h-3.5" />}
                  className="mt-2"
                >
                  {t('account.retry')}
                </Button>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="destructive"
                size="md"
                onClick={() => setCancelOpen(true)}
                iconLeft={<X className="w-4 h-4" />}
                testId="account-pending-cancel-open"
              >
                {t('account.pending.cancel')}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={goToExport}
                iconLeft={<FileDown className="w-4 h-4" />}
                testId="account-pending-export"
              >
                {t('account.pending.export')}
              </Button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              {t('account.pending.exportHint')}
            </p>
          </div>
        </div>
      </section>

      {cancelOpen && (
        <CancelDeletionDialog
          onClose={() => setCancelOpen(false)}
          onCancelled={() => { void handleCancelled(); }}
        />
      )}
    </>
  );
}

// ── The section ────────────────────────────────────────────────────────────

export interface AccountDataSectionProps {
  /** The session user is in the deletion cooldown (hide the delete entry). */
  pending: boolean;
}

/**
 * "数据与账号" block: exports always, permanent deletion only when the account
 * is not already pending (the cooldown card owns that story then).
 */
export function AccountDataSection({ pending }: AccountDataSectionProps) {
  const { t } = useI18n();
  const { clearSession } = useAuth();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const handleDeletionSubmitted = () => {
    setDeleteOpen(false);
    // The 202 already deleted every session row and cleared the cookie; reset
    // the local session so the app shows the auth screen instead of a shell
    // whose every request would 401/403.
    clearSession();
    toast.success(t('account.delete.success'));
    toast.info(t('account.delete.loggedOut'));
  };

  return (
    <section
      aria-label={t('account.data.title')}
      data-testid="account-data"
      className="mt-8"
    >
      <h2 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight text-zinc-100">
        <span className="text-zinc-500"><ShieldCheck className="w-5 h-5" /></span>
        {t('account.data.title')}
      </h2>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-500">
        {t('account.data.subtitle')}
      </p>

      <div className="mt-3 space-y-3">
        <ExportsCard pending={pending} />

        {!pending && (
          <div
            data-testid="account-delete-card"
            className="rounded-2xl border border-red-500/20 bg-red-500/[0.04] p-4 sm:p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-red-200">
                  <Trash2 className="w-4 h-4 text-red-400" />
                  {t('account.delete.title')}
                </h3>
                <p className="mt-1 max-w-xl text-xs leading-relaxed text-zinc-400">
                  {t('account.delete.desc')}
                </p>
              </div>
              <Button
                variant="destructive"
                size="md"
                onClick={() => setDeleteOpen(true)}
                iconLeft={<Trash2 className="w-4 h-4" />}
                testId="account-delete-open"
              >
                {t('account.delete.action')}
              </Button>
            </div>
          </div>
        )}
      </div>

      <p
        data-testid="account-data-legal"
        className="mt-3 text-[11px] leading-relaxed text-zinc-500"
      >
        {t('account.data.legal')}
      </p>

      {deleteOpen && (
        <DeleteAccountDialog
          onClose={() => setDeleteOpen(false)}
          onSubmitted={handleDeletionSubmitted}
        />
      )}
    </section>
  );
}
