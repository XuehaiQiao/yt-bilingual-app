// 观影模式 floating top bar (specs/045 §4.1 / P2-15 §1).
//
// The immersive shell renders no AppShell top bar and no LearningHeader; this
// is the only chrome the watch stage keeps: back, title + source, the
// 观影模式 chip, the subtitle (CC) control and 退出观影. It floats over the top
// of the watch stage, fades out after 2.5s of pointer/keyboard stillness and
// comes back on any pointer, touch or key activity. The CC popover is a real
// control backed by a real persisted preference (subtitle mode) — there is no
// fake settings button. P2-25 removed the P2-22 画面大小 popover: picture size
// and the picture/rail split are one semantic (the watch split divider), so
// the top bar must not carry a second, conflicting size control. The YouTube
// embed keeps its own controls and its native CC entry (P2-15 §3).
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Check, Minimize2, Subtitles } from 'lucide-react';
import { BackButton } from './ui/BackButton';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import {
  WATCH_SUBTITLE_MODES,
  type WatchSubtitleMode,
} from '../lib/layout';

/** "2.5s 静止淡出" (specs/045 §4.1): one constant, also asserted by the script. */
export const WATCH_TOPBAR_IDLE_MS = 2500;
/** Native YouTube controls fade at ~4s; the subtitle waits for that, not the chrome's 2.5s. */
export const WATCH_SUBTITLE_DOCK_MS = 4000;

const MODE_LABEL_KEYS: Record<WatchSubtitleMode, TranslationKey> = {
  bilingual: 'watchMode.subtitleMode.bilingual',
  english: 'watchMode.subtitleMode.english',
  off: 'watchMode.subtitleMode.off',
};

const MODE_HINT_KEYS: Record<WatchSubtitleMode, TranslationKey> = {
  bilingual: 'watchMode.subtitleMode.bilingualHint',
  english: 'watchMode.subtitleMode.englishHint',
  off: 'watchMode.subtitleMode.offHint',
};

interface WatchTopBarProps {
  /** Video title (falls back to the shell's unknown-video copy upstream). */
  title: string;
  /** Source / channel line under the title on ≥sm. */
  source?: string;
  subtitleMode: WatchSubtitleMode;
  onSubtitleModeChange: (mode: WatchSubtitleMode) => void;
  onBack: () => void;
  /** Leaves 观影模式 (layout + page fullscreen), same path as the old toggle. */
  onExit: () => void;
}

export function WatchTopBar({
  title,
  source,
  subtitleMode,
  onSubtitleModeChange,
  onBack,
  onExit,
}: WatchTopBarProps) {
  const { t } = useI18n();
  const [idle, setIdle] = useState(false);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const barRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const idleTimer = useRef<number | null>(null);
  // A ref mirrors the "do not hide" condition so the window activity listeners
  // can stay stable across renders (no re-binding on every menu/focus/hover
  // change). It is written in an effect, never during render.
  const keepAlive = open || focused || hovered;
  const keepAliveRef = useRef(keepAlive);
  useEffect(() => {
    keepAliveRef.current = keepAlive;
  }, [keepAlive]);

  const clearIdleTimer = useCallback(() => {
    if (idleTimer.current !== null) {
      window.clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
  }, []);

  const scheduleIdle = useCallback(() => {
    clearIdleTimer();
    if (keepAliveRef.current) return;
    idleTimer.current = window.setTimeout(() => setIdle(true), WATCH_TOPBAR_IDLE_MS);
  }, [clearIdleTimer]);

  const reveal = useCallback(() => {
    setIdle(false);
    scheduleIdle();
  }, [scheduleIdle]);

  // Any pointer / touch / key activity brings the bar back (specs/045 §4.1).
  useEffect(() => {
    const onActivity = () => reveal();
    window.addEventListener('pointermove', onActivity, { passive: true });
    window.addEventListener('pointerdown', onActivity, { passive: true });
    window.addEventListener('touchstart', onActivity, { passive: true });
    window.addEventListener('keydown', onActivity);
    // The bar starts visible: the first effect on mount is the fade-out,
    // never a fade-in. The timer is the only thing this effect needs to arm.
    scheduleIdle();
    return () => {
      window.removeEventListener('pointermove', onActivity);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('touchstart', onActivity);
      window.removeEventListener('keydown', onActivity);
      clearIdleTimer();
    };
  }, [reveal, scheduleIdle, clearIdleTimer]);

  // While the menu is open / focus is inside / the pointer rests on the bar the
  // bar must not disappear under the learner's hands; it re-arms on leave.
  useEffect(() => {
    if (keepAlive) {
      // Any interaction path that turns keepAlive on already revealed the bar
      // from its own event handler; the effect only has to cancel the fade.
      clearIdleTimer();
    } else {
      scheduleIdle();
    }
  }, [keepAlive, clearIdleTimer, scheduleIdle]);

  // Close the popover on an outside pointer press.
  useEffect(() => {
    if (!open) return;
    const onOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (!(menuRef.current?.contains(target) || triggerRef.current?.contains(target))) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onOutside);
    return () => window.removeEventListener('pointerdown', onOutside);
  }, [open]);

  // Focus the checked mode when the CC menu opens (arrow-key entry point).
  useEffect(() => {
    if (!open) return;
    const index = Math.max(0, WATCH_SUBTITLE_MODES.indexOf(subtitleMode));
    itemRefs.current[index]?.focus();
  }, [open, subtitleMode]);

  const closeMenu = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const selectMode = useCallback((mode: WatchSubtitleMode) => {
    onSubtitleModeChange(mode);
    closeMenu(true);
  }, [closeMenu, onSubtitleModeChange]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const count = WATCH_SUBTITLE_MODES.length;
    const current = itemRefs.current.findIndex((item) => item === document.activeElement);
    const move = (next: number) => {
      event.preventDefault();
      itemRefs.current[(next + count) % count]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown': move(current + 1); break;
      case 'ArrowUp': move(current - 1); break;
      case 'Home': move(0); break;
      case 'End': move(count - 1); break;
      case 'Escape':
        event.preventDefault();
        closeMenu(true);
        break;
      case 'Tab':
        // Let focus leave naturally, but never leave an orphan menu behind.
        setOpen(false);
        break;
    }
  };

  const onBarBlur = (event: ReactFocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) setFocused(false);
  };

  const modeLabel = t(MODE_LABEL_KEYS[subtitleMode]);
  const subtitleAria = t('watchMode.subtitleToggleAria', { mode: modeLabel });

  return (
    <header
      ref={barRef}
      data-testid="watch-topbar"
      data-idle={idle ? 'true' : 'false'}
      aria-label={t('watchMode.topbarAria')}
      onFocus={() => setFocused(true)}
      onBlur={onBarBlur}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      inert={idle}
      className={`absolute inset-x-0 top-0 z-chrome flex h-12 items-center gap-2 px-3 transition-[opacity,transform] duration-300 ease-apple motion-reduce:transition-none md:h-14 sm:px-4 ${
        idle ? 'pointer-events-none -translate-y-1 opacity-0' : 'opacity-100'
      }`}
    >
      <BackButton
        onBack={onBack}
        testId="watch-topbar-back"
        ariaLabel={t('watchMode.topbarBack')}
        className="shrink-0"
      />

      <div className="min-w-0 flex-1">
        <p
          data-testid="watch-topbar-title"
          title={title}
          className="truncate text-ui font-semibold tracking-tight text-fg-primary md:text-section"
        >
          {title}
        </p>
        {source && (
          <p
            data-testid="watch-topbar-source"
            title={source}
            className="hidden truncate text-micro leading-tight text-fg-muted sm:block"
          >
            {source}
          </p>
        )}
      </div>

      <span
        data-testid="watch-topbar-chip"
        className="hidden shrink-0 items-center gap-1.5 rounded-full border border-line-subtle bg-app/70 px-2 py-0.5 text-micro font-medium text-fg-secondary backdrop-blur-md sm:inline-flex"
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand" />
        {t('watchMode.chip')}
      </span>

      <div className="relative flex shrink-0 items-center gap-1">
        <button
          ref={triggerRef}
          type="button"
          data-testid="watch-subtitle-toggle"
          data-mode={subtitleMode}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={subtitleAria}
          title={subtitleAria}
          onClick={() => setOpen((previous) => !previous)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
            } else if (event.key === 'Escape') {
              closeMenu(false);
            }
          }}
          className={`inline-flex h-9 items-center gap-1.5 rounded-control px-2.5 text-micro font-semibold tracking-wide transition-colors ${
            open
              ? 'bg-state-selected text-fg-primary'
              : 'text-fg-secondary hover:bg-state-hover hover:text-fg-primary'
          }`}
        >
          <Subtitles aria-hidden="true" className="h-4 w-4" />
          <span>CC</span>
          <span data-testid="watch-subtitle-current" className="hidden text-micro font-medium text-fg-muted sm:inline">
            {modeLabel}
          </span>
        </button>

        {open && (
          <div
            ref={menuRef}
            role="menu"
            aria-label={t('watchMode.subtitleMenuAria')}
            data-testid="watch-subtitle-menu"
            onKeyDown={onMenuKeyDown}
            className="absolute right-0 top-full z-popover mt-2 w-[min(18rem,calc(100vw-1.5rem))] overflow-hidden rounded-card border border-line-strong bg-app/95 shadow-elev-2 backdrop-blur-xl"
          >
            <p className="px-3 pb-1 pt-2.5 text-micro font-semibold uppercase tracking-wider text-fg-muted">
              {t('watchMode.subtitleMenuAria')}
            </p>
            {WATCH_SUBTITLE_MODES.map((mode, index) => {
              const checked = mode === subtitleMode;
              return (
                <button
                  key={mode}
                  ref={(node) => { itemRefs.current[index] = node; }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  data-testid={`watch-subtitle-mode-${mode}`}
                  onClick={() => selectMode(mode)}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors ${
                    checked
                      ? 'bg-brand/10 text-fg-primary'
                      : 'text-fg-secondary hover:bg-state-hover hover:text-fg-primary'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block text-ui font-medium">{t(MODE_LABEL_KEYS[mode])}</span>
                    <span className="block text-micro text-fg-muted">{t(MODE_HINT_KEYS[mode])}</span>
                  </span>
                  {checked && <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-400" />}
                </button>
              );
            })}
            <p
              data-testid="watch-subtitle-native-hint"
              className="border-t border-line-subtle px-3 py-2.5 text-micro leading-relaxed text-fg-muted"
            >
              {t('watchMode.subtitleNativeHint')}
            </p>
          </div>
        )}
      </div>

      <button
        type="button"
        data-testid="watch-topbar-exit"
        onClick={onExit}
        aria-label={t('watchMode.exit')}
        title={t('watchMode.exit')}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-ui font-medium text-fg-secondary transition-colors hover:bg-state-hover hover:text-fg-primary active:scale-[0.98]"
      >
        <Minimize2 aria-hidden="true" className="h-4 w-4" />
        <span className="hidden md:inline">{t('watchMode.exit')}</span>
      </button>
    </header>
  );
}
