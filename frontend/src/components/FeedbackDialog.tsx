// 反馈 / 纠错 dialog (v1.1 P0, P2-39): POST /api/feedback.
//
// The dialog owns the whole contract: category, description, the auto-generated
// `requestId` (shown read-only so the learner can quote it), submit states and
// the success receipt. A failed submit keeps the draft and shows an inline
// error; it never closes, never wipes what was typed, and never turns into a
// fake success. Signed-in users and guests can both submit.
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Copy, Loader2, MessageSquarePlus } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { useI18n } from '../i18n/I18nProvider';
import { toast } from '../lib/toast';
import {
  createRequestId,
  FEEDBACK_CATEGORIES,
  FEEDBACK_DESCRIPTION_MAX,
  FEEDBACK_DESCRIPTION_MIN,
  feedbackErrorMessage,
  submitFeedback,
  type FeedbackCategory,
} from '../lib/feedback';

interface FeedbackDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful submit (receipt + request id). */
  onSubmitted?: (requestId: string) => void;
}

export function FeedbackDialog({ open, onClose, onSubmitted }: FeedbackDialogProps) {
  const { t, language } = useI18n();
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [description, setDescription] = useState('');
  const [requestId, setRequestId] = useState(createRequestId);
  const [phase, setPhase] = useState<'form' | 'submitting' | 'success'>('form');
  const [error, setError] = useState<string | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);

  // Fresh request id + empty draft for every opening: a retried report must not
  // reuse the id of the previous attempt (the backend dedupes/rate-limits on it).
  useEffect(() => {
    if (!open) return;
    setCategory('bug');
    setDescription('');
    setRequestId(createRequestId());
    setPhase('form');
    setError(null);
    setReceiptId(null);
  }, [open]);

  const handleClose = useCallback(() => {
    // While the request is in flight the dialog stays: closing would orphan the
    // receipt and the learner could not quote the request id.
    if (phase === 'submitting') return;
    onClose();
  }, [phase, onClose]);

  const handleSubmit = async () => {
    if (phase === 'submitting') return;
    const trimmed = description.trim();
    if (trimmed.length < FEEDBACK_DESCRIPTION_MIN) {
      setError(t('feedback.error.tooShort'));
      return;
    }
    setError(null);
    setPhase('submitting');
    try {
      const receipt = await submitFeedback({ category, description: trimmed, requestId });
      setReceiptId(receipt.requestId);
      setPhase('success');
      onSubmitted?.(receipt.requestId);
    } catch (err) {
      setError(feedbackErrorMessage(err, language));
      setPhase('form');
    }
  };

  const copyRequestId = async (value: string) => {
    try {
      await navigator.clipboard?.writeText(value);
      toast.success(t('feedback.requestId.copied'));
    } catch {
      // Clipboard permission denied: selecting the visible id is enough.
    }
  };

  const selectedCategory = FEEDBACK_CATEGORIES.find((item) => item.id === category)
    ?? FEEDBACK_CATEGORIES[0];

  const footer = phase === 'success' ? (
    <Button
      variant="primary"
      size="md"
      fullWidth
      testId="feedback-done"
      onClick={onClose}
    >
      {t('feedback.done')}
    </Button>
  ) : (
    <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button
        variant="ghost"
        size="md"
        onClick={handleClose}
        disabled={phase === 'submitting'}
        testId="feedback-cancel"
      >
        {t('common.cancel')}
      </Button>
      <Button
        variant="primary"
        size="md"
        onClick={() => { void handleSubmit(); }}
        loading={phase === 'submitting'}
        testId="feedback-submit"
        iconLeft={<MessageSquarePlus />}
      >
        {t('feedback.submit')}
      </Button>
    </div>
  );

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      size="md"
      title={t('feedback.title')}
      description={t('feedback.desc')}
      testId="feedback-dialog"
      initialFocus='[data-testid="feedback-description"]'
      footer={footer}
      error={phase === 'form' && error ? (
        <span data-testid="feedback-error" className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </span>
      ) : undefined}
    >
      {phase === 'success' ? (
        <div
          data-testid="feedback-success"
          role="status"
          className="flex flex-col items-center py-4 text-center"
        >
          <CheckCircle2 className="h-10 w-10 text-success-fg" aria-hidden="true" />
          <p className="mt-3 text-ui font-semibold text-fg-primary">{t('feedback.success.title')}</p>
          <p className="mt-1.5 max-w-sm text-caption leading-relaxed text-fg-secondary">
            {t('feedback.success.body')}
          </p>
          <div className="mt-4 w-full rounded-control border border-line-subtle bg-surface-2/50 px-3 py-2.5">
            <p className="text-micro font-medium text-fg-muted">{t('feedback.requestId.label')}</p>
            <div className="mt-1 flex items-center justify-center gap-2">
              <code
                data-testid="feedback-success-request-id"
                className="min-w-0 break-all text-caption text-fg-strong"
              >
                {receiptId ?? requestId}
              </code>
              <button
                type="button"
                aria-label={t('feedback.requestId.copy')}
                title={t('feedback.requestId.copy')}
                onClick={() => { void copyRequestId(receiptId ?? requestId); }}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-state-hover hover:text-fg-primary transition-colors"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <fieldset>
            <legend className="text-caption font-medium text-fg-secondary">
              {t('feedback.category.label')}
            </legend>
            <div
              role="group"
              aria-label={t('feedback.category.label')}
              className="mt-2 flex flex-wrap gap-2"
            >
              {FEEDBACK_CATEGORIES.map((item) => {
                const active = item.id === category;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`feedback-category-${item.id}`}
                    aria-pressed={active}
                    onClick={() => setCategory(item.id)}
                    className={`inline-flex min-h-touch items-center rounded-full border px-3 text-caption font-medium transition-colors ${
                      active
                        ? 'border-brand/50 bg-brand/15 text-brand-300'
                        : 'border-line-subtle bg-surface-2/50 text-fg-secondary hover:bg-state-hover hover:text-fg-primary'
                    }`}
                  >
                    {t(item.labelKey)}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-micro leading-relaxed text-fg-muted">
              {t(selectedCategory.hintKey)}
            </p>
          </fieldset>

          <div>
            <label
              htmlFor="feedback-description"
              className="text-caption font-medium text-fg-secondary"
            >
              {t('feedback.description.label')}
            </label>
            <textarea
              id="feedback-description"
              data-testid="feedback-description"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                if (error) setError(null);
              }}
              rows={5}
              maxLength={FEEDBACK_DESCRIPTION_MAX}
              placeholder={t('feedback.description.placeholder')}
              aria-describedby="feedback-description-hint"
              className="mt-1.5 w-full resize-y rounded-control-lg border border-line-subtle bg-surface-2/60 px-3 py-2.5 text-ui leading-relaxed text-fg-primary outline-none transition-[border-color,box-shadow] duration-200 ease-apple placeholder:text-fg-muted focus:border-brand/60 focus:ring-2 focus:ring-brand/15"
            />
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <p id="feedback-description-hint" className="text-micro leading-relaxed text-fg-muted">
                {t('feedback.description.hint')}
              </p>
              <span className="shrink-0 text-micro tabular-nums text-fg-muted">
                {t('feedback.description.count', {
                  count: String(Array.from(description).length),
                  max: String(FEEDBACK_DESCRIPTION_MAX),
                })}
              </span>
            </div>
          </div>

          <div className="rounded-control border border-line-subtle bg-surface-2/40 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-micro font-medium text-fg-muted">
                {t('feedback.requestId.label')}
              </span>
              <code
                data-testid="feedback-request-id"
                className="min-w-0 truncate text-micro text-fg-secondary"
              >
                {requestId}
              </code>
              <button
                type="button"
                aria-label={t('feedback.requestId.copy')}
                title={t('feedback.requestId.copy')}
                onClick={() => { void copyRequestId(requestId); }}
                className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-state-hover hover:text-fg-primary transition-colors"
              >
                <Copy className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
            <p className="mt-1 text-micro leading-relaxed text-fg-muted">
              {t('feedback.requestId.hint')}
            </p>
          </div>

          {phase === 'submitting' && (
            <p
              data-testid="feedback-submitting"
              role="status"
              className="flex items-center gap-2 text-caption text-fg-secondary"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('feedback.submitting')}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
