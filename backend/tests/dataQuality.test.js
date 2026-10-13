/**
 * Tests for dataQuality.js: the report must account for every anomaly,
 * never claim rows were dropped, and document each check fully.
 */
const path = require('path');
const { loadDataset } = require('../src/loadData');
const { buildDataQualityReport } = require('../src/dataQuality');

const CSV_PATH = path.join(__dirname, '..', '..', 'data', 'Case_Study_3_Pure_Insights_Monitoring.csv');

describe('data-quality report on the real dataset', () => {
  const dataset = loadDataset(CSV_PATH);
  const report = buildDataQualityReport(dataset, { creditPriceUsd: 3 });
  const check = (id) => report.checks.find((c) => c.id === id);

  test('summary: 2000 rows, none dropped, 24 excluded from cost totals', () => {
    expect(report.summary.rows_total).toBe(2000);
    expect(report.summary.rows_dropped).toBe(0);
    expect(report.summary.rows_excluded_from_cost_totals).toBe(24);
    expect(report.summary.reports_total).toBe(100);
  });

  test('every check is fully documented and has a unique id', () => {
    const ids = report.checks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of report.checks) {
      expect(c.title).toBeTruthy();
      expect(c.detection).toBeTruthy();
      expect(c.handling).toBeTruthy();
      expect(c.rationale).toBeTruthy();
      expect(['BRIEF', 'DISCOVERED', 'INTEGRITY']).toContain(c.origin);
      expect(['FOUND', 'PASS']).toContain(c.status);
    }
  });

  test('all four injected anomalies from the brief are detected', () => {
    expect(check('MISSING_OWNER').count).toBe(128);
    expect(check('ORPHANED_OWNER_SENTINEL').count).toBe(117);
    expect(check('ORPHANED_REPORTS').count).toBe(14);
    expect(check('NEGATIVE_CREDITS').count).toBe(24);
    expect(check('LATENCY_BREACH').count).toBe(1490);
    expect(check('LATENCY_BREACH').details.max_load_time_sec).toBe(55);
    expect(check('AWS_COST_USAGE_OUTLIER').status).toBe('FOUND');
  });

  test('discovered issues are reported', () => {
    expect(check('OWNERSHIP_UNSTABLE').count).toBe(100);
    expect(check('ZERO_VIEWS').count).toBe(4);
    expect(check('ZERO_VIEWS').details.zero_usage_cost_usd).toBeGreaterThan(0);
    expect(check('REFRESH_STATUS_UNKNOWN').count).toBe(100);
    expect(check('CONCURRENT_USERS_EXCEED_VIEWS').count).toBe(93);
    expect(check('NO_TIMESTAMP').status).toBe('FOUND');
  });

  test('months are independent: a breach does not predict the next one (synthetic-data signal)', () => {
    const c = check('NO_TEMPORAL_PERSISTENCE');
    expect(c.status).toBe('FOUND');
    expect(Math.abs(c.details.p_breach_after_breach - c.details.p_breach_after_ok)).toBeLessThan(0.05);
  });

  test('usage and cost are essentially uncorrelated (|r| <= 0.05)', () => {
    const c = check('COST_NOT_EXPLAINED_BY_USAGE');
    expect(c.details.max_abs_r).toBeLessThanOrEqual(0.05);
  });

  test('integrity checks pass on this file', () => {
    for (const id of ['DUPLICATE_ROW', 'INVALID_VALUE', 'REPORT_NAME_CONFLICT', 'UNEVEN_SNAPSHOT_COUNTS', 'INVALID_OWNER_EMAIL', 'UNRECOGNIZED_REFRESH_STATUS']) {
      expect(check(id).status).toBe('PASS');
    }
  });

  test('negative credits excluded total matches the flagged rows', () => {
    const negSum = dataset.snapshots
      .filter((s) => s.snowflake_credits_consumed < 0)
      .reduce((a, s) => a + s.snowflake_credits_consumed, 0);
    expect(check('NEGATIVE_CREDITS').details.excluded_credits).toBeCloseTo(negSum, 2);
  });
});
