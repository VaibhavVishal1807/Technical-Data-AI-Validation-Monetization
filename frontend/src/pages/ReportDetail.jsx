/** One report: latest state, cost, and its 20-month history (chart + table). */
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useApi } from '../api';
import { BlockSkeleton, KpiCard, KpiGrid, KpiSkeleton, PageHead, PageState, Section, TableSkeleton } from '../components/Common';
import { LineChart } from '../components/Charts';
import DataTable from '../components/DataTable';
import {
  BandLabelBadge, OrphanBadge, REFRESH_LABELS, RefreshBadge, RefreshDot, TagBadge, WasteBadge,
} from '../components/Badges';
import { fmtInt, fmtNumber, fmtPct, fmtPeriod, fmtSec, fmtUsd, fmtUsdCompact } from '../format';

function FlagChips({ flags }) {
  if (!flags.length) return <span className="text-muted-foreground">none</span>;
  return (
    <span className="flex flex-wrap gap-2">
      {flags.map((f) => <TagBadge key={f}>{f.replaceAll('_', ' ').toLowerCase()}</TagBadge>)}
    </span>
  );
}

const HISTORY_COLUMNS = [
  { id: 'period', header: 'Month', accessorFn: (s) => s.period, cell: ({ row }) => fmtPeriod(row.original.period) },
  {
    id: 'owner',
    header: 'Owner (raw)',
    accessorFn: (s) => s.owner_email_raw,
    cell: ({ row }) => <span className={row.original.owner_email ? '' : 'text-muted-foreground'}>{row.original.owner_email_raw}</span>,
  },
  { id: 'refresh', header: 'Refresh', accessorFn: (s) => s.last_refresh_status, cell: ({ row }) => <RefreshBadge status={row.original.last_refresh_status} /> },
  { id: 'load', header: 'Load', accessorFn: (s) => s.avg_load_time_sec, meta: { numeric: true, hint: 'Average load time' }, cell: ({ row }) => fmtSec(row.original.avg_load_time_sec) },
  { id: 'views', header: 'Views', accessorFn: (s) => s.monthly_active_views, meta: { numeric: true, hint: 'Monthly active views' }, cell: ({ row }) => fmtInt(row.original.monthly_active_views) },
  {
    id: 'credits',
    header: 'Credits',
    accessorFn: (s) => s.snowflake_credits_consumed,
    meta: { numeric: true, hint: 'Snowflake credits consumed. Negative values are invalid and shown in red.' },
    cell: ({ row }) => {
      const v = row.original.snowflake_credits_consumed;
      return <span className={v < 0 ? 'text-critical' : undefined}>{fmtNumber(v, 2)}</span>;
    },
  },
  { id: 'aws', header: 'AWS', accessorFn: (s) => s.aws_hosting_cost_usd, meta: { numeric: true, hint: 'AWS hosting cost for the month' }, cell: ({ row }) => fmtUsd(row.original.aws_hosting_cost_usd) },
  { id: 'queries', header: 'Queries', accessorFn: (s) => s.query_count_last_30d, meta: { numeric: true, hint: 'Snowflake queries in the last 30 days' }, cell: ({ row }) => fmtInt(row.original.query_count_last_30d) },
  {
    id: 'flags',
    header: 'Flags',
    accessorFn: (s) => s.anomaly_flags.length,
    // Wraps instead of widening the table; rows with many flags grow taller.
    meta: { cellClassName: 'whitespace-normal', hint: 'Anomaly flags added during cleaning (sorts by count)' },
    cell: ({ row }) => <FlagChips flags={row.original.anomaly_flags} />,
  },
];

function DetailSkeleton() {
  return (
    <>
      <KpiSkeleton count={4} />
      <BlockSkeleton height={240} />
      <TableSkeleton rows={8} />
    </>
  );
}

export default function ReportDetail() {
  const { id } = useParams();
  const detail = useApi(`/reports/${encodeURIComponent(id)}`);
  const { data } = detail;
  const report = data?.report;
  const cost = data?.cost;
  const history = data?.history || [];

  return (
    <>
      <div>
        <Link to="/reports" className="inline-flex items-center gap-2 text-sm text-link underline-offset-4 hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" /> All reports
        </Link>
      </div>
      <PageState {...detail} skeleton={<DetailSkeleton />}>
        {report && (
          <>
            <PageHead title={`${report.report_name}`} subtitle={`${report.report_id} · ${report.snapshot_count} monthly snapshots, ${fmtPeriod(history[0]?.period)} to ${fmtPeriod(report.latest_period)}`}>
              {report.is_orphaned && <OrphanBadge />}
              {cost?.waste_flag && <WasteBadge />}
            </PageHead>
            <KpiGrid>
              <KpiCard
                label="Latest load time"
                value={(
                  <span className="flex items-center gap-2">
                    {fmtSec(report.latest_load_time_sec)}
                    <BandLabelBadge band={report.latest_latency_band} />
                  </span>
                )}
                caption={`Above 15 s in ${fmtPct(report.latency_breach_rate * 100)} of months · max ${fmtSec(report.max_load_time_sec)}`}
              />
              <KpiCard
                label="Latest refresh"
                value={(
                  <span className="flex items-center gap-2">
                    <RefreshDot status={report.latest_refresh_status} />
                    {REFRESH_LABELS[report.latest_refresh_status] || report.latest_refresh_status}
                  </span>
                )}
                caption={`${report.failed_refresh_count} failed · ${report.timed_out_refresh_count} timed out · ${report.unknown_refresh_count} unknown`}
              />
              <KpiCard
                label="Owner"
                value={<span className="block truncate text-base font-semibold">{report.is_orphaned ? 'No valid owner' : report.latest_owner_email}</span>}
                caption={report.is_orphaned
                  ? `Last valid owner ${report.canonical_owner_email} (${fmtPeriod(report.canonical_owner_period)})`
                  : `${report.distinct_owner_count} different owners over ${report.snapshot_count} months`}
              />
              {cost && (
                <KpiCard
                  label="Total cost (20 months)"
                  value={fmtUsdCompact(cost.total_cost_usd)}
                  caption={`${fmtUsd(cost.total_cost_per_view_usd)} per view · rank ${cost.cost_per_view_rank} of 100`}
                  hint="Snowflake (billable credits × assumed price) plus AWS hosting. Rank 1 = highest cost per view."
                />
              )}
            </KpiGrid>

            <Section title="Load time by month" description="Line = average load time. Reference lines show the alert thresholds. Hover or use arrow keys for details.">
              <LineChart
                data={history.map((s) => ({ x: s.period, y: s.avg_load_time_sec, snapshot: s }))}
                thresholds={[
                  { value: 15, label: '15 s warning', color: 'var(--status-warning)' },
                  { value: 30, label: '30 s critical', color: 'var(--status-critical)' },
                ]}
                yTicks={[0, 15, 30, 45, 60]}
                formatY={(v) => `${v} s`}
                formatX={fmtPeriod}
                seriesLabel="load time"
                tooltipRows={(p) => [
                  { label: 'refresh', value: p.snapshot.last_refresh_status },
                  { label: 'views', value: fmtInt(p.snapshot.monthly_active_views) },
                  { label: 'owner', value: p.snapshot.owner_email || p.snapshot.owner_email_raw },
                ]}
              />
            </Section>

            <Section flush title="Snapshot history" description="Every row from the CSV for this report, with the flags added during cleaning. Nothing is dropped.">
              <DataTable
                label="Snapshot history"
                columns={HISTORY_COLUMNS}
                data={history}
                getRowId={(s) => String(s.snapshot_id)}
                initialSort={[{ id: 'period', desc: true }]}
                maxHeight="none"
                emptyText="No snapshots for this report"
              />
            </Section>
          </>
        )}
      </PageState>
    </>
  );
}
