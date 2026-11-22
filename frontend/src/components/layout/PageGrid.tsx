// Two-column page grid (docs/设计-桌面布局规范.md §2 / §6).
//
// Below `xl` it is one column in source order (main, then rail); at `xl` and
// above it becomes `minmax(0, 1fr) 20rem` with 24–32px gutters. The track
// template lives in tailwind.config.js as `grid-page-rail` so every page gets
// the same 320px rail instead of inventing its own split.
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface PageGridProps extends HTMLAttributes<HTMLDivElement> {
  /** Page body / primary column. */
  children?: ReactNode;
  /** Right rail slot; omit for a single-column page. */
  rail?: ReactNode;
  testId?: string;
  mainTestId?: string;
  railTestId?: string;
}

export function PageGrid({
  children,
  rail,
  testId = 'page-grid',
  mainTestId = 'page-grid-main',
  railTestId = 'page-grid-rail',
  className,
  ...rest
}: PageGridProps) {
  return (
    <div
      {...rest}
      data-testid={testId}
      data-has-rail={rail ? 'true' : 'false'}
      className={cn(
        'grid grid-cols-1 gap-6',
        rail && 'xl:grid-cols-page-rail xl:gap-8',
        className,
      )}
    >
      <div data-testid={mainTestId} className="min-w-0">
        {children}
      </div>
      {rail ? (
        <div data-testid={railTestId} className="min-w-0">
          {rail}
        </div>
      ) : null}
    </div>
  );
}

export default PageGrid;
