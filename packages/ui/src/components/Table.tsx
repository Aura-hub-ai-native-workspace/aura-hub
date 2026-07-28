import { type ReactNode } from 'react';
import { cn } from '@aura/core';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
}

export interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  className?: string;
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

/** A calm, borderless data table with hover rows. Generic over row type. */
export function Table<T>({ columns, data, rowKey, onRowClick, empty, className }: TableProps<T>) {
  return (
    <div className={cn('overflow-x-auto rounded-2xl border border-line bg-surface', className)}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line">
            {columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width }}
                className={cn(
                  'px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-text-subtle',
                  ALIGN[c.align ?? 'left'],
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-[13px] text-text-muted">
                {empty ?? 'Nothing here yet.'}
              </td>
            </tr>
          ) : (
            data.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={() => onRowClick?.(row)}
                className={cn(
                  'border-b border-line/60 last:border-0 transition-colors',
                  onRowClick && 'cursor-pointer hover:bg-surface-hover',
                )}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-4 py-3 text-text', ALIGN[c.align ?? 'left'])}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
