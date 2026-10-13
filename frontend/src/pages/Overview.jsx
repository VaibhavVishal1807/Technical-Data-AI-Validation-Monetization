/** Overview: platform health KPIs (all roles; cost tile only for admin/analyst). */
import { Link } from 'react-router-dom';
import { useApi } from '../api';
import { useAlertStream } from '../alertStream';
import {
  BlockSkeleton, EmptyState, Hint, KpiCard, KpiGrid, KpiSkeleton, LockedKpi, PageHead, PageState, RelativeTime, Section,
} from '../components/Common';
import { BarList } from '../components/Charts';
import { ALERT_TYPE_LABEL, REFRESH_LABELS, STATUS_COLORS, SeverityBadge } from '../components/Badges';
import { fmtInt, fmtPct, fmtPeriod, fmtSec, fmtUsd, fmtUsdCompact } from '../format';

function OverviewSkeleton() {
  return (
    <>
      <KpiSkeleton count={5} />
      <div className="grid gap-6 lg:grid-cols-2"><BlockSkeleton height={160} /><BlockSkeleton height={160} /></div>
    </>
  );
}

export default function Overview() {
  const health = useApi('/health/summary', { refreshMs: 5000 });
  const stats = useApi('/alerts/stats', { refreshMs: 15000 });
  const { feed, activeSummary } = useAlertStream();
  const h = health.data;
  const sim = stats.data?.full_dataset_simulation;
  const active = activeSummary || h?.alerts;

  return (
    <>
      <PageHead
        title="Overview"
        subtitle={h ? `Current state of ${h.reports_total} reports, as of the latest snapshot (${fmtPeriod(h.as_of_period)}). Alert counts update live.` : undefined}
      />
      <PageState {...health} skeleton={<OverviewSkeleton />}>
        {h && (
          <>
            <KpiGrid>
              <KpiCard
                label="Refresh failures"
                value={`${fmtInt(h.refresh.failing)} / ${fmtInt(h.reports_total)}`}
                caption={`${h.refresh.counts.FAILED} failed · ${h.refresh.counts.TIMED_OUT} timed out · ${h.refresh.unknown} unknown`}
                hint="Reports whose latest scheduled refresh failed or timed out. Unknown refreshes are counted separately as a monitoring gap."
              />
              <KpiCard
                label="Slow reports"
                value={fmtPct(h.latency.breaching_pct)}
                caption={`Over 15 s · ${h.latency.bands.CRITICAL} over 30 s · avg ${fmtSec(h.latency.avg_load_time_sec)}`}
                hint="Share of reports whose latest average load time is over the 15 s alert threshold."
              />
              <KpiCard
                label="Active alerts"
                value={fmtInt(active?.active_total ?? 0)}
                caption={`${active?.by_severity?.CRITICAL ?? 0} critical · ${active?.by_severity?.WARNING ?? 0} warning (live)`}
                hint="Alerts open right now (breaching or failing), updated live over the WebSocket."
              />
              <KpiCard
                label="Orphaned reports"
                value={fmtInt(h.ownership.orphaned_reports)}
                caption="Latest snapshot has no valid owner"
              />
              {h.cost ? (
                <KpiCard
                  label="Total cost"
                  value={fmtUsdCompact(h.cost.total_cost_usd)}
                  caption={`${fmtUsd(h.cost.overall_cost_per_view_usd)} per view · ${h.cost.period_range}`}
                  hint="Snowflake credits (at the assumed price per credit) plus AWS hosting, all reports and months."
                />
              ) : (
                <LockedKpi label="Total cost" reason="Cost data is limited to admin and analyst roles." />
              )}
            </KpiGrid>

            <div className="grid gap-6 lg:grid-cols-2">
              <Section title="Latest refresh status" description="Each report's most recent scheduled refresh">
                <BarList
                  items={['SUCCESS', 'FAILED', 'TIMED_OUT', 'UNKNOWN'].map((s) => ({
                    label: REFRESH_LABELS[s],
                    value: h.refresh.counts[s] || 0,
                    color: STATUS_COLORS[s],
                    note: s === 'UNKNOWN' ? 'monitoring gap' : undefined,
                  }))}
                />
              </Section>
              <Section
                title="Load time"
                description={`Latest snapshot. Alert thresholds: ${h.latency.warning_threshold_sec} s and ${h.latency.critical_threshold_sec} s`}
              >
                <BarList
                  items={[
                    { label: '≤ 15 s (OK)', value: h.latency.bands.OK, color: STATUS_COLORS.OK },
                    { label: '15–30 s (warning)', value: h.latency.bands.WARNING, color: STATUS_COLORS.WARNING },
                    { label: '> 30 s (critical)', value: h.latency.bands.CRITICAL, color: STATUS_COLORS.CRITICAL },
                  ]}
                />
                <p className="mt-4 text-xs text-muted-foreground">
                  Across all 20 months, {fmtPct(h.history.latency_breach_pct)} of snapshots breached 15 s and {fmtPct(h.history.refresh_failure_pct)} had a failed refresh.
                </p>
              </Section>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <Section title="Alert noise reduction" description="WARNING/CRITICAL notifications over the full 2,000-row file">
                {sim ? (
                  <>
                    <BarList
                      items={[
                        { label: 'One alert per bad row', value: sim.naive_per_row_alerts, color: 'var(--text-muted)' },
                        { label: 'State changes only', value: sim.state_change_only_actionable, color: 'var(--chart-1)' },
                        { label: `+ ${sim.cooldown_snapshots}-snapshot cooldown`, value: sim.actionable_notifications, color: 'var(--chart-1)' },
                      ]}
                    />
                    <p className="mt-4 text-xs text-muted-foreground">
                      {fmtPct(sim.actionable_reduction_pct)} fewer pages.{' '}
                      <Hint tip="An alert that fires again within the cooldown window is held back instead of paging again.">Held-back alerts</Hint>{' '}
                      stay active and are sent later if the problem persists ({fmtInt(sim.delayed_notifications)} delayed sends).
                    </p>
                  </>
                ) : (
                  <PageState {...stats} skeleton={<BlockSkeleton height={120} />} />
                )}
              </Section>
              <Section
                title="Latest alerts"
                action={<Link to="/alerts" className="text-sm text-link underline-offset-4 hover:underline">Open live feed</Link>}
              >
                {feed.length === 0 ? (
                  <EmptyState>Waiting for alerts…</EmptyState>
                ) : (
                  <ul className="divide-y divide-border">
                    {feed.slice(0, 6).map((a) => (
                      <li key={a.id} className="grid grid-cols-[80px_1fr_auto] items-center gap-4 py-2">
                        <SeverityBadge severity={a.severity} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            <span className="font-mono">{a.report_id}</span> · {ALERT_TYPE_LABEL[a.type] || a.type}
                          </div>
                          <div className="truncate text-xs text-muted-foreground" title={a.message}>{a.message}</div>
                        </div>
                        <RelativeTime iso={a.ts} />
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </>
        )}
      </PageState>
    </>
  );
}
