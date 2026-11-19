// Shared shelf chrome for the Content page's collections (local video shows and
// public-domain book series). The two sections used to be one card + one bare
// section; this keeps the container, header hierarchy, padding and spacing in
// one place so a collection reads the same regardless of media type.
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Card } from './Card';

export interface ShelfSectionProps {
  icon: LucideIcon;
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  testId?: string;
  className?: string;
  children: ReactNode;
}

export function ShelfSection({
  icon: Icon,
  title,
  hint,
  actions,
  testId,
  className,
  children,
}: ShelfSectionProps) {
  return (
    <Card as="section" testId={testId} className={cn('min-w-0', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Icon className="h-4 w-4 shrink-0 text-brand-400" aria-hidden="true" />
          <h3 className="text-[15px] font-semibold tracking-tight text-fg-primary">{title}</h3>
          {hint && <span className="text-[11px] text-fg-muted">{hint}</span>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="mt-3">{children}</div>
    </Card>
  );
}

export default ShelfSection;
