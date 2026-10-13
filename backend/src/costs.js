/**
 * costs.js
 * Cloud cost allocation: attributes Snowflake credits and AWS hosting cost to
 * each report and works out the unit cost per active view.
 *
 * Same logic as sql/03_cost_allocation.sql (a test checks they agree):
 *   billable_credits     = SUM(credits) WHERE credits >= 0      (negatives excluded)
 *   credits_per_view     = billable_credits / NULLIF(SUM(views), 0)
 *   snowflake_cost_usd   = billable_credits * CREDIT_PRICE_USD
 *   total_cost_usd       = snowflake_cost_usd + SUM(aws_hosting_cost_usd)
 *   waste_flag           = total_cost_per_view >= 75th percentile across reports
 */
const { round, percentileCont, sum } = require('./stats');

/** a / b, or null when b is 0 or missing (the JavaScript version of NULLIF). */
function safeDivide(a, b) {
  if (!b || a === null || a === undefined) return null;
  return a / b;
}

/** Cost figures for one group of snapshots (one report, or one month). */
function costTotals(snapshots, creditPriceUsd) {
  const billable = snapshots.filter((s) => s.billable_credits !== null);
  const negative = snapshots.filter((s) => s.snowflake_credits_consumed !== null && s.snowflake_credits_consumed < 0);
  const zeroUsage = snapshots.filter((s) => s.monthly_active_views === 0);

  const billableCredits = sum(billable.map((s) => s.billable_credits));
  const views = sum(snapshots.map((s) => s.monthly_active_views));
  const awsUsd = sum(snapshots.map((s) => s.aws_hosting_cost_usd));
  const snowflakeUsd = billableCredits * creditPriceUsd;
  const totalUsd = snowflakeUsd + awsUsd;

  return {
    billableCredits,
    excludedNegativeCredits: sum(negative.map((s) => s.snowflake_credits_consumed)),
    excludedRows: negative.length,
    views,
    awsUsd,
    snowflakeUsd,
    totalUsd,
    queries: sum(snapshots.map((s) => s.query_count_last_30d)),
    zeroUsagePeriods: zeroUsage.length,
    zeroUsageCostUsd: sum(zeroUsage.map((s) => (s.billable_credits || 0) * creditPriceUsd + (s.aws_hosting_cost_usd || 0))),
  };
}

/**
 * Allocate cost to every report.
 * @returns {{ summary, reports, by_period }}
 */
function computeCostAllocation(snapshots, reportSummaries, { creditPriceUsd = 3 } = {}) {
  const byReport = new Map();
  for (const s of snapshots) {
    if (!byReport.has(s.report_id)) byReport.set(s.report_id, []);
    byReport.get(s.report_id).push(s);
  }
  const summaryById = new Map(reportSummaries.map((r) => [r.report_id, r]));

  // 1) Raw (unrounded) numbers per report.
  const rows = [];
  for (const [reportId, history] of byReport) {
    const t = costTotals(history, creditPriceUsd);
    rows.push({
      reportId,
      t,
      totalCostPerView: safeDivide(t.totalUsd, t.views),
    });
  }

  // 2) Waste threshold: top quartile of total cost per view.
  const perView = rows.map((r) => r.totalCostPerView).filter((v) => v !== null);
  const wasteThreshold = percentileCont(perView, 0.75);

  // 3) Shape the API rows (rounded for display).
  const reports = rows.map(({ reportId, t, totalCostPerView }) => {
    const info = summaryById.get(reportId) || {};
    // Zero total views can only happen if every period had zero views: all spend is waste.
    const waste = totalCostPerView === null ? t.totalUsd > 0 : totalCostPerView >= wasteThreshold;
    return {
      report_id: reportId,
      report_name: info.report_name ?? null,
      owner_email: info.canonical_owner_email ?? null,
      is_orphaned: info.is_orphaned ?? false,
      periods: byReport.get(reportId).length,
      billable_credits: round(t.billableCredits, 2),
      excluded_negative_credits: round(t.excludedNegativeCredits, 2),
      excluded_rows: t.excludedRows,
      total_views: t.views,
      total_queries: t.queries,
      snowflake_cost_usd: round(t.snowflakeUsd, 2),
      aws_hosting_cost_usd: round(t.awsUsd, 2),
      total_cost_usd: round(t.totalUsd, 2),
      credits_per_view: round(safeDivide(t.billableCredits, t.views), 4),
      snowflake_cost_per_view_usd: round(safeDivide(t.snowflakeUsd, t.views), 4),
      aws_cost_per_view_usd: round(safeDivide(t.awsUsd, t.views), 4),
      total_cost_per_view_usd: round(totalCostPerView, 4),
      zero_usage_periods: t.zeroUsagePeriods,
      zero_usage_cost_usd: round(t.zeroUsageCostUsd, 2),
      waste_flag: waste,
    };
  });
  // Most expensive per view first; reports with no views (null) go last.
  reports.sort((a, b) => (b.total_cost_per_view_usd ?? -Infinity) - (a.total_cost_per_view_usd ?? -Infinity));
  reports.forEach((r, i) => { r.cost_per_view_rank = i + 1; });

  // 4) Month-by-month totals for the trend chart.
  const byPeriod = new Map();
  for (const s of snapshots) {
    if (!byPeriod.has(s.period)) byPeriod.set(s.period, []);
    byPeriod.get(s.period).push(s);
  }
  const periods = [...byPeriod.keys()].sort().map((period) => {
    const t = costTotals(byPeriod.get(period), creditPriceUsd);
    return {
      period,
      billable_credits: round(t.billableCredits, 2),
      snowflake_cost_usd: round(t.snowflakeUsd, 2),
      aws_hosting_cost_usd: round(t.awsUsd, 2),
      total_cost_usd: round(t.totalUsd, 2),
      total_views: t.views,
      total_cost_per_view_usd: round(safeDivide(t.totalUsd, t.views), 4),
      excluded_rows: t.excludedRows,
    };
  });

  // 5) Platform-wide summary.
  const all = costTotals(snapshots, creditPriceUsd);
  const wasteReports = reports.filter((r) => r.waste_flag);
  const summary = {
    credit_price_usd: creditPriceUsd,
    report_count: reports.length,
    period_count: periods.length,
    first_period: periods.length ? periods[0].period : null,
    last_period: periods.length ? periods[periods.length - 1].period : null,
    total_billable_credits: round(all.billableCredits, 2),
    excluded_negative_credits: round(all.excludedNegativeCredits, 2),
    excluded_rows: all.excludedRows,
    total_snowflake_cost_usd: round(all.snowflakeUsd, 2),
    total_aws_hosting_cost_usd: round(all.awsUsd, 2),
    total_cost_usd: round(all.totalUsd, 2),
    total_views: all.views,
    overall_cost_per_view_usd: round(safeDivide(all.totalUsd, all.views), 4),
    waste_threshold_cost_per_view_usd: round(wasteThreshold, 4),
    waste_report_count: wasteReports.length,
    waste_cost_usd: round(sum(wasteReports.map((r) => r.total_cost_usd)), 2),
    zero_usage_periods: all.zeroUsagePeriods,
    zero_usage_cost_usd: round(all.zeroUsageCostUsd, 2),
  };

  return { summary, reports, by_period: periods };
}

module.exports = { computeCostAllocation, safeDivide };
