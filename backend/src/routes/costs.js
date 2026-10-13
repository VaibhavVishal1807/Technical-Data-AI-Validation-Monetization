/**
 * routes/costs.js
 *   GET /api/costs/allocation  - credits and USD per report, cost per active view,
 *                                waste flag, plus platform totals and a monthly trend
 */
const express = require('express');

function costsRouter(state) {
  const router = express.Router();

  router.get('/allocation', (req, res) => {
    const { summary, reports, by_period: byPeriod } = state.costs;
    const wasteOnly = req.query.waste === 'true';
    const list = wasteOnly ? reports.filter((r) => r.waste_flag) : reports;
    res.json({
      method: {
        billable_credits: 'SUM(snowflake_credits_consumed) WHERE credits >= 0 (negative rows excluded)',
        cost_per_view: 'cost / NULLIF(SUM(monthly_active_views), 0)',
        snowflake_cost_usd: `billable_credits x $${summary.credit_price_usd} per credit (assumed)`,
        total_cost_usd: 'snowflake_cost_usd + SUM(aws_hosting_cost_usd)',
        waste_flag: 'total_cost_per_view_usd >= 75th percentile across reports',
        sql: 'sql/03_cost_allocation.sql',
      },
      summary,
      count: list.length,
      reports: list,
      by_period: byPeriod,
    });
  });

  return router;
}

module.exports = costsRouter;
