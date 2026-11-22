// Right-hand side rail for desktop page grids (docs/设计-桌面布局规范.md §2 / §6).
//
// One width (320px), one sticky offset and one title/empty rhythm for every
// page. The offset matches PageContainer's desktop vertical padding (`xl:top-8`
// = 32px), so a stuck rail lines up with the main column when the page scrolls.
// On narrow screens the rail simply stacks below the main column at full width.
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SideRailProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Optional rail heading; 17px/600 like every other section title. */
  title?: ReactNode;
  /** Optional one-line hint under the heading. */
  description?: ReactNode;
  /** Shown instead of the body when the rail has no content yet. */
  empty?: ReactNode;
  /** Disable stickiness for rails that must flow with a short page. */
  sticky?: boolean;
  testId?: string;
  children?: ReactNode;
}

export function SideRail({
  title,
  description,
  empty,
  sticky = true,
  testId = 'side-rail',
  className,
  children,
  ...rest
}: SideRailProps) {
  const hasBody = children !== undefined && children !== null;
  const emptyBody =
    empty !== undefined && empty !== null ? (
      <p className="rounded-panel border border-line-subtle bg-surface/40 p-5 text-ui leading-relaxed text-fg-secondary">
        {empty}
      </p>
    ) : null;

  return (
    <aside
      {...rest}
      data-testid={testId}
      className={cn(
        'w-full min-w-0 xl:max-w-rail',
        sticky && 'xl:sticky xl:top-8',
        className,
      )}
    >
      {(title || description) && (
        <div className="mb-3 min-w-0">
          {title && (
            <h2 className="text-section font-semibold tracking-tight text-fg-primary">
              {title}
            </h2>
          )}
          {description && (
            <p className="mt-0.5 text-caption leading-relaxed text-fg-secondary">
              {description}
            </p>
          )}
        </div>
      )}
      {hasBody ? (
        <div className="flex flex-col gap-4">{children}</div>
      ) : (
        emptyBody
      )}
    </aside>
  );
}

export default SideRail;
