// Shared tab metadata for the desktop top bar and the mobile bottom bar.
// Lives outside the components so both can import it without tripping the
// react-refresh "only export components" rule.
import type { LucideIcon } from 'lucide-react';
import { Dumbbell, Library, Sun, UserRound } from 'lucide-react';
import type { TabId } from './nav';
import type { TranslationKey } from '../i18n';

export interface NavTabDef {
  id: TabId;
  icon: LucideIcon;
  labelKey: TranslationKey;
}

/** Fixed at four: a new first-level page must replace one, never append (§2.1). */
// Owner order (2026-11-17): Content first, Today third. The default landing
// route is unchanged (today); this array only controls the visible tab order.
export const NAV_TABS: readonly NavTabDef[] = [
  { id: 'content', icon: Library, labelKey: 'nav.content' },
  { id: 'practice', icon: Dumbbell, labelKey: 'nav.practice' },
  { id: 'today', icon: Sun, labelKey: 'nav.today' },
  { id: 'profile', icon: UserRound, labelKey: 'nav.profile' },
];

/** One-line subtitle under the page title in the desktop top bar (≥lg). */
export const TAB_SUBTITLE_KEYS: Record<TabId, TranslationKey> = {
  today: 'topbar.subtitle.today',
  content: 'content.subtitle',
  practice: 'practice.subtitle',
  profile: 'profile.subtitle',
};

export function formatDueBadge(count: number): string {
  return count > 99 ? '99+' : String(count);
}
