// One card in a Content shelf: local-show series and public-domain book cards
// share the same media area, title/meta rhythm, hover and focus treatment.
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Card } from './Card';

export interface CollectionCardProps {
  testId?: string;
  ariaLabel?: string;
  onClick: () => void;
  /** Media area content — an `<img>` for shows, an icon tile for books. */
  visual: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  className?: string;
}

export function CollectionCard({
  testId,
  ariaLabel,
  onClick,
  visual,
  title,
  subtitle,
  meta,
  badge,
  className,
}: CollectionCardProps) {
  return (
    <Card
      variant="interactive"
      padding="none"
      testId={testId}
      ariaLabel={ariaLabel}
      onClick={onClick}
      className={cn('group flex min-w-0 w-full flex-col p-3.5 text-left', className)}
    >
      <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-lg border border-line-subtle bg-surface-2/50">
        {visual}
        {badge && <span className="absolute right-2 top-2">{badge}</span>}
      </div>
      <h4 className="mt-3 line-clamp-2 min-h-[2.6em] break-words text-[14px] font-semibold leading-snug text-fg-primary">
        {title}
      </h4>
      {subtitle && <p className="mt-0.5 truncate text-[11px] text-fg-muted">{subtitle}</p>}
      {meta && (
        <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-[11px] text-fg-muted">
          {meta}
        </div>
      )}
    </Card>
  );
}

export default CollectionCard;
