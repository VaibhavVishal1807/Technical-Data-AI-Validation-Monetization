/** Reports: every report with its latest snapshot. Click a row for its history. */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApi } from '../api';
import { PageHead, PageState, Section, TableSkeleton } from '../components/Common';
import DataTable from '../components/DataTable';
import { BandBadge, OrphanBadge, RefreshBadge, TagBadge } from '../components/Badges';
import { fmtInt, fmtPct, fmtPeriod } from '../format';

const COLUMNS = [
  {
    id: 'report_id',
    header: 'Report',
    accessorFn: (r) => r.report_id,
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <span className="font-mono font-medium">{row.original.report_id}</span>
        <span className="text-muted-foreground">{row.original.report_name}</span>
      </span>
    ),
  },
  {
    id: 'owner',
    header: 'Owner',
    accessorFn: (r) => r.latest_owner_email || '',
    cell: ({ row }) => {
      const r = row.original;
      return r.is_orphaned
        ? <span className="flex items-center gap-2"><OrphanBadge /><span className="text-muted-foreground">last: {r.canonical_owner_email}</span></span>
        : r.latest_owner_email;
    },
  },
  {
    id: 'latest_refresh_status',
    header: 'Last refresh',
    accessorFn: (r) => r.latest_refresh_status,
    cell: ({ row }) => <RefreshBadge status={row.original.latest_refresh_status} />,
  },
  {
    id: 'latest_load_time_sec',
    header: 'Load time',
    accessorFn: (r) => r.latest_load_time_sec,
    meta: { numeric: true, hint: 'Latest average load time. Amber over 15 s, red over 30 s.' },
    cell: ({ row }) => <BandBadge band={row.original.latest_latency_band} seconds={row.original.latest_load_time_sec} />,
  },
  {
    id: 'latest_monthly_active_views',
    header: 'Views',
    accessorFn: (r) => r.latest_monthly_active_views,
    meta: { numeric: true, hint: 'Monthly active views in the latest snapshot' },
    cell: ({ row }) => fmtInt(row.original.latest_monthly_active_views),
  },
  {
    id: 'latency_breach_rate',
    header: 'Slow months',
    accessorFn: (r) => r.latency_breach_rate,
    meta: { numeric: true, hint: 'Share of the 20 months with load time above 15 s' },
    cell: ({ row }) => fmtPct(row.original.latency_breach_rate * 100),
  },
  {
    id: 'failures',
    header: 'Failures',
    accessorFn: (r) => r.failed_refresh_count + r.timed_out_refresh_count,
    meta: { numeric: true, hint: 'Failed or timed-out refreshes, out of 20 months' },
    cell: ({ row }) => `${row.original.failed_refresh_count + row.original.timed_out_refresh_count} / ${row.original.snapshot_count}`,
  },
  {
    id: 'distinct_owner_count',
    header: 'Owners',
    accessorFn: (r) => r.distinct_owner_count,
    meta: { numeric: true, hint: 'Different owners seen across the 20 months' },
    cell: ({ row }) => fmtInt(row.original.distinct_owner_count),
  },
];

function FilterSelect({ value, onChange, label, children }) {
  // Highlighted border while the filter is active.
  return (
    <select className={`select-native ${value ? 'border-muted-foreground text-foreground' : 'text-muted-foreground'}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {children}
    </select>
  );
}

export default function Reports() {
  const reports = useApi('/reports');
  const { data } = reports;
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [band, setBand] = useState('');
  const [ownership, setOwnership] = useState('');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.reports || []).filter((r) => (!q || `${r.report_id} ${r.report_name} ${r.canonical_owner_email}`.toLowerCase().includes(q))
      && (!status || r.latest_refresh_status === status)
      && (!band || r.latest_latency_band === band)
      && (!ownership || (ownership === 'orphaned') === r.is_orphaned));
  }, [data, query, status, band, ownership]);

  const filtered = Boolean(query || status || band || ownership);
  const clearFilters = () => {
    setQuery('');
    setStatus('');
    setBand('');
    setOwnership('');
  };

  return (
    <>
      <PageHead
        title="Reports"
        subtitle={data ? `${data.count} reports, latest snapshot (${fmtPeriod(data.as_of_period)}). Click a row for its 20-month history.` : undefined}
      />
      <PageState {...reports} skeleton={<TableSkeleton rows={10} />}>
        <Section flush>
          {/* Search and filters sit inside the table's card, so they read as one unit. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-subtle" aria-hidden="true" />
              <Input
                type="search"
                placeholder="Search id, name or owner"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search reports"
                className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground">
                  <X className="size-4" aria-hidden="true" />
                </button>
              )}
            </div>
            <FilterSelect value={status} onChange={setStatus} label="Filter by refresh status">
              <option value="">Any refresh status</option>
              <option value="SUCCESS">Success</option>
              <option value="FAILED">Failed</option>
              <option value="TIMED_OUT">Timed out</option>
              <option value="UNKNOWN">Unknown</option>
            </FilterSelect>
            <FilterSelect value={band} onChange={setBand} label="Filter by load time">
              <option value="">Any load time</option>
              <option value="OK">≤ 15 s</option>
              <option value="WARNING">15–30 s</option>
              <option value="CRITICAL">&gt; 30 s</option>
            </FilterSelect>
            <FilterSelect value={ownership} onChange={setOwnership} label="Filter by ownership">
              <option value="">Any ownership</option>
              <option value="owned">Owned</option>
              <option value="orphaned">Orphaned</option>
            </FilterSelect>
            <div className="ml-auto flex items-center gap-2">
              {filtered && <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button>}
              <TagBadge aria-live="polite">{rows.length} of {data?.count ?? 0}</TagBadge>
            </div>
          </div>
          <DataTable
            label="Reports"
            columns={COLUMNS}
            data={rows}
            getRowId={(r) => r.report_id}
            initialSort={[{ id: 'report_id', desc: false }]}
            onRowClick={(r) => navigate(`/reports/${r.report_id}`)}
            emptyText="No reports match these filters"
          />
        </Section>
      </PageState>
    </>
  );
}
