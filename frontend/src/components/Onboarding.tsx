// First-run activation (v1.1 P0): a three-step guide, skippable at any point.
//
// Step 1 看一段视频 → Step 2 点词查义 → Step 3 明天复习. The guide explains the
// loop the product is built around. First run shows it as a non-blocking coach
// card on desktop (below md it stays out of the way — v1.2 owns the mobile
// rework); 我的 · 设置 can reopen the full dialog at any time. It never gates the
// app and never asks for data. "Done" is one localStorage key so a returning
// learner never sees it again:
//
//   yt_bilingual_onboarding_v1 = { done: true, at: <ms> }
//
// P2-50 keeps this key **device-level on purpose** (product decision, audit
// P2-2/P3-5): the guide is about this machine's first run, not about a learner,
// so it deliberately does NOT go through `lib/storageScope.ts`. The cost is
// that a second account on the same device does not see the guide again; the
// 我的 · 设置 entry reopens it on demand.
//
// It renders for guests too: `guest` is the normal pre-signup state, and the
// first-run guide is exactly what a visitor needs before creating an account.
import { useCallback, useEffect, useState } from 'react';
import {
  CalendarCheck,
  ChevronRight,
  Compass,
  MousePointerClick,
  PlayCircle,
} from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';

export const ONBOARDING_STORAGE_KEY = 'yt_bilingual_onboarding_v1';
/** Reopen the guide from anywhere (`window.dispatchEvent(new Event(...))`). */
export const ONBOARDING_OPEN_EVENT = 'yt_bilingual:onboarding-open';

interface OnboardingStep {
  icon: typeof PlayCircle;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  actionKey: TranslationKey;
}

const STEPS: readonly OnboardingStep[] = [
  {
    icon: PlayCircle,
    titleKey: 'onboarding.step1.title',
    bodyKey: 'onboarding.step1.body',
    actionKey: 'onboarding.step1.action',
  },
  {
    icon: MousePointerClick,
    titleKey: 'onboarding.step2.title',
    bodyKey: 'onboarding.step2.body',
    actionKey: 'onboarding.step2.action',
  },
  {
    icon: CalendarCheck,
    titleKey: 'onboarding.step3.title',
    bodyKey: 'onboarding.step3.body',
    actionKey: 'onboarding.step3.action',
  },
];

function readOnboardingDone(): boolean {
  try {
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { done?: unknown };
    return parsed?.done === true;
  } catch {
    // Storage disabled / corrupted: treat as "not done" is wrong here — a
    // private-mode learner would get the guide on every page load. Treat the
    // unreadable state as done; the manual entry still opens it.
    return true;
  }
}

function markOnboardingDone(): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ done: true, at: Date.now() }));
  } catch {
    // Non-fatal: without storage the guide simply shows once per page load.
  }
}

export function openOnboarding(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(ONBOARDING_OPEN_EVENT));
}

/**
 * The auto coach only appears on the app's landing page (`#/app`,
 * `#/app/content`, `#/app/today`), never on a deep link: a learner arriving at
 * a reader / watch URL is mid-task and must not be interrupted, and the old
 * acceptance flows that open deep links stay untouched.
 */
function isAppEntryHash(hash: string): boolean {
  const path = hash.split('?')[0].replace(/\/+$/, '');
  return path === '' || path === '#' || path === '#/app' || path === '#/app/content' || path === '#/app/today';
}

export function Onboarding() {
  const { t } = useI18n();
  const [mode, setMode] = useState<'hidden' | 'coach' | 'dialog'>('hidden');
  const [step, setStep] = useState(0);

  // First run: a small, non-blocking coach card (desktop only). It never
  // covers the page or steals focus, so a deep link keeps working while the
  // guide is visible; the app itself is never gated behind it.
  useEffect(() => {
    if (readOnboardingDone()) return;
    if (typeof window.matchMedia !== 'function') return;
    if (!window.matchMedia('(min-width: 768px)').matches) return;
    if (!isAppEntryHash(window.location.hash)) return;
    const timer = window.setTimeout(() => {
      setStep(0);
      setMode('coach');
    }, 400);
    return () => window.clearTimeout(timer);
  }, []);

  // Leaving the landing page dismisses the coach without marking it done (the
  // next landing visit shows it again; 我的 can reopen the full dialog).
  useEffect(() => {
    if (mode !== 'coach') return;
    const onHashChange = () => {
      if (!isAppEntryHash(window.location.hash)) setMode('hidden');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [mode]);

  // Manual re-entry from 我的 (works even after it was completed).
  useEffect(() => {
    const reopen = () => {
      setStep(0);
      setMode('dialog');
    };
    window.addEventListener(ONBOARDING_OPEN_EVENT, reopen);
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, reopen);
  }, []);

  const finish = useCallback(() => {
    markOnboardingDone();
    setMode('hidden');
  }, []);

  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];
  const Icon = current.icon;

  const dialog = (
    <Dialog
      open={mode === 'dialog'}
      onClose={finish}
      size="md"
      role="dialog"
      title={t('onboarding.title')}
      description={t('onboarding.subtitle')}
      testId="onboarding-dialog"
      initialFocus='[data-testid="onboarding-next"]'
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button
            variant="ghost"
            size="md"
            onClick={finish}
            testId="onboarding-skip"
          >
            {t('onboarding.skip')}
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            {step > 0 && (
              <Button
                variant="secondary"
                size="md"
                onClick={() => setStep((value) => Math.max(0, value - 1))}
                testId="onboarding-back"
              >
                {t('onboarding.back')}
              </Button>
            )}
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                if (isLast) {
                  finish();
                } else {
                  setStep((value) => Math.min(STEPS.length - 1, value + 1));
                }
              }}
              testId={isLast ? 'onboarding-done' : 'onboarding-next'}
              iconRight={isLast ? <Compass /> : <ChevronRight />}
            >
              {isLast ? t('onboarding.start') : t('onboarding.next')}
            </Button>
          </div>
        </div>
      }
    >
      <div data-testid="onboarding-step" data-step={step + 1} className="flex flex-col items-center py-2 text-center">
        <div
          aria-hidden="true"
          className="flex h-14 w-14 items-center justify-center rounded-panel border border-brand/20 bg-brand/10"
        >
          <Icon className="h-7 w-7 text-brand-300" />
        </div>
        <p className="mt-4 text-micro font-medium tabular-nums text-fg-muted">
          {t('onboarding.stepCount', { current: String(step + 1), total: String(STEPS.length) })}
        </p>
        <h3
          data-testid="onboarding-step-title"
          className="mt-1 text-dialog font-semibold tracking-tight text-fg-primary"
        >
          {t(current.titleKey)}
        </h3>
        <p className="mt-2 max-w-sm text-ui leading-relaxed text-fg-secondary">
          {t(current.bodyKey)}
        </p>
        <p className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-line-subtle bg-surface-2/50 px-3 py-1.5 text-caption text-fg-strong">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand" />
          {t(current.actionKey)}
        </p>

        <div
          data-testid="onboarding-dots"
          role="progressbar"
          aria-label={t('onboarding.progressAria')}
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-valuenow={step + 1}
          className="mt-5 flex items-center gap-1.5"
        >
          {STEPS.map((item, index) => (
            <span
              key={item.titleKey}
              aria-hidden="true"
              className={`h-1.5 rounded-full transition-[width,background-color] duration-200 ease-apple ${
                index === step ? 'w-5 bg-brand' : 'w-1.5 bg-surface-3'
              }`}
            />
          ))}
        </div>
      </div>
    </Dialog>
  );

  if (mode !== 'coach') return dialog;

  return (
    <>
      {dialog}
      <aside
        data-testid="onboarding-coach"
        data-step={step + 1}
        role="complementary"
        aria-label={t('onboarding.title')}
        className="fixed bottom-6 right-6 z-nav hidden w-[22rem] max-w-[calc(100vw-3rem)] rounded-card border border-line-strong bg-surface/95 p-4 shadow-elev-2 backdrop-blur-xl md:block"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control-lg border border-brand/20 bg-brand/10"
          >
            <Icon className="h-4.5 w-4.5 text-brand-300" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-micro font-medium tabular-nums text-fg-muted">
              {t('onboarding.stepCount', { current: String(step + 1), total: String(STEPS.length) })}
            </p>
            <p
              data-testid="onboarding-coach-title"
              className="mt-0.5 truncate text-ui font-semibold text-fg-primary"
            >
              {t(current.titleKey)}
            </p>
          </div>
          <button
            type="button"
            data-testid="onboarding-coach-close"
            aria-label={t('onboarding.skip')}
            title={t('onboarding.skip')}
            onClick={finish}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-state-hover hover:text-fg-primary"
          >
            ×
          </button>
        </div>
        <p className="mt-2 text-caption leading-relaxed text-fg-secondary">{t(current.bodyKey)}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <div
            data-testid="onboarding-coach-dots"
            role="progressbar"
            aria-label={t('onboarding.progressAria')}
            aria-valuemin={1}
            aria-valuemax={STEPS.length}
            aria-valuenow={step + 1}
            className="flex items-center gap-1.5"
          >
            {STEPS.map((item, index) => (
              <span
                key={item.titleKey}
                aria-hidden="true"
                className={`h-1.5 rounded-full transition-[width,background-color] duration-200 ease-apple ${
                  index === step ? 'w-4 bg-brand' : 'w-1.5 bg-surface-3'
                }`}
              />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" testId="onboarding-coach-skip" onClick={finish}>
              {t('onboarding.skip')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              testId={isLast ? 'onboarding-coach-done' : 'onboarding-coach-next'}
              iconRight={isLast ? <Compass /> : <ChevronRight />}
              onClick={() => {
                if (isLast) finish();
                else setStep((value) => Math.min(STEPS.length - 1, value + 1));
              }}
            >
              {isLast ? t('onboarding.start') : t('onboarding.next')}
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}
