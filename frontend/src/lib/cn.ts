import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `tailwind-merge` only knows Tailwind's stock scale, so semantic theme names
 * such as `text-ui` / `h-control-md` would be misclassified (e.g. `text-ui`
 * swallowed as a text colour when paired with `text-fg-strong`). Register the
 * design tokens here so merging keeps the intended utility and still lets a
 * later layout override win.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'micro', 'caption', 'ui', 'body-zh', 'body', 'section',
            'dialog', 'page', 'page-lg', 'display-sm', 'display', 'display-lg',
          ],
        },
      ],
      h: [{ h: ['control-xs', 'control-sm', 'control-md', 'control-lg', 'control-xl', 'subheader', 'topbar', 'topbar-mobile', 'bottombar', 'sidebar-header'] }],
      'min-h': [{ 'min-h': ['touch'] }],
      w: [{ w: ['sidebar', 'sidebar-collapsed'] }],
      'max-w': [{ 'max-w': ['page', 'admin', 'library', 'course', 'reading', 'task', 'rail', 'dialog-sm', 'dialog-md', 'dialog-lg'] }],
      rounded: [{ rounded: ['control', 'control-lg', 'card', 'layer', 'panel'] }],
      z: [{ z: ['base', 'raised', 'chrome', 'nav', 'overlay', 'dialog', 'popover', 'toast'] }],
    },
  },
});

/**
 * Merge conditional class names and let later Tailwind utilities win over
 * earlier ones with the same property (e.g. `px-5` overrides `px-3`).
 *
 * Single source for the whole app (A2 components.md §18): UI atoms must import
 * this instead of reaching into a business component for `cn`.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type { ClassValue };
