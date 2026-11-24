import React from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { isUntranslated } from '../lib/transcript';
import type { WatchSubtitleMode } from '../lib/layout';

interface WatchSubtitleOverlayProps {
    /** Current sentence only — never the whole transcript (specs/044 §2). */
    enText?: string | null;
    zhText?: string | null;
    /**
     * 字幕三态 (specs/045 §4.2.1). `bilingual` paints English above the Chinese
     * support line, `english` paints only the English line, and `off` renders
     * nothing at all so the video's own captions are used untouched. The watch
     * shell already stops mounting this component when the mode is `off`; the
     * guard here keeps that contract even if a caller forgets.
     */
    mode?: WatchSubtitleMode;
}

/**
 * 观影模式的单句字幕窗 (specs/044 §2 / specs/045 §4.2).
 *
 * A scrim pinned near the lower edge of the media stage — a transparent→dark
 * gradient, not a full-width solid band (specs/045 §4.2). It shows only the
 * sentence that is being spoken: English above as the primary line, Chinese
 * below as the supporting line when the bilingual mode is on. It is
 * `pointer-events-none` end to end so the YouTube iframe keeps every click,
 * including the native control bar / native CC entry (P2-15 §3), and carries no
 * animation at all, which also satisfies the reduce-motion contract without a
 * media-query branch.
 *
 * P2-11: the sizes are fluid and scale with the media stage's own width through
 * container query units (`cqi`), never the page viewport or JS:
 *   English clamp(1.0625rem, 2cqi, 2rem)       → 17px … 32px
 *   Chinese clamp(0.9375rem, 1.7cqi, 1.625rem) → 15px … 26px
 * 1cqi = 1% of the `video-area` container, which App.tsx marks with
 * `container-type: inline-size`. The `text-section` / `text-body-zh` classes
 * stay as the fixed 17/15px fallback: in engines without container queries the
 * inline declaration is dropped as invalid and the token size applies, so no
 * line can ever end up without a font size. English stays above Chinese at
 * every width because both floors and both slopes keep a gap.
 */
const EN_FLUID_SIZE = 'clamp(1.0625rem, 2cqi, 2rem)';
const ZH_FLUID_SIZE = 'clamp(0.9375rem, 1.7cqi, 1.625rem)';

const WatchSubtitleOverlayInner: React.FC<WatchSubtitleOverlayProps> = ({
    enText,
    zhText,
    mode = 'bilingual',
}) => {
    const { t } = useI18n();
    const english = enText?.trim() ?? '';
    // No current sentence (before the first cue / empty payload): hide, do not
    // paint an empty window.
    if (!english || mode === 'off') return null;
    const chinese = mode === 'english' || isUntranslated(zhText ?? undefined)
        ? ''
        : (zhText ?? '').trim();

    return (
        <div
            data-testid="watch-subtitle-overlay"
            data-mode={mode}
            role="region"
            aria-label={t('watchMode.subtitleAria')}
            className="pointer-events-none absolute inset-x-0 bottom-[14%] z-overlay sm:bottom-[16%] xl:bottom-[12%]"
        >
            {/* Scrim, not a band: the gradient is transparent at the top and
                only dark enough behind the type, so the picture runs through it
                (specs/045 §4.2). Safe edges keep the text off the iframe sides. */}
            <div className="bg-gradient-to-t from-app/80 via-app/45 to-transparent px-4 pb-4 pt-6 sm:px-12 sm:pt-10 xl:pt-16">
                <div className="mx-auto w-full max-w-[min(68ch,86%)] text-center">
                    <p
                        data-testid="watch-subtitle-en"
                        style={{ fontSize: EN_FLUID_SIZE }}
                        className={`text-section font-semibold leading-snug text-fg-primary text-balance ${chinese ? 'mb-0.5' : ''}`}
                    >
                        {english}
                    </p>
                    {chinese && (
                        <p
                            data-testid="watch-subtitle-zh"
                            style={{ fontSize: ZH_FLUID_SIZE }}
                            className="text-body-zh leading-snug text-fg-strong text-balance"
                        >
                            {chinese}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
};

// The parent re-renders every playback tick; memo keeps this to sentence
// boundaries only, so the window never flickers on a 100ms update.
export const WatchSubtitleOverlay = React.memo(WatchSubtitleOverlayInner);
