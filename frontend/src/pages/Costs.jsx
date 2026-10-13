/** Costs: Snowflake credit + AWS cost attributed to each report, cost per view, waste. */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../api';
import {
  BlockSkeleton, Hint, KpiCard, KpiGrid, KpiSkeleton, PageHead, PageState, Section, TableSkeleton,
} from '../components/Common';
import { StackedColumns } from '../components/Charts';
import DataTable from '../components/DataTable';
import { OrphanBadge, TagBadge, WasteBadge } from '../components/Badges';
import { fmtInt, fmtNumber, fmtPeriod, fmtUsd, fmtUsdCompact } from '../format';

const COLUMNS = [
  {
    id: 'cost_per_view_rank',
    header: '#',
    accessorFn: (r) => r.cost_per_view_rank,
    meta: { numeric: true, hint: 'Rank by total cost per view (1 = most expensive per view)' },
    cell: ({ row }) => row.original.cost_per_view_rank,
  },
  {
    id: 'report_id',
    header: 'Report',
    accessorFn: (r) => r.report_id,
    cell: ({ row }) => {
      const r = row.original;
      return (
        <span className="flex items-center gap-2">
          <span className="font-mono font-medium">{r.report_id}</span>
          {r.is_orphaned ? <OrphanBadge /> : <span className="text-muted-foreground">{r.owner_email}</span>}
        </span>
      );
    },
  },
  {
    id: 'billable_credits',
    header: 'Credits',
    accessorFn: (r) => r.billable_credits,
    meta: { numeric: true, hint: 'Billable Snowflake credits (negative rows excluded)' },
    cell: ({ row }) => {
      const r = row.original;
      return (
        <span className="inline-flex items-center gap-2">
          {r.excluded_rows > 0 && (
            <Hint underline={false} tip="Negative credit rows are invalid and left out of the total">
              <TagBadge>{r.excluded_rows} excluded</TagBadge>
            </Hint>
          )}
          {fmtNumber(r.billable_credits, 0)}
        </span>
      );
    },
  },
  { id: 'total_views', header: 'Views', accessorFn: (r) => r.total_views, meta: { numeric: true, hint: 'Active views over all 20 months' }, cell: ({ row }) => fmtInt(row.original.total_views) },
  { id: 'snowflake_cost_usd', header: 'Snowflake', accessorFn: (r) => r.snowflake_cost_usd, meta: { numeric: true, hint: 'Billable credits × assumed price per credit' }, cell: ({ row }) => fmtUsd(row.original.snowflake_cost_usd) },
  { id: 'aws_hosting_cost_usd', header: 'AWS', accessorFn: (r) => r.aws_hosting_cost_usd, meta: { numeric: true, hint: 'AWS hosting cost over all 20 months' }, cell: ({ row }) => fmtUsd(row.original.aws_hosting_cost_usd) },
  { id: 'total_cost_usd', header: 'Total', accessorFn: (r) => r.total_cost_usd, meta: { numeric: true }, cell: ({ row }) => fmtUsd(row.original.total_cost_usd) },
  {
    id: 'total_cost_per_view_usd',
    header: '$ / view',
    accessorFn: (r) => r.total_cost_per_view_usd ?? undefined,
    sortUndefined: 'last',
    meta: { numeric: true, hint: 'Total cost divided by active views. Waste = top quartile.' },
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-2">
        {row.original.waste_flag && <WasteBadge />}
        <strong className="font-semibold">{fmtUsd(row.original.total_cost_per_view_usd)}</strong>
      </span>
    ),
  },
  {
    id: 'zero_usage_cost_usd',
    header: 'No-view cost',
    accessorFn: (r) => r.zero_usage_cost_usd,
    meta: { numeric: true, hint: 'Spend in months when the report had zero views' },
    cell: ({ row }) => (row.original.zero_usage_cost_usd ? fmtUsd(row.original.zero_usage_cost_usd) : <span className="text-subtle">–</span>),
  },
];

function CostsSkeleton() {
  return (
    <>
      <KpiSkeleton count={7} />
      <BlockSkeleton height={260} />
      <TableSkeleton rows={10} />
    </>
  );
}

export default function Costs() {
  const costs = useApi('/costs/allocation');
  const { data } = costs;
  const navigate = useNavigate();
  const [wasteOnly, setWasteOnly] = useState(false);
  const s = data?.summary;
  const rows = (data?.reports || []).filter((r) => !wasteOnly || r.waste_flag);

  return (
    <>
      <PageHead
        title="Cloud cost allocation"
        subtitle="Snowflake credits and AWS hosting cost attributed to each report, divided by its active views. Same logic as sql/03_cost_allocation.sql."
      />
      <PageState {...costs} skeleton={<CostsSkeleton />}>
        {s && (
          <>
            <KpiGrid>
              <KpiCard label="Total cost" value={fmtUsdCompact(s.total_cost_usd)} caption={`${fmtPeriod(s.first_period)} to ${fmtPeriod(s.last_period)}`} />
              <KpiCard
                label="Snowflake"
                value={fmtUsdCompact(s.total_snowflake_cost_usd)}
                caption={`${fmtNumber(s.total_billable_credits, 0)} credits × $${s.credit_price_usd}`}
                hint="Credits converted to dollars at an assumed, configurable price per credit"
              />
              <KpiCard label="AWS hosting" value={fmtUsdCompact(s.total_aws_hosting_cost_usd)} caption="Sum of monthly hosting cost" />
              <KpiCard label="Cost per active view" value={fmtUsd(s.overall_cost_per_view_usd)} caption={`${fmtInt(s.total_views)} views in total`} />
              <KpiCard
                label="Waste flagged"
                value={`${s.waste_report_count} reports`}
                caption={`${fmtUsdCompact(s.waste_cost_usd)} · cost per view ≥ ${fmtUsd(s.waste_threshold_cost_per_view_usd)}`}
                hint="Reports whose total cost per view is in the top quartile"
              />
              <KpiCard
                label="Excluded from totals"
                value={`${s.excluded_rows} rows`}
                caption={`${fmtNumber(s.excluded_negative_credits, 2)} negative credits (invalid)`}
              />
              <KpiCard label="Zero-usage cost" value={fmtUsdCompact(s.zero_usage_cost_usd)} caption={`${s.zero_usage_periods} report-months with 0 views`} />
            </KpiGrid>

            <Section title="Monthly cost" description="Snowflake (credits × assumed price) and AWS hosting, all 100 reports. Hover a column for values.">
              <StackedColumns
                data={data.by_period.map((p) => ({ x: p.period, values: { snowflake: p.snowflake_cost_usd, aws: p.aws_hosting_cost_usd } }))}
                series={[
                  { key: 'snowflake', label: 'Snowflake', color: 'var(--chart-1)' },
                  { key: 'aws', label: 'AWS hosting', color: 'var(--chart-2)' },
                ]}
                formatY={fmtUsdCompact}
                formatValue={(v) => fmtUsd(v)}
                formatX={fmtPeriod}
              />
            </Section>

            <Section
              flush
              title="Cost per report"
              description={`Sorted by cost per view. Waste = top quartile of total cost per view (≥ ${fmtUsd(s.waste_threshold_cost_per_view_usd)}).`}
              action={(
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" className="size-4 accent-foreground" checked={wasteOnly} onChange={(e) => setWasteOnly(e.target.checked)} />
                  Waste only
                </label>
              )}
            >
              <DataTable
                label="Cost per report"
                columns={COLUMNS}
                data={rows}
                getRowId={(r) => r.report_id}
                initialSort={[{ id: 'cost_per_view_rank', desc: false }]}
                onRowClick={(r) => navigate(`/reports/${r.report_id}`)}
                emptyText={wasteOnly ? 'No reports are flagged as waste' : 'No cost data'}
              />
            </Section>

            <Section title="How the numbers are calculated">
              <ul className="grid list-disc gap-2 pl-4 text-sm text-muted-foreground">
                {Object.entries(data.method).map(([k, v]) => (
                  <li key={k}><code className="text-foreground">{k}</code> = {v}</li>
                ))}
              </ul>
            </Section>
          </>
        )}
      </PageState>
    </>
  );
}
