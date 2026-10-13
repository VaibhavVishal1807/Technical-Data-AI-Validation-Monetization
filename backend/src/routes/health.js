/**
 * routes/health.js
 *   GET /api/health/summary  - platform health KPIs for the Overview page
 * (The public liveness probe GET /api/health/live is defined in app.js.)
 */
const express = require('express');
const { buildHealthSummary } = require('../health');
const { hasPermission } = require('../permissions');

function healthRouter(state) {
  const router = express.Router();

  router.get('/summary', (req, res) => {
    // Field-level RBAC: cost figures are only included for roles that may read costs.
    const includeCost = Boolean(req.user && hasPermission(req.user.role, 'costs:read'));
    res.json(buildHealthSummary(state, { includeCost }));
  });

  return router;
}

module.exports = healthRouter;
