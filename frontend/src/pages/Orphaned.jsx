/** Orphaned reports: no valid owner in the latest snapshot, most expensive first. */
import { useNavigate } from 'react-router-dom';
import { useApi } from '../api';
import {
  Callout, Hint, KpiCard, KpiGrid, KpiSkeleton, PageHead, PageState, Section, TableSkeleton,
} from '../components/Common';
import DataTable from '../components/DataTable';
import { BandBadge, RefreshBadge, WasteBadge } from '../components/Badges';
import { fmtInt, fmtPeriod, fmtUsd, fmtUsdCompact } from '../format';

const REASON = {
  MISSING: { label: 'Owner missing', detail: 'owner_email was empty / "nan"' },
  ORPHANED: { label: 'Placeholder', detail: 'owner_email was "ORPHANED_REPORT"' },
};

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
    id: 'orphan_reason',
    header: 'Why orphaned',
    accessorFn: (r) => r.orphan_reason,
    cell: ({ row }) => {
      const reason = REASON[row.original.orphan_reason];
      return reason ? <Hint tip={reason.detail}>{reason.label}</Hint> : row.original.orphan_reason;
    },
  },
  {
    id: 'suggested_contact',
    header: 'Suggested contact',
    accessorFn: (r) => r.suggested_contact,
    meta: { hint: 'The last valid owner of the report' },
    cell: ({ row }) => row.original.suggested_contact,
  },
  {
    id: 'owner_last_seen',
    header: 'Last valid owner',
    accessorFn: (r) => r.periods_since_valid_owner,
    meta: { hint: 'Month of the most recent snapshot with a valid owner' },
    cell: ({ row }) => {
      const r = row.original;
      return (
        <span className="text-muted-foreground">
          {fmtPeriod(r.canonical_owner_period)} ({r.periods_since_valid_owner} month{r.periods_since_valid_owner === 1 ? '' : 's'} ago)
        </span>
      );
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
    id: 'total_cost_usd',
    header: 'Cost (20 months)',
    accessorFn: (r) => r.total_cost_usd,
    meta: { numeric: true, hint: 'Snowflake + AWS over all 20 months' },
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-2">
        {row.original.waste_flag && <WasteBadge />}
        {fmtUsd(row.original.total_cost_usd)}
      </span>
    ),
  },
];

export default function Orphaned() {
  const orphaned = useApi('/reports/orphaned');
  const { data } = orphaned;
  const navigate = useNavigate();
  const reports = data?.reports || [];
  const missing = reports.filter((r) => r.orphan_reason === 'MISSING').length;

  return (
    <>
      <PageHead
        title="Orphaned reports"
        subtitle="A report is orphaned when its latest snapshot has no valid owner, whether the field is empty ('nan') or the placeholder 'ORPHANED_REPORT'. The last valid owner is suggested as the person to contact."
      />
      <PageState {...orphaned} skeleton={<><KpiSkeleton count={3} /><TableSkeleton /></>}>
        {data && (
          <>
            <KpiGrid>
              <KpiCard label="Orphaned now" value={`${fmtInt(data.count)} of 100`} caption={`${missing} missing owner · ${data.count - missing} placeholder`} />
              <KpiCard label="Spend with no accountable owner" value={fmtUsdCompact(data.total_cost_usd)} caption="Snowflake + AWS over 20 months" />
              <KpiCard
                label="Also flagged as waste"
                value={fmtInt(reports.filter((r) => r.waste_flag).length)}
                caption="Top-quartile cost per view"
                hint="Total cost per view in the top quartile of all 100 reports"
              />
            </KpiGrid>
            <Section flush>
              <DataTable
                label="Orphaned reports"
                columns={COLUMNS}
                data={reports}
                getRowId={(r) => r.report_id}
                initialSort={[{ id: 'total_cost_usd', desc: true }]}
                maxHeight="none"
                onRowClick={(r) => navigate(`/reports/${r.report_id}`)}
                emptyText="No orphaned reports right now"
              />
            </Section>
            <Callout>
              <strong className="font-semibold text-foreground">Data note:</strong> every report has 7 to 13 different owners across its 20 snapshots, so the owner
              field behaves more like "last editor" than "accountable owner". That is why ownership is judged on the
              latest snapshot and the suggestion is only the most recent valid owner.
            </Callout>
          </>
        )}
      </PageState>
    </>
  );
}
