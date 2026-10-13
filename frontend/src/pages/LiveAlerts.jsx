/**
 * Live Alerts: the real-time feed pushed over the WebSocket, the alerts open
 * right now, and replay controls (start/pause/reset are admin only).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Pause, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, useApi } from '../api';
import { useAuth } from '../auth';
import { useAlertStream } from '../alertStream';
import {
  EmptyState, ErrorState, Hint, PageHead, RelativeTime, RowsSkeleton, Section,
} from '../components/Common';
import DataTable from '../components/DataTable';
import { ALERT_TYPE_LABEL as TYPE_LABEL, BandBadge, RefreshBadge, SeverityBadge, TagBadge } from '../components/Badges';
import { fmtInt, fmtPct, fmtPeriod } from '../format';

const FILTERS = ['ALL', 'CRITICAL', 'WARNING', 'INFO'];
const SPEEDS = [100, 250, 500, 1000];
const SEVERITY_ORDER = { CRITICAL: 0, WARNING: 1, INFO: 2 };

function ReportLink({ id }) {
  return (
    <Link to={`/reports/${id}`} className="font-mono text-link underline-offset-4 hover:underline" onClick={(e) => e.stopPropagation()}>
      {id}
    </Link>
  );
}

function ReplayControls() {
  const { can } = useAuth();
  const { replay, setReplay } = useAlertStream();
  const [error, setError] = useState(null);
  const [speed, setSpeed] = useState(replay?.interval_ms || 500);
  const allowed = can('replay:control');

  useEffect(() => {
    if (replay?.interval_ms) setSpeed(replay.interval_ms);
  }, [replay?.interval_ms]);

  const send = async (action, body) => {
    setError(null);
    try {
      setReplay(await api(`/replay/${action}`, { method: 'POST', body }));
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Section title="Telemetry replay" description="Plays the 2,000 CSV snapshots in order as if they arrived live.">
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!allowed || replay?.state === 'running'} onClick={() => send('start', { interval_ms: Number(speed) })}>
            <Play aria-hidden="true" /> Start
          </Button>
          <Button variant="outline" disabled={!allowed || replay?.state !== 'running'} onClick={() => send('pause')}>
            <Pause aria-hidden="true" /> Pause
          </Button>
          <Button variant="outline" disabled={!allowed} onClick={() => send('reset')}>
            <RotateCcw aria-hidden="true" /> Reset
          </Button>
          <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            Speed
            <select
              className="select-native"
              value={speed}
              disabled={!allowed}
              onChange={(e) => { setSpeed(e.target.value); if (replay?.state === 'running') send('start', { interval_ms: Number(e.target.value) }); }}
            >
              {SPEEDS.map((s) => <option key={s} value={s}>1 row / {s} ms</option>)}
            </select>
          </label>
        </div>
        {!allowed && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Lock className="size-4 text-subtle" aria-hidden="true" />
            Only admins can control the replay (permission <code>replay:control</code>).
          </p>
        )}
        {replay && (
          <div className="grid gap-2">
            <div className="h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={replay.progress_pct} aria-valuemin={0} aria-valuemax={100} aria-label="Replay progress">
              <div className="h-full bg-muted-foreground transition-[width] motion-reduce:transition-none" style={{ width: `${replay.progress_pct}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {replay.state} · row {fmtInt(replay.position)} of {fmtInt(replay.total)} ({fmtPct(replay.progress_pct)}) · period {fmtPeriod(replay.current_period)} · loop {replay.cycle}
            </p>
          </div>
        )}
        <ErrorState error={error} />
      </div>
    </Section>
  );
}

const ACTIVE_COLUMNS = [
  {
    id: 'severity',
    header: 'Severity',
    accessorFn: (a) => SEVERITY_ORDER[a.severity],
    cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
  },
  { id: 'report', header: 'Report', accessorFn: (a) => a.report_id, cell: ({ row }) => <ReportLink id={row.original.report_id} /> },
  {
    id: 'problem',
    header: 'Problem',
    accessorFn: (a) => TYPE_LABEL[a.type],
    meta: { cellClassName: 'whitespace-normal' },
    cell: ({ row }) => {
      const a = row.original;
      return (
        <span className="inline-flex flex-wrap items-center gap-2">
          {TYPE_LABEL[a.type]}: {typeof a.value === 'number' ? `now ${a.value} s` : a.value}
          {!a.notified && <TagBadge>held by cooldown</TagBadge>}
        </span>
      );
    },
  },
  {
    id: 'since',
    header: 'Since',
    accessorFn: (a) => a.opened_period,
    cell: ({ row }) => <span className="text-muted-foreground">{fmtPeriod(row.original.opened_period)}</span>,
  },
];

export default function LiveAlerts() {
  const { feed, telemetry, status, resetCount } = useAlertStream();
  const [filter, setFilter] = useState('ALL');
  const active = useApi('/alerts/active', { refreshMs: 3000 });
  const stats = useApi('/alerts/stats', { refreshMs: 5000 });
  const { reload } = active;

  // When the replay resets or loops, the open alerts change at once.
  useEffect(() => { reload(); }, [resetCount, reload]);

  const shown = filter === 'ALL' ? feed : feed.filter((a) => a.severity === filter);
  const live = stats.data?.live;

  return (
    <>
      <PageHead
        title="Live Alerts"
        subtitle="Pushed over WebSocket the moment the alert engine raises them. Alerts fire on state changes (healthy → breach, warning → critical, failing → recovered), not on every bad row."
      />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Section
          flush
          title="Alert feed"
          description={status === 'open' ? 'Newest first · live' : 'Reconnecting to the alert stream…'}
          action={(
            <Tabs value={filter} onValueChange={setFilter}>
              <TabsList aria-label="Filter by severity">
                {FILTERS.map((f) => (
                  <TabsTrigger key={f} value={f} className="px-2">{f === 'ALL' ? 'All' : f[0] + f.slice(1).toLowerCase()}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
        >
          {/* Still connecting: skeleton. Connected but nothing yet: empty state. */}
          {shown.length === 0 && (status === 'open'
            ? <EmptyState>No alerts yet. They appear here as telemetry streams in.</EmptyState>
            : <RowsSkeleton rows={5} />)}
          {shown.length > 0 && (
            <ul className="max-h-[720px] divide-y divide-border overflow-y-auto" aria-live="polite">
              {shown.map((a) => (
                <li key={a.id} className={`grid gap-2 px-6 py-4 ${a._new ? 'animate-in fade-in duration-500 motion-reduce:animate-none' : ''}`}>
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <SeverityBadge severity={a.severity} />
                    {TYPE_LABEL[a.type] || a.type} · <ReportLink id={a.report_id} />
                    {a.escalation && <TagBadge>escalated</TagBadge>}
                    {a.delayed && <TagBadge>after cooldown</TagBadge>}
                    <RelativeTime iso={a.ts} className="ml-auto" />
                  </div>
                  <div className="flex items-start justify-between gap-4">
                    <p className="text-sm text-muted-foreground">{a.report_name}: {a.message}</p>
                    <span className="shrink-0 text-xs whitespace-nowrap text-subtle">
                      <Hint tip="The month of the CSV snapshot that triggered this alert">data</Hint>: {fmtPeriod(a.period)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="grid gap-6">
          <ReplayControls />
          <Section title="Latest telemetry reading">
            {telemetry ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono font-medium">{telemetry.report_id}</span>
                <span className="text-muted-foreground">{fmtPeriod(telemetry.period)}</span>
                <BandBadge band={telemetry.latency_band} seconds={telemetry.avg_load_time_sec} />
                <RefreshBadge status={telemetry.last_refresh_status} />
                <span className="text-muted-foreground">{fmtInt(telemetry.monthly_active_views)} views</span>
              </div>
            ) : <p className="text-sm text-muted-foreground">Waiting for the replay…</p>}
          </Section>
          <Section
            flush
            title={`Open right now (${active.data?.count ?? '…'})`}
            description="Every report currently breaching or failing, including alerts whose notification is in cooldown. Severity is the worst level reached while the alert has been open."
          >
            {active.error && !active.data ? (
              <div className="p-6"><ErrorState error={active.error} onRetry={reload} /></div>
            ) : active.loading && !active.data ? (
              <RowsSkeleton rows={4} />
            ) : (
              <DataTable
                label="Alerts open right now"
                columns={ACTIVE_COLUMNS}
                data={active.data?.alerts || []}
                getRowId={(a) => `${a.report_id}-${a.type}`}
                initialSort={[{ id: 'severity', desc: false }]}
                pageSize={100}
                maxHeight="352px"
                emptyText="No open alerts right now"
              />
            )}
          </Section>
          {live && (
            <Section title="Since the replay started">
              <p className="text-sm text-muted-foreground">
                {fmtInt(live.snapshots_processed)} readings · {fmtInt(live.naive_alert_count)} would-be per-row alerts ·{' '}
                <strong className="font-semibold text-foreground">{fmtInt(live.actionable_notifications)} actionable notifications</strong> ·{' '}
                {fmtInt(live.suppressed_total)} held back · {fmtInt(live.delayed_notifications)} sent after cooldown
              </p>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}
