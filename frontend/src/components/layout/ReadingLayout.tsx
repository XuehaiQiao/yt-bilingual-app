// Reading page layout (docs/设计-桌面布局规范.md §2 / §6).
//
// A reading page is one 1200px container: a body column capped at 68ch plus an
// optional 320px rail (table of contents / language points / vocabulary). The
// body measure stays readable on wide screens instead of stretching to fill the
// viewport. This card only ships the API — P2-04 wires the readers to it.
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { PageContainer } from './PageContainer';
import { PageGrid } from './PageGrid';
import { SideRail } from './SideRail';

export interface ReadingLayoutProps {
  /** Article body. */
  children?: ReactNode;
  /** Right rail content; omit for a body-only reading page. */
  rail?: ReactNode;
  railTitle?: ReactNode;
  railDescription?: ReactNode;
  /** Consistent empty rail copy when the rail has nothing to show. */
  railEmpty?: ReactNode;
  railSticky?: boolean;
  bodyTestId?: string;
  railTestId?: string;
  gridTestId?: string;
  testId?: string;
  className?: string;
  bodyClassName?: string;
}

export function ReadingLayout({
  children,
  rail,
  railTitle,
  railDescription,
  railEmpty,
  railSticky = true,
  bodyTestId = 'reading-body',
  railTestId = 'reading-rail',
  gridTestId = 'reading-grid',
  testId = 'reading-layout',
  className,
  bodyClassName,
}: ReadingLayoutProps) {
  const railNode =
    rail !== undefined && rail !== null ? (
      <SideRail
        testId={railTestId}
        title={railTitle}
        description={railDescription}
        empty={railEmpty}
        sticky={railSticky}
      >
        {rail}
      </SideRail>
    ) : undefined;

  return (
    <PageContainer variant="reading" testId={testId} className={className}>
      <PageGrid testId={gridTestId} rail={railNode}>
        <div
          data-testid={bodyTestId}
          className={cn('w-full max-w-reading-body leading-relaxed', bodyClassName)}
        >
          {children}
        </div>
      </PageGrid>
    </PageContainer>
  );
}

export default ReadingLayout;
