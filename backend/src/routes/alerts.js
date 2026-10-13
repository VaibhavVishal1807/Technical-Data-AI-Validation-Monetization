/**
 * routes/alerts.js
 *   GET /api/alerts          - alert history, newest first (filterable)
 *   GET /api/alerts/active   - alerts open right now
 *   GET /api/alerts/stats    - live counters + noise-reduction simulation over the full dataset
 */
const express = require('express');
const { ApiError } = require('../errors');
const { SEVERITY, ALERT_TYPES } = require('../alerts/engine');

function alertsRouter(state) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const { severity, type, report_id: reportId } = req.query;
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new ApiError(400, 'BAD_QUERY', 'limit must be a whole number from 1 to 1000');
    }
    if (severity && !Object.values(SEVERITY).includes(severity)) {
      throw new ApiError(400, 'BAD_QUERY', `severity must be one of ${Object.values(SEVERITY).join(', ')}`);
    }
    if (type && !Object.values(ALERT_TYPES).includes(type)) {
      throw new ApiError(400, 'BAD_QUERY', `type must be one of ${Object.values(ALERT_TYPES).join(', ')}`);
    }
    const alerts = state.alertEngine.getHistory({
      limit,
      severity,
      type,
      reportId: reportId ? String(reportId).toUpperCase() : undefined,
      includeSuppressed: req.query.include_suppressed === 'true',
    });
    res.json({ count: alerts.length, alerts });
  });

  router.get('/active', (req, res) => {
    const alerts = state.alertEngine.getActive();
    res.json({ summary: state.alertEngine.getActiveSummary(), count: alerts.length, alerts });
  });

  router.get('/stats', (req, res) => {
    res.json({
      live: state.alertEngine.getStats(),
      full_dataset_simulation: state.alertSimulation,
    });
  });

  return router;
}

module.exports = alertsRouter;
