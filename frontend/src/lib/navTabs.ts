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
export const NAV_TABS: readonly NavTabDef[] = [
  { id: 'today', icon: Sun, labelKey: 'nav.today' },
  { id: 'content', icon: Library, labelKey: 'nav.content' },
  { id: 'practice', icon: Dumbbell, labelKey: 'nav.practice' },
  { id: 'profile', icon: UserRound, labelKey: 'nav.profile' },
];

export function formatDueBadge(count: number): string {
  return count > 99 ? '99+' : String(count);
}
