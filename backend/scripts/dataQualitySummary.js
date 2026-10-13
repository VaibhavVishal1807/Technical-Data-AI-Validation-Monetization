/**
 * Prints the data-quality report as a Markdown table.
 * Usage (from the backend folder):  npm run dq
 * The numbers in docs/DATA_QUALITY.md were produced with this script.
 */
const config = require('../src/config');
const { loadDataset } = require('../src/loadData');
const { buildDataQualityReport } = require('../src/dataQuality');

const dataset = loadDataset(config.dataPath, {
  latestPeriod: config.latestPeriod,
  latencyWarningSec: config.latencyWarningSec,
  latencyCriticalSec: config.latencyCriticalSec,
});
const report = buildDataQualityReport(dataset, { creditPriceUsd: config.creditPriceUsd });

console.log(`Source: ${report.source_file}`);
console.log(`Rows: ${report.summary.rows_total} | dropped: ${report.summary.rows_dropped} | with any flag: ${report.summary.rows_with_any_flag} | excluded from cost totals: ${report.summary.rows_excluded_from_cost_totals}\n`);
console.log('| Check | Origin | Level | Count | % | Status |');
console.log('|---|---|---|---|---|---|');
for (const c of report.checks) {
  console.log(`| ${c.id} | ${c.origin} | ${c.level} | ${c.count} / ${c.total} | ${c.pct ?? '-'} | ${c.status} |`);
}
console.log('\nDetails:');
for (const c of report.checks) {
  if (Object.keys(c.details).length) console.log(`- ${c.id}: ${JSON.stringify(c.details)}`);
}
console.log('\nColumn profile:');
for (const p of report.column_profile) console.log(`- ${p.column}: min ${p.min}, max ${p.max}, mean ${p.mean}, missing ${p.missing}`);
console.log('\nFlag counts:', JSON.stringify(report.flag_counts));
