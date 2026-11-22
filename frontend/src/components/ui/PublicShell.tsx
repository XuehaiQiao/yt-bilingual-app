// Shared shell for the public site: home (`/`), blog (`#/blog`), pricing,
// resources and the login page (`#/login`).
//
// Public pages sit outside the app shell (navigation-model.md §8.1), so they
// get one small contract of their own instead of each page re-declaring the
// viewport height, page padding and safe-area handling:
//   - one vertical scroll: the document. `min-h-dvh` only (no `screen`-unit
//     height) and no nested scroller; content taller than the viewport scrolls.
//   - one page measure per mode — marketing 1200 (`max-w-page-marketing`) / auth form
//     448 (`max-w-dialog-sm`) — with the 16/24/32 page padding (layout.md §3.3).
//   - the bottom safe-area inset is added exactly once, at the shell root.
//   - page colours/text defaults come from tokens (`bg-app` / `fg-primary`).
//
// `header`/`footer` are full-bleed slots: the welcome page keeps its own sticky
// header and puts a `PublicContainer` inside each slot. The auth page uses
// `topRight` for the language entry and `contained` for the centred form.
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type PublicShellWidth = 'wide' | 'form';

const WIDTH_CLASSES: Record<PublicShellWidth, string> = {
  wide: 'max-w-page-marketing',
  form: 'max-w-dialog-sm',
};

/** 16 / 24 / 32 horizontal page padding (layout.md §3.3). */
const PAGE_PADDING = 'px-4 sm:px-6 lg:px-8';

export interface PublicContainerProps {
  children: ReactNode;
  width?: PublicShellWidth;
  /** Layout-only overrides (flex/row alignment); visuals stay in the page. */
  className?: string;
}

/** The page measure + horizontal padding used inside headers, sections, footer. */
export function PublicContainer({ children, width = 'wide', className }: PublicContainerProps) {
  return (
    <div className={cn('mx-auto w-full', WIDTH_CLASSES[width], PAGE_PADDING, className)}>
      {children}
    </div>
  );
}

export interface PublicShellProps {
  children: ReactNode;
  /** Full-bleed sticky public header; put a PublicContainer inside it. */
  header?: ReactNode;
  /** Full-bleed footer (optional). */
  footer?: ReactNode;
  /** Top-right utility (language switch), above the content. */
  topRight?: ReactNode;
  /** Page measure: marketing `wide` (1024) or auth `form` (448). */
  width?: PublicShellWidth;
  /**
   * Vertically centre the content between the top and bottom of the viewport.
   * Auto margins are used instead of `justify-center` so content taller than
   * the viewport scrolls from its top edge instead of being clipped above it.
   */
  align?: 'start' | 'center';
  /**
   * Constrain children to the page measure (default). Pass `false` when the
   * page owns full-bleed section dividers and only its inner blocks need the
   * measure.
   */
  contained?: boolean;
  /** Layout escape hatch for the root only. */
  className?: string;
  /** Layout escape hatch for the content block (contained mode). */
  contentClassName?: string;
  /** Root test id so `auth-screen` / `welcome-screen` stay stable. */
  testId?: string;
}

export function PublicShell({
  children,
  header,
  footer,
  topRight,
  width = 'wide',
  align = 'start',
  contained = true,
  className,
  contentClassName,
  testId,
}: PublicShellProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'relative flex min-h-dvh w-full flex-col bg-app text-fg-primary',
        // The one and only safe-area inset for a public page: the last content
        // clears the home indicator; public pages have no bottom bar.
        'pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
      {header}
      {topRight && (
        <div className="absolute right-4 top-4 z-chrome sm:right-6 sm:top-6">{topRight}</div>
      )}
      <main className="flex flex-1 flex-col">
        {contained ? (
          <PublicContainer
            width={width}
            className={cn(align === 'center' && 'my-auto py-16 sm:py-20', contentClassName)}
          >
            {children}
          </PublicContainer>
        ) : (
          <div className={cn('flex flex-1 flex-col', contentClassName)}>{children}</div>
        )}
      </main>
      {footer}
    </div>
  );
}
