// Confirmation dialog built on the shared Dialog shell (A2 §C4 / A3 IX-24).
//
// Contract:
//   - question title + optional consequence line; cancel is the initial focus;
//   - Escape and the backdrop cancel (Dialog owns both; busy disables them);
//   - `onConfirm` may be async: the danger button shows a spinner, every close
//     path is blocked while it runs, and a rejection keeps the dialog open
//     with an inline `role="alert"` error that can be retried;
//   - resolving `onConfirm` closes through `onClose`;
//   - never nests another Dialog, never touches `window.confirm/alert`.
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { Button } from './Button';
import { Dialog } from './Dialog';

export interface ConfirmDialogProps {
    /** Controlled visibility. */
    open: boolean;
    /** Question title, including the object (e.g. 「删除这条学习记录？」). */
    title: ReactNode;
    /** Optional consequence line: what happens and whether it can be undone. */
    description?: ReactNode;
    /** Danger verb + object (e.g. 「删除这篇文章」), never just 「确定」. */
    confirmLabel: string;
    /** Defaults to the localized 「取消」. */
    cancelLabel?: string;
    /** Red danger action. Default true: a confirmation is for a destructive action. */
    destructive?: boolean;
    /** May be async. Resolve to close; reject to stay open with an inline error. */
    onConfirm: () => void | Promise<void>;
    /** Cancel, Escape, backdrop, X, and successful confirmation all land here. */
    onClose: () => void;
    /** Optional caller-owned error (e.g. a localized delete failure). */
    error?: ReactNode;
    /** Prefix for data-testids; defaults to `confirm-dialog`. */
    testId?: string;
}

function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message.trim()) return error.message;
    if (typeof error === 'string' && error.trim()) return error;
    return fallback;
}

export function ConfirmDialog({
    open,
    title,
    description,
    confirmLabel,
    cancelLabel,
    destructive = true,
    onConfirm,
    onClose,
    error,
    testId = 'confirm-dialog',
}: ConfirmDialogProps) {
    const { t } = useI18n();
    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    // A fresh open always starts from a clean state, even when the previous
    // confirmation failed and the caller reopens for another row.
    useEffect(() => {
        if (!open) {
            setPending(false);
            setFailure(null);
        }
    }, [open]);

    const handleConfirm = async () => {
        if (pending) return;
        setPending(true);
        setFailure(null);
        try {
            await onConfirm();
            onClose();
        } catch (err) {
            setFailure(errorMessage(err, t('errors.unknown')));
            // The danger button was disabled while pending; put focus back on
            // the safe action so keyboard users are not dropped to <body>.
            window.setTimeout(() => {
                document
                    .querySelector<HTMLButtonElement>(`[data-testid="${testId}-cancel"]`)
                    ?.focus({ preventScroll: true });
            }, 0);
        } finally {
            setPending(false);
        }
    };

    const shownError = error ?? failure;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={title}
            description={description}
            role="dialog"
            size="sm"
            loading={pending}
            initialFocus={`[data-testid="${testId}-cancel"]`}
            error={shownError}
            testId={testId}
            footer={
                <>
                    <Button
                        variant="secondary"
                        onClick={onClose}
                        disabled={pending}
                        testId={`${testId}-cancel`}
                        className="w-full sm:w-auto"
                    >
                        {cancelLabel ?? t('common.cancel')}
                    </Button>
                    <Button
                        variant={destructive ? 'destructive' : 'primary'}
                        onClick={() => {
                            void handleConfirm();
                        }}
                        loading={pending}
                        testId={`${testId}-confirm`}
                        className="w-full sm:w-auto"
                    >
                        {confirmLabel}
                    </Button>
                </>
            }
        />
    );
}
