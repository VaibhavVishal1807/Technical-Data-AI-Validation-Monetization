/**
 * Cross-checks the Snowflake SQL suite (sql/*.sql, run on DuckDB) against
 * the JavaScript engine. Two independent implementations of the same rules
 * must agree on every report, every month and every data-quality count.
 *
 * Skipped automatically if the optional DuckDB package is not installed.
 */
const path = require('path');
const { isDuckDbAvailable, runSqlSuite, splitStatements, stripSnowflakeOnly } = require('../scripts/sqlSuite');
const { loadDataset } = require('../src/loadData');
const { computeCostAllocation } = require('../src/costs');
const { buildDataQualityReport } = require('../src/dataQuality');
const { AlertEngine } = require('../src/alerts/engine');

const CSV_PATH = path.join(__dirname, '..', '..', 'data', 'Case_Study_3_Pure_Insights_Monitoring.csv');
const num = (v) => (v === null || v === undefined ? null : Number(v));

describe('SQL script helpers', () => {
  test('Snowflake-only blocks are removed and statements split on line-ending semicolons', () => {
    const sql = [
      'CREATE SCHEMA A;',
      '-- @snowflake-only begin',
      'COPY INTO x FROM @stage;',
      '-- @snowflake-only end',
      "SELECT 'a;b' AS v -- trailing comment",
      'FROM t;',
    ].join('\n');
    const statements = splitStatements(stripSnowflakeOnly(sql));
    expect(statements).toEqual(['CREATE SCHEMA A', "SELECT 'a;b' AS v \nFROM t"]);
  });
});

const describeIfDuckDb = isDuckDbAvailable() ? describe : describe.skip;
if (!isDuckDbAvailable()) {
  // eslint-disable-next-line no-console
  console.warn('DuckDB not installed: skipping SQL cross-check tests (optional dependency).');
}

describeIfDuckDb('SQL suite (DuckDB) agrees with the JavaScript engine', () => {
  let suite;
  const dataset = loadDataset(CSV_PATH);
  const js = computeCostAllocation(dataset.snapshots, dataset.reports, { creditPriceUsd: 3 });
  const jsById = new Map(js.reports.map((r) => [r.report_id, r]));

  beforeAll(async () => {
    suite = await runSqlSuite(CSV_PATH);
  }, 60000);

  afterAll(() => suite && suite.close());

  test('load reconciliation: 2000 raw rows -> 2000 clean rows, all with a period', async () => {
    const [row] = await suite.query(`
      SELECT (SELECT COUNT(*) FROM RAW.REPORT_MONITORING) AS raw_rows,
             (SELECT COUNT(*) FROM ANALYTICS.REPORT_SNAPSHOTS) AS clean_rows,
             (SELECT COUNT(*) FROM ANALYTICS.REPORT_SNAPSHOTS WHERE PERIOD_START IS NULL) AS no_period`);
    expect(num(row.raw_rows)).toBe(2000);
    expect(num(row.clean_rows)).toBe(2000);
    expect(num(row.no_period)).toBe(0);
  });

  test('every snapshot gets the same period and flags as in JavaScript', async () => {
    const rows = await suite.query('SELECT SNAPSHOT_ID, PERIOD_LABEL, OWNER_STATUS, LATENCY_BAND, ANOMALY_FLAGS FROM ANALYTICS.REPORT_SNAPSHOTS ORDER BY SNAPSHOT_ID');
    // Flags that JavaScript computes from whole-dataset statistics have their own SQL views.
    const datasetLevel = new Set(['AWS_COST_USAGE_OUTLIER', 'DUPLICATE_ROW', 'INVALID_VALUE']);
    rows.forEach((row, i) => {
      const s = dataset.snapshots[i];
      expect(num(row.SNAPSHOT_ID)).toBe(s.snapshot_id);
      expect(row.PERIOD_LABEL).toBe(s.period);
      expect(row.OWNER_STATUS).toBe(s.owner_status);
      expect(row.LATENCY_BAND).toBe(s.latency_band);
      const sqlFlags = row.ANOMALY_FLAGS ? row.ANOMALY_FLAGS.split(',').sort() : [];
      const jsFlags = s.anomaly_flags.filter((f) => !datasetLevel.has(f)).sort();
      expect(sqlFlags).toEqual(jsFlags);
    });
  });

  test('cost allocation matches for all 100 reports', async () => {
    const rows = await suite.query('SELECT * FROM ANALYTICS.V_REPORT_COST_ALLOCATION');
    expect(rows).toHaveLength(100);
    for (const row of rows) {
      const j = jsById.get(row.REPORT_ID);
      expect(num(row.BILLABLE_CREDITS)).toBeCloseTo(j.billable_credits, 2);
      expect(num(row.EXCLUDED_NEGATIVE_CREDITS)).toBeCloseTo(j.excluded_negative_credits, 2);
      expect(num(row.EXCLUDED_ROWS)).toBe(j.excluded_rows);
      expect(num(row.TOTAL_VIEWS)).toBe(j.total_views);
      expect(num(row.SNOWFLAKE_COST_USD)).toBeCloseTo(j.snowflake_cost_usd, 2);
      expect(num(row.AWS_COST_USD)).toBeCloseTo(j.aws_hosting_cost_usd, 2);
      expect(num(row.TOTAL_COST_USD)).toBeCloseTo(j.total_cost_usd, 2);
      expect(num(row.TOTAL_COST_PER_VIEW_USD)).toBeCloseTo(j.total_cost_per_view_usd, 4);
      expect(num(row.CREDITS_PER_VIEW)).toBeCloseTo(j.credits_per_view, 4);
      expect(num(row.ZERO_USAGE_PERIODS)).toBe(j.zero_usage_periods);
      expect(num(row.ZERO_USAGE_COST_USD)).toBeCloseTo(j.zero_usage_cost_usd, 2);
    }
  });

  test('zero-view months give NULL cost per view, never an error or Infinity', async () => {
    const rows = await suite.query('SELECT TOTAL_COST_PER_VIEW_USD, TOTAL_COST_USD FROM ANALYTICS.V_REPORT_PERIOD_COST WHERE IS_ZERO_USAGE');
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.TOTAL_COST_PER_VIEW_USD).toBeNull();
      expect(num(row.TOTAL_COST_USD)).toBeGreaterThan(0);
    }
  });

  test('monthly platform totals match', async () => {
    const rows = await suite.query("SELECT strftime(PERIOD_START, '%Y-%m') AS period, * FROM ANALYTICS.V_PLATFORM_COST_BY_PERIOD ORDER BY PERIOD_START");
    expect(rows).toHaveLength(20);
    rows.forEach((row, i) => {
      const p = js.by_period[i];
      expect(row.period).toBe(p.period);
      expect(num(row.TOTAL_COST_USD)).toBeCloseTo(p.total_cost_usd, 2);
      expect(num(row.TOTAL_VIEWS)).toBe(p.total_views);
      expect(num(row.EXCLUDED_ROWS)).toBe(p.excluded_rows);
    });
  });

  test('waste flag: same threshold and the same 25 reports', async () => {
    const rows = await suite.query('SELECT REPORT_ID, WASTE_FLAG, WASTE_THRESHOLD_USD_PER_VIEW, COST_PER_VIEW_RANK FROM ANALYTICS.V_COST_WASTE');
    const sqlWaste = rows.filter((r) => r.WASTE_FLAG).map((r) => r.REPORT_ID).sort();
    const jsWaste = js.reports.filter((r) => r.waste_flag).map((r) => r.report_id).sort();
    expect(sqlWaste).toEqual(jsWaste);
    expect(sqlWaste).toHaveLength(25);
    expect(num(rows[0].WASTE_THRESHOLD_USD_PER_VIEW)).toBeCloseTo(js.summary.waste_threshold_cost_per_view_usd, 4);
    for (const row of rows) expect(num(row.COST_PER_VIEW_RANK)).toBe(jsById.get(row.REPORT_ID).cost_per_view_rank);
  });

  test('orphaned reports and suggested contacts match', async () => {
    const rows = await suite.query('SELECT * FROM ANALYTICS.V_ORPHANED_REPORTS ORDER BY REPORT_ID');
    const jsOrphans = dataset.reports.filter((r) => r.is_orphaned);
    expect(rows.map((r) => r.REPORT_ID)).toEqual(jsOrphans.map((r) => r.report_id));
    rows.forEach((row, i) => {
      expect(row.SUGGESTED_CONTACT).toBe(jsOrphans[i].canonical_owner_email);
      expect(row.ORPHAN_REASON).toBe(jsOrphans[i].latest_owner_status);
      expect(num(row.PERIODS_SINCE_VALID_OWNER)).toBe(jsOrphans[i].periods_since_valid_owner);
    });
  });

  test('data-quality counts match the JavaScript report', async () => {
    const dq = buildDataQualityReport(dataset, { creditPriceUsd: 3 });
    const jsCount = Object.fromEntries(dq.checks.map((c) => [c.id, c.count]));
    const rows = await suite.query('SELECT CHECK_ID, AFFECTED FROM ANALYTICS.V_DATA_QUALITY_SUMMARY');
    const sqlCount = Object.fromEntries(rows.map((r) => [r.CHECK_ID, num(r.AFFECTED)]));
    for (const id of Object.keys(sqlCount)) {
      expect({ id, count: sqlCount[id] }).toEqual({ id, count: jsCount[id] });
    }
  });

  test('latency state changes in SQL equal the alert engine (without cooldown)', async () => {
    const engine = new AlertEngine({ warningSec: 15, criticalSec: 30, cooldownSnapshots: 0, historyLimit: 100000 });
    dataset.snapshots.forEach((s) => engine.process(s));
    const opened = engine.history.filter((e) => e.type === 'LATENCY_BREACH' && e.previous_state === 'OK').length;
    const recovered = engine.history.filter((e) => e.type === 'RECOVERED' && e.metric === 'avg_load_time_sec').length;

    const rows = await suite.query('SELECT ALERT_TYPE, COUNT(*) AS n FROM ANALYTICS.V_LATENCY_STATE_CHANGES GROUP BY ALERT_TYPE');
    const sql = Object.fromEntries(rows.map((r) => [r.ALERT_TYPE, num(r.n)]));
    expect(sql.LATENCY_BREACH).toBe(opened);
    expect(sql.RECOVERED).toBe(recovered);
  });
});
