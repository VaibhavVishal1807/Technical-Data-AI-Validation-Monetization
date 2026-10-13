/**
 * health.js
 * Builds the platform health summary behind GET /api/health/summary and the
 * Overview page. "Current" figures use each report's latest snapshot.
 */
const { round } = require('./stats');

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/**
 * @param {object} state      app state (dataset, costs, config, optional alert engine/replay)
 * @param {object} options    { includeCost } - only admin/analyst may see money
 */
function buildHealthSummary(state, { includeCost = false } = {}) {
  const { dataset, config } = state;
  const reports = dataset.reports;
  const total = reports.length;
  const pct = (n) => (total ? round((n / total) * 100, 1) : null);

  const statusCounts = { SUCCESS: 0, FAILED: 0, TIMED_OUT: 0, UNKNOWN: 0, ...countBy(reports, (r) => r.latest_refresh_status) };
  const failing = statusCounts.FAILED + statusCounts.TIMED_OUT;

  const bands = { OK: 0, WARNING: 0, CRITICAL: 0, ...countBy(reports, (r) => r.latest_latency_band) };
  const breaching = bands.WARNING + bands.CRITICAL;
  const loadTimes = reports.map((r) => r.latest_load_time_sec).filter((v) => v !== null);

  const orphaned = reports.filter((r) => r.is_orphaned).length;

  // History across all snapshots, for context.
  const snaps = dataset.snapshots;
  const historyBreaches = snaps.filter((s) => s.latency_band === 'WARNING' || s.latency_band === 'CRITICAL').length;
  const historyFailures = snaps.filter((s) => s.last_refresh_status === 'FAILED' || s.last_refresh_status === 'TIMED_OUT').length;

  const summary = {
    generated_at: new Date().toISOString(),
    as_of_period: dataset.meta.latest_period,
    reports_total: total,
    refresh: {
      counts: statusCounts,
      failing,
      failing_pct: pct(failing),
      unknown: statusCounts.UNKNOWN,
      unknown_pct: pct(statusCounts.UNKNOWN),
    },
    latency: {
      warning_threshold_sec: config.latencyWarningSec,
      critical_threshold_sec: config.latencyCriticalSec,
      bands,
      breaching,
      breaching_pct: pct(breaching),
      avg_load_time_sec: loadTimes.length ? round(loadTimes.reduce((a, b) => a + b, 0) / loadTimes.length, 1) : null,
      max_load_time_sec: loadTimes.length ? Math.max(...loadTimes) : null,
    },
    ownership: {
      orphaned_reports: orphaned,
      orphaned_pct: pct(orphaned),
    },
    history: {
      snapshots: snaps.length,
      latency_breach_pct: snaps.length ? round((historyBreaches / snaps.length) * 100, 1) : null,
      refresh_failure_pct: snaps.length ? round((historyFailures / snaps.length) * 100, 1) : null,
    },
    alerts: state.alertEngine ? state.alertEngine.getActiveSummary() : { active_total: 0, by_severity: {} },
    replay: state.replay ? state.replay.getStatus() : null,
  };

  // Field-level access control: viewers see health, but not money.
  if (includeCost && state.costs) {
    const c = state.costs.summary;
    summary.cost = {
      total_cost_usd: c.total_cost_usd,
      total_snowflake_cost_usd: c.total_snowflake_cost_usd,
      total_aws_hosting_cost_usd: c.total_aws_hosting_cost_usd,
      overall_cost_per_view_usd: c.overall_cost_per_view_usd,
      waste_report_count: c.waste_report_count,
      period_range: `${c.first_period} to ${c.last_period}`,
    };
  }

  return summary;
}

module.exports = { buildHealthSummary };
