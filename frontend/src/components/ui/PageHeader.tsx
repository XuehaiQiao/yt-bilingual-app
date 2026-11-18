// First-level page title for the mobile layout (design-system/components.md
// C12 / layout.md §2.5 V-15). Desktop titles live in the TopBar (15px), so the
// in-page h1 must disappear at `lg` — otherwise the same viewport shows two
// titles. One h1 per viewport; subtitle 14px, actions at most two.
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface PageHeaderProps {
  title: ReactNode;
  /** Optional one-line description (14px, `fg-secondary`). */
  subtitle?: ReactNode;
  /** Small line above the title (e.g. today's date). */
  eyebrow?: ReactNode;
  /** At most two actions; hidden with the header on desktop. */
  actions?: ReactNode;
  testId?: string;
  titleTestId?: string;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  testId,
  titleTestId,
  className,
}: PageHeaderProps) {
  return (
    <header data-testid={testId} className={cn('lg:hidden', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && (
            <div className="mb-0.5 text-micro font-medium text-fg-muted">{eyebrow}</div>
          )}
          <h1
            data-testid={titleTestId}
            className="text-page font-semibold tracking-tight text-fg-primary md:text-page-lg"
          >
            {title}
          </h1>
          {subtitle && (
            <div className="mt-1 text-ui leading-relaxed text-fg-secondary">{subtitle}</div>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export default PageHeader;
