// Shared table primitives (A2 components.md §C14 · tokens.md §2/§4).
//
// One semantic table recipe: a real <table>/<thead>/<tbody>, header on the
// surface-2 tone, rows hover through state-hover, numeric/action columns
// right-aligned with tabular-nums, and the wrapper owning horizontal scroll
// so a 375px phone scrolls the table instead of widening the page.
//
// Cells wrap by default (tokens.md §3.3); dense admin columns opt into
// `nowrap`. The caller keeps the card frame and only adds layout overrides.
import type {
  HTMLAttributes,
  ReactNode,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';
import { cn } from '../../lib/cn';

export interface TableProps {
  children: ReactNode;
  /** Minimum table width before the wrapper scrolls horizontally. */
  minWidth?: number;
  /** Accessible name, rendered as a visually hidden <caption>. */
  caption?: string;
  testId?: string;
  /** Layout overrides for the <table> only. */
  className?: string;
  /** Layout overrides for the scroll container (e.g. rounding). */
  wrapperClassName?: string;
}

export function Table({
  children,
  minWidth,
  caption,
  testId,
  className,
  wrapperClassName,
}: TableProps) {
  return (
    <div className={cn('overflow-x-auto custom-scrollbar', wrapperClassName)}>
      <table
        data-testid={testId}
        className={cn('w-full text-left text-ui text-fg-strong', className)}
        style={minWidth ? { minWidth } : undefined}
      >
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function TableHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <thead className={cn('bg-surface-2/60 text-caption text-fg-muted', className)}>
      {children}
    </thead>
  );
}

export function TableBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <tbody className={cn('divide-y divide-line-subtle', className)}>{children}</tbody>;
}

export function TableFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <tfoot className={cn('bg-surface-2/40 text-ui text-fg-strong', className)}>
      {children}
    </tfoot>
  );
}

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Row hover tint (state-hover); keep it for scannable data tables. */
  hover?: boolean;
}

export function TableRow({ hover = true, className, children, ...rest }: TableRowProps) {
  return (
    <tr
      {...rest}
      className={cn(
        'transition-colors duration-200 ease-apple',
        hover && 'hover:bg-state-hover',
        className,
      )}
    >
      {children}
    </tr>
  );
}

export interface TableHeaderCellProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'center' | 'right';
  /** Numeric column: right-aligned, tabular-nums. */
  numeric?: boolean;
  nowrap?: boolean;
}

export function TableHeaderCell({
  align = 'left',
  numeric = false,
  nowrap = false,
  scope = 'col',
  className,
  children,
  ...rest
}: TableHeaderCellProps) {
  return (
    <th
      scope={scope}
      {...rest}
      className={cn(
        'px-4 py-2.5 align-middle font-medium',
        nowrap && 'whitespace-nowrap',
        numeric && 'text-right tabular-nums',
        align === 'center' && 'text-center',
        align === 'right' && 'text-right',
        className,
      )}
    >
      {children}
    </th>
  );
}

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'center' | 'right';
  /** Numeric column: right-aligned, tabular-nums. */
  numeric?: boolean;
  /** Secondary information (email, timestamps) uses fg-secondary. */
  muted?: boolean;
  nowrap?: boolean;
}

export function TableCell({
  align = 'left',
  numeric = false,
  muted = false,
  nowrap = false,
  className,
  children,
  ...rest
}: TableCellProps) {
  return (
    <td
      {...rest}
      className={cn(
        'px-4 py-2.5 align-middle',
        nowrap && 'whitespace-nowrap',
        numeric && 'text-right tabular-nums',
        align === 'center' && 'text-center',
        align === 'right' && 'text-right',
        muted && 'text-fg-secondary',
        className,
      )}
    >
      {children}
    </td>
  );
}

export interface TableMessageRowProps {
  /** Number of visual columns the message spans. */
  colSpan: number;
  children: ReactNode;
  testId?: string;
}

/** Full-width empty/loading row. Loading spinners stay with the caller. */
export function TableMessageRow({ colSpan, children, testId }: TableMessageRowProps) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        data-testid={testId}
        className="px-4 py-10 text-center text-ui text-fg-secondary"
      >
        {children}
      </td>
    </tr>
  );
}

export default Table;
