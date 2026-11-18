/**
 * Shared reading-column width (components.md §18, C-09).
 *
 * Returns a token class rather than an ad-hoc `max-w-*` pair so the four
 * readers cannot drift apart. Existing `BilingualRow` keeps its local helper
 * until that file is migrated in a later batch (old alias rule, B1).
 */
export function bilingualReadingWidth(twoColumn: boolean): string {
  return twoColumn ? 'max-w-library' : 'max-w-reading';
}
