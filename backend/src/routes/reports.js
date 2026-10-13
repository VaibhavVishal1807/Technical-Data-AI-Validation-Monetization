/**
 * routes/reports.js
 *   GET /api/reports            - every report with its latest snapshot (filterable)
 *   GET /api/reports/orphaned   - reports whose latest snapshot has no valid owner
 *   GET /api/reports/:id        - one report: summary, cost and full snapshot history
 */
const express = require('express');
const { ApiError } = require('../errors');
const { REFRESH_STATUSES } = require('../loadData');
const { round } = require('../stats');

const BANDS = ['OK', 'WARNING', 'CRITICAL'];

/** Shape a report summary for the API (round long decimals). */
function toReportDto(report) {
  return {
    ...report,
    avg_load_time_sec: round(report.avg_load_time_sec, 1),
    latency_breach_rate: round(report.latency_breach_rate, 3),
  };
}

function snapshotDto(s) {
  return {
    ...s,
    aws_cost_per_view: round(s.aws_cost_per_view, 4),
  };
}

function reportsRouter(state) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const { status, band, orphaned, q } = req.query;
    let list = state.dataset.reports;

    if (status !== undefined) {
      const wanted = String(status).toUpperCase();
      if (!REFRESH_STATUSES.includes(wanted)) {
        throw new ApiError(400, 'BAD_QUERY', `status must be one of ${REFRESH_STATUSES.join(', ')}`);
      }
      list = list.filter((r) => r.latest_refresh_status === wanted);
    }
    if (band !== undefined) {
      const wanted = String(band).toUpperCase();
      if (!BANDS.includes(wanted)) throw new ApiError(400, 'BAD_QUERY', `band must be one of ${BANDS.join(', ')}`);
      list = list.filter((r) => r.latest_latency_band === wanted);
    }
    if (orphaned !== undefined) {
      if (!['true', 'false'].includes(orphaned)) throw new ApiError(400, 'BAD_QUERY', 'orphaned must be true or false');
      list = list.filter((r) => r.is_orphaned === (orphaned === 'true'));
    }
    if (q) {
      const needle = String(q).toLowerCase();
      list = list.filter((r) => r.report_id.toLowerCase().includes(needle)
        || r.report_name.toLowerCase().includes(needle)
        || (r.canonical_owner_email || '').includes(needle));
    }

    res.json({ as_of_period: state.dataset.meta.latest_period, count: list.length, reports: list.map(toReportDto) });
  });

  // Must be registered before "/:id", otherwise Express would treat
  // "orphaned" as a report id.
  router.get('/orphaned', (req, res) => {
    const orphaned = state.dataset.reports
      .filter((r) => r.is_orphaned)
      .map((r) => {
        const cost = state.costIndex.get(r.report_id);
        return {
          ...toReportDto(r),
          orphan_reason: r.latest_owner_status, // MISSING (NaN) or ORPHANED (sentinel)
          suggested_contact: r.canonical_owner_email,
          total_cost_usd: cost ? cost.total_cost_usd : null,
          waste_flag: cost ? cost.waste_flag : false,
        };
      })
      .sort((a, b) => (b.total_cost_usd ?? 0) - (a.total_cost_usd ?? 0));

    res.json({
      as_of_period: state.dataset.meta.latest_period,
      count: orphaned.length,
      total_cost_usd: round(orphaned.reduce((acc, r) => acc + (r.total_cost_usd || 0), 0), 2),
      reports: orphaned,
    });
  });

  router.get('/:id', (req, res) => {
    const id = String(req.params.id).toUpperCase();
    const report = state.reportIndex.get(id);
    if (!report) throw new ApiError(404, 'NOT_FOUND', `Report ${id} not found`);

    const history = state.dataset.snapshots
      .filter((s) => s.report_id === id)
      .sort((a, b) => a.snapshot_seq - b.snapshot_seq)
      .map(snapshotDto);

    res.json({
      report: toReportDto(report),
      cost: state.costIndex.get(id) || null,
      history,
    });
  });

  return router;
}

module.exports = reportsRouter;
