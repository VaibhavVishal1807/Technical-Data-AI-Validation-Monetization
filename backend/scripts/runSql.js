/**
 * Runs the SQL suite on DuckDB and prints the key results.
 * Usage (from the backend folder):  npm run sql
 */
const config = require('../src/config');
const { isDuckDbAvailable, runSqlSuite } = require('./sqlSuite');

function table(rows) {
  if (!rows.length) return console.log('(no rows)\n');
  console.table(rows);
}

(async () => {
  if (!isDuckDbAvailable()) {
    console.error('DuckDB is not installed (optional dependency). Run "npm install" in backend/ and try again.');
    process.exit(1);
  }
  const suite = await runSqlSuite(config.dataPath);
  suite.log.forEach((line) => console.log(`[sql] ${line}`));

  console.log('\nPlatform totals (03_cost_allocation.sql)');
  table(await suite.query(`
    SELECT ROUND(SUM(BILLABLE_CREDITS), 2) AS billable_credits, ROUND(SUM(EXCLUDED_NEGATIVE_CREDITS), 2) AS excluded_credits,
           ROUND(SUM(TOTAL_COST_USD), 2) AS total_cost_usd, SUM(TOTAL_VIEWS) AS total_views,
           ROUND(SUM(TOTAL_COST_USD) / SUM(TOTAL_VIEWS), 4) AS cost_per_view_usd
    FROM ANALYTICS.V_REPORT_COST_ALLOCATION`));

  console.log('Top 5 reports by cost per active view (04_waste_and_anomalies.sql)');
  table(await suite.query(`
    SELECT REPORT_ID, ROUND(TOTAL_COST_USD, 2) AS total_cost_usd, TOTAL_VIEWS AS views,
           ROUND(TOTAL_COST_PER_VIEW_USD, 4) AS cost_per_view_usd, WASTE_FLAG AS waste
    FROM ANALYTICS.V_COST_WASTE ORDER BY COST_PER_VIEW_RANK LIMIT 5`));

  console.log('Data-quality summary');
  table(await suite.query('SELECT CHECK_ID, CHECK_LEVEL, AFFECTED, TOTAL FROM ANALYTICS.V_DATA_QUALITY_SUMMARY'));

  console.log('Orphaned reports');
  table(await suite.query(`
    SELECT REPORT_ID, ORPHAN_REASON, SUGGESTED_CONTACT, ROUND(TOTAL_COST_USD, 2) AS total_cost_usd
    FROM ANALYTICS.V_ORPHANED_REPORTS ORDER BY TOTAL_COST_USD DESC`));

  suite.close();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
