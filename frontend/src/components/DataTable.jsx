/**
 * DataTable: shadcn's <Table> driven by TanStack Table v9.
 *
 * TanStack does the bookkeeping (sort order, which rows are on this page);
 * we only describe the columns and render. Columns are plain objects:
 *   { id, header, accessorFn: (row) => value-to-sort-by, cell: ({ row }) => JSX,
 *     meta: { numeric, hint } }
 * meta.numeric right-aligns the column; meta.hint puts an explanation in a
 * tooltip on the header. Sorting: click a header (again to flip the order).
 * Long tables scroll inside a box of maxHeight with a sticky header; pass
 * maxHeight="none" for short tables so they simply grow with the page.
 */
import { useState } from 'react';
import {
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { EmptyState } from './Common';

// v9 is feature-based: only what is listed here ends up in the bundle.
const features = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, datetime: sortFn_datetime },
});

// The row's bottom border scrolls away with a sticky header, so the cells draw their own.
const STICKY = 'sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--border)]';

// Only the sorted column reserves room for its arrow; other sortable columns show
// a hint icon on hover that floats beside the label, so narrow tables stay narrow.
function SortIcon({ direction, numeric }) {
  if (direction === 'asc') return <ArrowUp className="size-4" aria-hidden="true" />;
  if (direction === 'desc') return <ArrowDown className="size-4" aria-hidden="true" />;
  return (
    <ChevronsUpDown
      className={cn('absolute top-1/2 size-4 -translate-y-1/2 opacity-0 transition-opacity group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100', numeric ? 'right-full' : 'left-full')}
      aria-hidden="true"
    />
  );
}

function HeaderCell({ header, table }) {
  const { column } = header;
  const meta = column.columnDef.meta || {};
  const label = <table.FlexRender header={header} />;
  const canSort = column.getCanSort();
  const direction = column.getIsSorted();

  let content = label;
  if (canSort) {
    content = (
      <button
        type="button"
        onClick={column.getToggleSortingHandler()}
        className={cn(
          'group/sort relative -mx-2 inline-flex h-8 items-center gap-2 rounded-md px-2 uppercase hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
          meta.numeric && 'flex-row-reverse',
          direction && 'text-foreground',
        )}
      >
        {label}
        <SortIcon direction={direction} numeric={meta.numeric} />
      </button>
    );
  }
  if (meta.hint) {
    content = (
      <Tooltip>
        <TooltipTrigger asChild>{canSort ? content : <span tabIndex={0} className="cursor-help">{content}</span>}</TooltipTrigger>
        <TooltipContent className="normal-case tracking-normal">{meta.hint}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <TableHead
      // Sticky header: stays visible while the table body scrolls.
      className={cn(STICKY, meta.numeric && 'text-right', meta.headerClassName)}
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : undefined}
    >
      {content}
    </TableHead>
  );
}

export default function DataTable({
  columns,
  data,
  getRowId,
  initialSort = [],
  pageSize = 20,
  maxHeight = '70vh',
  onRowClick,
  emptyText = 'No rows',
  label,
}) {
  const [sorting, setSorting] = useState(initialSort);
  const table = useTable({
    features,
    data,
    columns,
    getRowId,
    onSortingChange: setSorting,
    state: { sorting },
    initialState: { pagination: { pageIndex: 0, pageSize } },
  });

  const rows = table.getRowModel().rows;
  const total = data.length;
  const { pageIndex } = table.state.pagination; // v9: table.state, re-rendered on change
  const paged = total > pageSize;
  const first = pageIndex * pageSize + 1;
  const last = Math.min(total, (pageIndex + 1) * pageSize);

  return (
    <div>
      {/* The container scrolls (both ways); with a max height the sticky header stays in view. */}
      <Table aria-label={label} containerClassName="overflow-auto" containerStyle={{ maxHeight }}>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="h-10 hover:bg-transparent">
              {headerGroup.headers.map((header) => (header.isPlaceholder
                ? <TableHead key={header.id} className={STICKY} />
                : <HeaderCell key={header.id} header={header} table={table} />))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length ? rows.map((row) => (
            <TableRow
              key={row.id}
              className={cn(onRowClick && 'cursor-pointer')}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
            >
              {row.getAllCells().map((cell) => { // v9: getVisibleCells needs the column-visibility feature
                const meta = cell.column.columnDef.meta || {};
                return (
                  <TableCell key={cell.id} className={cn(meta.numeric && 'text-right', meta.cellClassName)}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                );
              })}
            </TableRow>
          )) : (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="p-0">
                <EmptyState>{emptyText}</EmptyState>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {paged && (
        <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span>
            {first}–{last} of {total}
          </span>
          <div className="flex items-center gap-2">
            <span>
              Page {pageIndex + 1} of {table.getPageCount()}
            </span>
            <Button variant="outline" size="icon-sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Next page">
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
