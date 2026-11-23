// Shared desktop page container (docs/设计-桌面布局规范.md §2 / §6).
//
// One page prototype = exactly one variant. Screens never pick their own
// `max-w-*`: the prototype decides the measure (a semantic maxWidth token in
// tailwind.config.js), while centering and the horizontal page padding are
// identical everywhere. Vertical rhythm stays with the screen (most sub views
// already own `py-4 sm:py-8`), so this component only owns the horizontal axis.
import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type PageContainerVariant =
  | 'wide'
  | 'standard'
  | 'reading'
  | 'marketing'
  | 'focused';

const VARIANT_CLASSES: Record<PageContainerVariant, string> = {
  wide: 'max-w-page-wide',
  standard: 'max-w-page-standard',
  reading: 'max-w-page-reading 2xl:max-w-page-reading-lg',
  marketing: 'max-w-page-marketing',
  focused: 'max-w-page-focused',
};

export interface PageContainerProps extends HTMLAttributes<HTMLElement> {
  /** Page prototype; `standard` is the safe default for reports/forms. */
  variant?: PageContainerVariant;
  /** Rendered element, e.g. `main`; defaults to a plain `div`. */
  as?: ElementType;
  testId?: string;
  children?: ReactNode;
}

export function PageContainer({
  variant = 'standard',
  as,
  testId = 'page-container',
  className,
  children,
  ...rest
}: PageContainerProps) {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag
      {...rest}
      data-testid={testId}
      data-page-variant={variant}
      className={cn(
        'mx-auto w-full px-4 sm:px-6 lg:px-8',
        VARIANT_CLASSES[variant],
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export default PageContainer;
