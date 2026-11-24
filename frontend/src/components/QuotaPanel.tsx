// 今日额度 (v1.1 P0, P2-39): GET /api/quota.
//
// Read-only panel on the 我的 page. It answers the three questions the v1.1
// launch needs to be honest about AI cost:
//   1. how much is left today (per feature),
//   2. when it resets (server-provided instant, never invented),
//   3. which features are switched off (`limit === 0`, quota_config semantics).
//
// Every state is explicit (interaction-spec IX-01): loading keeps its layout,
// a failure is an inline error with retry — never an "empty quota" panel, and
// `features: []` is a distinct empty state, not a fake zero.
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Clock, RefreshCw } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useI18n } from '../i18n/I18nProvider';
import {
  fetchQuota,
  formatQuotaReset,
  quotaFeatureLabel,
  quotaResetAt,
  type QuotaFeatureUsage,
  type QuotaSnapshot,
} from '../lib/quota';
import { describeApiError } from '../lib/toast';
import { Button } from './ui/Button';

interface QuotaPanelProps {
  className?: string;
}

function FeatureRow({ item }: { item: QuotaFeatureUsage }) {
  const { t, language, formatNumber } = useI18n();
  const label = quotaFeatureLabel(item.feature, language);
  const limit = item.limit;
  const used = Math.max(0, item.used);
  const remaining = item.remaining ?? (limit !== null ? Math.max(0, limit - used) : null);
  const closed = limit === 0;
  const exhausted = !closed && remaining !== null && remaining <= 0;
  const ratio = limit !== null && limit > 0 ? Math.min(1, used / limit) : 0;
  const percent = Math.round(ratio * 100);

  return (
    <div
      data-testid={`quota-feature-${item.feature}`}
      data-closed={closed ? 'true' : undefined}
      data-exhausted={exhausted ? 'true' : undefined}
      className="min-w-0 p-3.5 sm:p-4"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-ui font-medium text-fg-strong">{label}</span>
        {closed ? (
          <span className="shrink-0 text-caption font-medium text-fg-muted">
            {t('quota.feature.closed')}
          </span>
        ) : remaining !== null && limit !== null ? (
          <span
            data-testid={`quota-feature-${item.feature}-remaining`}
            className={`shrink-0 text-caption tabular-nums ${exhausted ? 'text-danger-fg' : 'text-fg-secondary'}`}
          >
            {t('quota.feature.remaining', {
              remaining: formatNumber(Math.max(0, remaining)),
              limit: formatNumber(limit),
            })}
          </span>
        ) : (
          <span className="shrink-0 text-caption text-fg-muted">—</span>
        )}
      </div>

      {!closed && limit !== null && (
        <div
          role="progressbar"
          aria-label={t('quota.feature.barAria', { feature: label, percent })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3/60"
        >
          <div
            data-testid={`quota-feature-${item.feature}-bar`}
            className={`h-full rounded-full transition-[width] duration-300 ease-apple ${
              exhausted ? 'bg-danger' : 'bg-brand'
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2 text-micro text-fg-muted">
        <span className="truncate">
          {closed
            ? t('quota.feature.closedHint')
            : t('quota.feature.used', { used: formatNumber(Math.max(0, used)) })}
        </span>
        {(item.source === 'override' || item.source === 'user_override') && (
          <span className="shrink-0 rounded-full border border-line-subtle bg-surface-2/60 px-1.5 py-0.5">
            {t('quota.feature.override')}
          </span>
        )}
      </div>
    </div>
  );
}

export function QuotaPanel({ className }: QuotaPanelProps) {
  const { status } = useAuth();
  const { t, language } = useI18n();
  const [snapshot, setSnapshot] = useState<QuotaSnapshot | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const next = await fetchQuota();
      setSnapshot(next);
      setState('ready');
    } catch (err) {
      setSnapshot(null);
      setError(await describeApiError(err));
      setState('error');
    }
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') {
      setSnapshot(null);
      setState('idle');
      return;
    }
    void load();
  }, [status, load]);

  // Signed-out or still booting: the 我的 page already has its own guest card.
  if (status !== 'authenticated') return null;

  const resetAt = quotaResetAt(snapshot);

  return (
    <section
      aria-label={t('quota.title')}
      data-testid="quota-panel"
      className={className}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-section font-semibold tracking-tight text-fg-primary">
            <Clock className="h-4 w-4 shrink-0 text-brand-300" aria-hidden="true" />
            {t('quota.title')}
          </h2>
          <p className="mt-1 text-caption leading-relaxed text-fg-secondary">{t('quota.subtitle')}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          ariaLabel={t('quota.refresh')}
          onClick={() => { void load(); }}
          iconLeft={<RefreshCw />}
          testId="quota-refresh"
          className="mt-0.5"
        />
      </div>

      <div className="mt-3 overflow-hidden rounded-card border border-line-subtle bg-surface/40">
        {state === 'loading' && (
          <div
            data-testid="quota-loading"
            aria-busy="true"
            aria-label={t('quota.loading')}
            className="divide-y divide-line-subtle"
          >
            {[0, 1, 2].map((index) => (
              <div key={index} className="p-3.5 sm:p-4">
                <div className="h-4 w-28 animate-pulse rounded bg-surface-3/60 motion-reduce:animate-none" />
                <div className="mt-2 h-1.5 w-full animate-pulse rounded-full bg-surface-3/40 motion-reduce:animate-none" />
              </div>
            ))}
          </div>
        )}

        {state === 'error' && (
          <div
            data-testid="quota-error"
            role="alert"
            className="flex items-start gap-2.5 p-4"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning-fg" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="break-words text-caption leading-relaxed text-fg-strong">
                {error ?? t('quota.error.copy')}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { void load(); }}
                iconLeft={<RefreshCw />}
                testId="quota-retry"
                className="mt-2.5"
              >
                {t('common.retry')}
              </Button>
            </div>
          </div>
        )}

        {state === 'ready' && (snapshot?.features.length ?? 0) === 0 && (
          <div data-testid="quota-empty" className="p-5 text-center">
            <p className="text-ui font-medium text-fg-strong">{t('quota.empty.title')}</p>
            <p className="mt-1 text-caption leading-relaxed text-fg-muted">{t('quota.empty.hint')}</p>
          </div>
        )}

        {state === 'ready' && (snapshot?.features.length ?? 0) > 0 && (
          <>
            <div
              data-testid="quota-features"
              className="grid grid-cols-1 gap-px bg-line-subtle sm:grid-cols-2"
            >
              {snapshot?.features.map((item) => (
                <div key={item.feature} className="bg-surface/60">
                  <FeatureRow item={item} />
                </div>
              ))}
            </div>
            <div
              data-testid="quota-reset"
              className="flex flex-wrap items-center justify-between gap-2 border-t border-line-subtle bg-surface-2/30 px-3.5 py-2.5 text-micro text-fg-muted sm:px-4"
            >
              <span>{formatQuotaReset(resetAt, language)}</span>
              <span>{t('quota.resetHint')}</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
