import React from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { isUntranslated } from '../lib/transcript';

interface WatchSubtitleOverlayProps {
    /** Current sentence only — never the whole transcript (specs/044 §2). */
    enText?: string | null;
    zhText?: string | null;
}

/**
 * 观影模式的单句字幕窗 (specs/044 §2).
 *
 * One translucent band pinned near the lower edge of the media stage. It
 * shows only the sentence that is being spoken — English above as the primary
 * line (`text-section`, 17px), Chinese below as the supporting line
 * (`text-body-zh`, 15px). Both sizes come from the type scale in
 * tailwind.config.js, so the window never hard-codes px. It is
 * `pointer-events-none` end to end so the YouTube iframe keeps every click and
 * carries no animation at all, which also satisfies the reduce-motion contract
 * without a media-query branch.
 */
const WatchSubtitleOverlayInner: React.FC<WatchSubtitleOverlayProps> = ({
    enText,
    zhText,
}) => {
    const { t } = useI18n();
    const english = enText?.trim() ?? '';
    // No current sentence (before the first cue / empty payload): hide, do not
    // paint an empty window.
    if (!english) return null;
    const chinese = isUntranslated(zhText ?? undefined) ? '' : (zhText ?? '').trim();

    return (
        <div
            data-testid="watch-subtitle-overlay"
            role="region"
            aria-label={t('watchMode.subtitleAria')}
            className="absolute inset-x-0 bottom-[30%] sm:bottom-[18%] xl:bottom-[12%] z-overlay pointer-events-none border-t border-line-subtle bg-overlay backdrop-blur-md"
        >
            <div className="mx-auto max-w-4xl px-4 py-2 text-center">
                <p
                    data-testid="watch-subtitle-en"
                    className={`text-section font-medium leading-snug text-fg-primary text-balance ${chinese ? 'mb-0.5' : ''}`}
                >
                    {english}
                </p>
                {chinese && (
                    <p
                        data-testid="watch-subtitle-zh"
                        className="text-body-zh leading-snug text-fg-strong text-balance"
                    >
                        {chinese}
                    </p>
                )}
            </div>
        </div>
    );
};

// The parent re-renders every playback tick; memo keeps this to sentence
// boundaries only, so the window never flickers on a 100ms update.
export const WatchSubtitleOverlay = React.memo(WatchSubtitleOverlayInner);
