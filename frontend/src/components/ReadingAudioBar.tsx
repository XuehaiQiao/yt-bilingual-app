// Shared reading audio bar (specs/037).
//
// One bar for all five reading surfaces: the four prose readers and the
// sentence-pack view. It is the only place that renders playback controls, so
// the "listen / shadow" affordance cannot drift between screens. State lives in
// `lib/useReadingAudio.ts`; this file is presentation only.
//
// Rules it encodes:
//   - `ReadingAudioTrigger` is the entry point every toolbar renders. It stays
//     enabled while the engine is missing so the click can OPEN the bar and read
//     the explicit "no English voice" message — a disabled trigger would be a
//     silent failure (specs/037 §1.7, §4).
//   - `ReadingAudioBar` is fixed to the bottom of the reading pane, not to the
//     viewport shell, and measures itself so the reader can reserve exactly that
//     much padding (the text must never end up under the bar).
//   - Colours/materials come from tokens (`surface` / `line` / `brand` /
//     `warning-fg` / `shadow-elev-2`), never from a base palette literal.
//   - Nothing animates on its own; the only motion is the browser's smooth
//     scroll, which the hook switches off under `prefers-reduced-motion`.
import { useEffect, useRef } from 'react';
import { Headphones, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import {
    READING_AUDIO_RATES,
    type ReadingAudioController,
} from '../lib/useReadingAudio';
import { Button, IconButton } from './ui/Button';
import { Menu } from './ui/Menu';
import { Switch } from './ui/Switch';

/** Speed label, e.g. `1.25×` — a number plus a symbol, so it is not translated. */
const rateLabel = (rate: number) => `${rate}×`;

interface ReadingAudioTriggerProps {
    audio: ReadingAudioController;
    testId?: string;
}

/** Toolbar entry point: opens / closes the bar. */
export const ReadingAudioTrigger: React.FC<ReadingAudioTriggerProps> = ({
    audio,
    testId = 'reading-audio-trigger',
}) => {
    const { t } = useI18n();
    return (
        <Button
            variant={audio.isOpen ? 'tinted' : 'secondary'}
            tone="brand"
            size="sm"
            iconLeft={<Headphones />}
            onClick={audio.toggleOpen}
            disabled={!audio.hasContent}
            ariaLabel={t('reading.audio.triggerHint')}
            testId={testId}
        >
            {t('reading.audio.trigger')}
        </Button>
    );
};

interface ReadingAudioBarProps {
    audio: ReadingAudioController;
    /** Prefix for every `data-testid` this bar renders. */
    testIdPrefix?: string;
}

export const ReadingAudioBar: React.FC<ReadingAudioBarProps> = ({
    audio,
    testIdPrefix = 'reading-audio',
}) => {
    const { t } = useI18n();
    const barRef = useRef<HTMLDivElement>(null);
    const setBarHeight = audio.setBarHeight;

    // Report the real height (it wraps to two or three rows at 375px) so the
    // reader's scroll container can reserve that much bottom padding.
    useEffect(() => {
        const node = barRef.current;
        if (!node) return;
        const report = () => setBarHeight(node.getBoundingClientRect().height);
        report();
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(report) : null;
        observer?.observe(node);
        window.addEventListener('resize', report);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', report);
            setBarHeight(0);
        };
        // `isOpen` is a dependency: the bar only mounts its node once open, and
        // the effect cannot observe a ref that was still null on the first run.
    }, [audio.isOpen, setBarHeight]);

    if (!audio.isOpen) return null;

    const testId = (suffix: string) => `${testIdPrefix}-${suffix}`;
    const playing = audio.state === 'playing' || audio.state === 'waiting';
    const disabled = !audio.supported || !audio.hasContent;

    const status = !audio.supported
        ? t('reading.audio.unsupported')
        : audio.failure === 'failed'
            ? t('reading.audio.failed')
            : !audio.hasContent
                ? t('reading.audio.none')
                : audio.active
                    ? t('reading.audio.position', {
                        paragraph: audio.active.paragraph + 1,
                        sentence: audio.active.sentence + 1,
                    })
                    : t('reading.audio.idle');
    const hasNotice = !audio.supported || audio.failure === 'failed' || !audio.hasContent;
    const statusTone = !audio.supported || audio.failure === 'failed'
        ? 'text-warning-fg'
        : 'text-fg-secondary';
    // A normal position tag is one short line and may truncate; a notice ("no
    // English voice", "playback failed", "nothing to read") is the actual
    // message and must stay readable — it takes its own full-width row on a
    // phone instead of being clipped at 375px.
    const statusClass = hasNotice
        ? 'order-5 w-full whitespace-normal sm:order-2 sm:w-auto sm:flex-1'
        : 'order-2 min-w-0 flex-1 truncate';

    return (
        <div
            data-reading-audio-bar=""
            data-testid={testId('bar')}
            data-state={audio.state}
            data-mode={audio.mode}
            data-rate={audio.rate}
            role="region"
            aria-label={t('reading.audio.barLabel')}
            className="fixed inset-x-0 bottom-0 z-chrome px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
        >
            <div
                ref={barRef}
                className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-1.5 gap-y-2 rounded-2xl border border-line-strong bg-surface/90 px-2.5 py-2 shadow-elev-2 backdrop-blur-xl"
            >
                <div className="order-1 flex shrink-0 items-center gap-1">
                    <IconButton
                        ariaLabel={t('reading.audio.previous')}
                        size="sm"
                        onClick={audio.previous}
                        disabled={disabled}
                        testId={testId('previous')}
                    >
                        <SkipBack />
                    </IconButton>
                    <Button
                        variant="tinted"
                        tone="brand"
                        size="sm"
                        iconOnly
                        ariaLabel={playing ? t('reading.audio.pause') : t('reading.audio.play')}
                        onClick={audio.toggle}
                        disabled={disabled}
                        testId={testId('toggle')}
                    >
                        {playing ? <Pause /> : <Play />}
                    </Button>
                    <IconButton
                        ariaLabel={t('reading.audio.next')}
                        size="sm"
                        onClick={audio.next}
                        disabled={disabled}
                        testId={testId('next')}
                    >
                        <SkipForward />
                    </IconButton>
                </div>

                <p
                    data-testid={testId('status')}
                    aria-live="polite"
                    aria-atomic="true"
                    className={`text-micro font-medium ${statusClass} ${statusTone}`}
                >
                    {status}
                </p>

                {/* Secondary controls. On a 375px phone the row cannot hold the
                    transport, the position and these at once; the group takes a
                    second row there (`order` keeps the close button on row one). */}
                <div className="order-4 flex w-full shrink-0 items-center gap-x-3 gap-y-1.5 sm:order-3 sm:w-auto">
                    <label className="inline-flex shrink-0 items-center gap-1.5">
                        <span className="text-micro font-medium text-fg-secondary">
                            {t('reading.audio.shadow')}
                        </span>
                        <Switch
                            checked={audio.mode === 'shadow'}
                            onChange={(checked) => audio.setMode(checked ? 'shadow' : 'continuous')}
                            ariaLabel={t('reading.audio.shadowHint')}
                            title={t('reading.audio.shadowHint')}
                            disabled={disabled}
                            testId={testId('mode')}
                        />
                    </label>

                    <Menu
                        ariaLabel={t('reading.audio.speed')}
                        align="end"
                        menuTestId={testId('rate-menu')}
                        items={READING_AUDIO_RATES.map((rate) => ({
                            id: `rate-${rate}`,
                            label: rateLabel(rate),
                            checked: audio.rate === rate,
                            onSelect: () => audio.setRate(rate),
                            testId: testId(`rate-${rate}`),
                            data: { 'data-rate': String(rate) },
                        }))}
                        disabled={disabled}
                        trigger={({ triggerRef, triggerProps }) => (
                            <button
                                ref={triggerRef}
                                type="button"
                                {...triggerProps}
                                data-testid={testId('rate')}
                                data-rate={audio.rate}
                                aria-label={`${t('reading.audio.speed')} ${rateLabel(audio.rate)}`}
                                title={t('reading.audio.speed')}
                                disabled={disabled}
                                className="inline-flex h-control-xs shrink-0 items-center justify-center rounded-control border border-line-subtle bg-surface-2/60 px-2 text-micro font-medium tabular-nums text-fg-strong transition-colors hover:bg-surface-3/60 disabled:pointer-events-none disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
                            >
                                {rateLabel(audio.rate)}
                            </button>
                        )}
                    />
                </div>

                <IconButton
                    ariaLabel={t('reading.audio.close')}
                    size="sm"
                    onClick={audio.close}
                    className="order-3 sm:order-4"
                    testId={testId('close')}
                >
                    <X />
                </IconButton>

                {audio.state === 'waiting' && (
                    <div
                        data-testid={testId('waiting-actions')}
                        className="order-5 flex w-full flex-wrap items-center gap-1.5 border-t border-line-subtle pt-1.5"
                    >
                        <span className="text-micro font-medium text-brand-300">
                            {t('reading.audio.waiting')}
                        </span>
                        <Button
                            variant="tinted"
                            tone="brand"
                            size="sm"
                            onClick={audio.replay}
                            testId={testId('replay')}
                        >
                            {t('reading.audio.replay')}
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={audio.next}
                            testId={testId('next-hint')}
                        >
                            {t('reading.audio.next')}
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
};
