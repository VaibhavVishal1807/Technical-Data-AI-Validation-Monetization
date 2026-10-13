/**
 * Tests for loadData.js
 *  1. Cleaning rules on small hand-made inputs (fast, precise).
 *  2. The real CSV: every number in the documented dataset profile is
 *     re-checked here, so a changed file or a regression fails loudly.
 */
const path = require('path');
const {
  cleanRow,
  buildDataset,
  loadDataset,
  shiftPeriod,
  latencyBand,
  FLAGS,
  REPORT_FLAGS,
} = require('../src/loadData');

const CSV_PATH = path.join(__dirname, '..', '..', 'data', 'Case_Study_3_Pure_Insights_Monitoring.csv');
const HEADER = 'report_id,report_name,owner_email,last_refresh_status,monthly_active_views,snowflake_credits_consumed,avg_load_time_sec,aws_hosting_cost_usd,query_count_last_30d,concurrent_user_peak';

/** A valid raw CSV record; override any field per test. */
function rawRow(overrides = {}) {
  return {
    report_id: 'RPT_1',
    report_name: 'Test Report',
    owner_email: 'owner@company.com',
    last_refresh_status: 'SUCCESS',
    monthly_active_views: '100',
    snowflake_credits_consumed: '10.5',
    avg_load_time_sec: '5.0',
    aws_hosting_cost_usd: '50',
    query_count_last_30d: '1000',
    concurrent_user_peak: '10',
    ...overrides,
  };
}

describe('cleanRow: cleaning rules', () => {
  test('a clean row has no flags and typed numbers', () => {
    const s = cleanRow(rawRow(), 1);
    expect(s.anomaly_flags).toEqual([]);
    expect(s.monthly_active_views).toBe(100);
    expect(s.snowflake_credits_consumed).toBe(10.5);
    expect(s.billable_credits).toBe(10.5);
    expect(s.owner_email).toBe('owner@company.com');
    expect(s.owner_status).toBe('VALID');
    expect(s.aws_cost_per_view).toBeCloseTo(0.5);
  });

  test('"nan" owner becomes null and is flagged MISSING_OWNER', () => {
    const s = cleanRow(rawRow({ owner_email: 'nan' }), 1);
    expect(s.owner_email).toBeNull();
    expect(s.owner_status).toBe('MISSING');
    expect(s.owner_email_raw).toBe('nan');
    expect(s.anomaly_flags).toContain(FLAGS.MISSING_OWNER);
  });

  test('empty owner is also treated as missing', () => {
    const s = cleanRow(rawRow({ owner_email: '  ' }), 1);
    expect(s.owner_status).toBe('MISSING');
  });

  test('"ORPHANED_REPORT" owner becomes null and is flagged as the sentinel', () => {
    const s = cleanRow(rawRow({ owner_email: 'ORPHANED_REPORT' }), 1);
    expect(s.owner_email).toBeNull();
    expect(s.owner_status).toBe('ORPHANED');
    expect(s.anomaly_flags).toContain(FLAGS.ORPHANED_OWNER_SENTINEL);
  });

  test('owner emails are trimmed and lower-cased so the same person matches', () => {
    const s = cleanRow(rawRow({ owner_email: '  User_3@Company.COM ' }), 1);
    expect(s.owner_email).toBe('user_3@company.com');
  });

  test('a non-email owner string is flagged INVALID_OWNER_EMAIL', () => {
    const s = cleanRow(rawRow({ owner_email: 'not an email' }), 1);
    expect(s.owner_email).toBeNull();
    expect(s.owner_status).toBe('INVALID');
    expect(s.anomaly_flags).toContain(FLAGS.INVALID_OWNER_EMAIL);
  });

  test('negative credits: raw value kept, flagged, excluded from billable credits', () => {
    const s = cleanRow(rawRow({ snowflake_credits_consumed: '-13.6' }), 1);
    expect(s.snowflake_credits_consumed).toBe(-13.6);
    expect(s.billable_credits).toBeNull();
    expect(s.anomaly_flags).toContain(FLAGS.NEGATIVE_CREDITS);
  });

  test('zero credits are valid (not negative)', () => {
    const s = cleanRow(rawRow({ snowflake_credits_consumed: '0' }), 1);
    expect(s.billable_credits).toBe(0);
    expect(s.anomaly_flags).not.toContain(FLAGS.NEGATIVE_CREDITS);
  });

  test.each([
    ['15.0', 'OK'],
    ['15.1', 'WARNING'],
    ['30.0', 'WARNING'],
    ['30.1', 'CRITICAL'],
    ['55.0', 'CRITICAL'],
  ])('load time %s s is band %s (strictly greater than the threshold)', (value, band) => {
    const s = cleanRow(rawRow({ avg_load_time_sec: value }), 1);
    expect(s.latency_band).toBe(band);
    if (band === 'WARNING') expect(s.anomaly_flags).toContain(FLAGS.LATENCY_BREACH_WARNING);
    if (band === 'CRITICAL') expect(s.anomaly_flags).toContain(FLAGS.LATENCY_BREACH_CRITICAL);
  });

  test('zero views: flagged, and cost per view is null instead of Infinity', () => {
    const s = cleanRow(rawRow({ monthly_active_views: '0', concurrent_user_peak: '0' }), 1);
    expect(s.anomaly_flags).toContain(FLAGS.ZERO_VIEWS);
    expect(s.aws_cost_per_view).toBeNull();
  });

  test('more peak concurrent users than monthly views is flagged', () => {
    const s = cleanRow(rawRow({ monthly_active_views: '5', concurrent_user_peak: '20' }), 1);
    expect(s.anomaly_flags).toContain(FLAGS.CONCURRENT_USERS_EXCEED_VIEWS);
  });

  test.each([
    ['FAILED', FLAGS.REFRESH_FAILED],
    ['TIMED_OUT', FLAGS.REFRESH_TIMED_OUT],
    ['UNKNOWN', FLAGS.REFRESH_STATUS_UNKNOWN],
    ['EXPLODED', FLAGS.UNRECOGNIZED_REFRESH_STATUS],
  ])('refresh status %s gets flag %s', (status, flag) => {
    expect(cleanRow(rawRow({ last_refresh_status: status }), 1).anomaly_flags).toContain(flag);
  });

  test('refresh status is normalised to upper case', () => {
    const s = cleanRow(rawRow({ last_refresh_status: ' failed ' }), 1);
    expect(s.last_refresh_status).toBe('FAILED');
  });

  test('garbage numbers become null with a readable issue, never NaN', () => {
    const s = cleanRow(rawRow({ monthly_active_views: 'abc', aws_hosting_cost_usd: '-5' }), 1);
    expect(s.monthly_active_views).toBeNull();
    expect(s.aws_hosting_cost_usd).toBeNull();
    expect(s.aws_cost_per_view).toBeNull();
    expect(s.anomaly_flags).toContain(FLAGS.INVALID_VALUE);
    expect(s.anomaly_flags.filter((f) => f === FLAGS.INVALID_VALUE)).toHaveLength(1);
    expect(s.validation_issues.join(' ')).toMatch(/monthly_active_views: not a number/);
    expect(s.validation_issues.join(' ')).toMatch(/aws_hosting_cost_usd: -5 is below the minimum 0/);
  });
});

describe('helpers', () => {
  test('shiftPeriod moves back across a year boundary', () => {
    expect(shiftPeriod('2026-09', 0)).toBe('2026-09');
    expect(shiftPeriod('2026-09', 9)).toBe('2025-12');
    expect(shiftPeriod('2026-09', 19)).toBe('2025-02');
    expect(() => shiftPeriod('Sept 2026', 1)).toThrow(/Invalid period/);
  });

  test('latencyBand handles null', () => {
    expect(latencyBand(null, 15, 30)).toBeNull();
  });
});

describe('buildDataset on a small inline CSV', () => {
  const csv = [
    HEADER,
    'RPT_1,Report One,a@company.com,SUCCESS,100,10,5,50,100,10',
    'RPT_2,Report Two,nan,FAILED,0,-2,40,60,100,3',
    'RPT_1,Report One,b@company.com,SUCCESS,100,10,5,50,100,10',
    'RPT_2,Report Two,c@company.com,SUCCESS,abc,10,5,50,100,10',
    'RPT_1,Report One,ORPHANED_REPORT,UNKNOWN,100,10,20,50,100,10',
    'RPT_2,Report Two,c@company.com,SUCCESS,abc,10,5,50,100,10',
  ].join('\n');

  const dataset = buildDataset(csv, { latestPeriod: '2026-09' });

  test('never drops rows, even broken ones', () => {
    expect(dataset.snapshots).toHaveLength(6);
  });

  test('snapshot order follows file order per report', () => {
    const rpt1 = dataset.snapshots.filter((s) => s.report_id === 'RPT_1');
    expect(rpt1.map((s) => s.snapshot_seq)).toEqual([1, 2, 3]);
    expect(rpt1.map((s) => s.period)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(rpt1[2].snapshot_ts).toBe('2026-09-01T00:00:00.000Z');
  });

  test('a report is orphaned when its LATEST snapshot has no owner; canonical owner = last valid one', () => {
    const rpt1 = dataset.reports.find((r) => r.report_id === 'RPT_1');
    expect(rpt1.is_orphaned).toBe(true);
    expect(rpt1.canonical_owner_email).toBe('b@company.com');
    expect(rpt1.canonical_owner_period).toBe('2026-08');
    expect(rpt1.periods_since_valid_owner).toBe(1);
    expect(rpt1.distinct_owner_count).toBe(2);
    expect(rpt1.owner_change_count).toBe(1);
    expect(rpt1.report_flags).toEqual(expect.arrayContaining([REPORT_FLAGS.ORPHANED, REPORT_FLAGS.OWNERSHIP_UNSTABLE]));
  });

  test('a report that starts ownerless but has an owner now is not orphaned', () => {
    const rpt2 = dataset.reports.find((r) => r.report_id === 'RPT_2');
    expect(rpt2.is_orphaned).toBe(false);
    expect(rpt2.canonical_owner_email).toBe('c@company.com');
    expect(rpt2.periods_since_valid_owner).toBe(0);
    expect(rpt2.ownerless_snapshot_count).toBe(1);
  });

  test('exact duplicate rows are flagged, not removed', () => {
    const dupes = dataset.snapshots.filter((s) => s.anomaly_flags.includes(FLAGS.DUPLICATE_ROW));
    expect(dupes).toHaveLength(1);
    expect(dupes[0].snapshot_id).toBe(6);
  });

  test('missing required columns stop the load with a clear message', () => {
    expect(() => buildDataset('report_id,report_name\nRPT_1,x')).toThrow(/missing required columns: owner_email/);
  });

  test('a renamed report is flagged as a name conflict', () => {
    const ds = buildDataset([
      HEADER,
      'RPT_9,Old Name,a@company.com,SUCCESS,100,10,5,50,100,10',
      'RPT_9,New Name,a@company.com,SUCCESS,100,10,5,50,100,10',
    ].join('\n'));
    expect(ds.reports[0].report_name).toBe('New Name');
    expect(ds.reports[0].report_flags).toContain(REPORT_FLAGS.REPORT_NAME_CONFLICT);
  });
});

describe('real dataset: verify the documented dataset profile', () => {
  const dataset = loadDataset(CSV_PATH);
  const { snapshots, reports, meta } = dataset;
  const withFlag = (flag) => snapshots.filter((s) => s.anomaly_flags.includes(flag)).length;
  const values = (col) => snapshots.map((s) => s[col]);

  test('2,000 rows loaded, none dropped, expected schema', () => {
    expect(snapshots).toHaveLength(2000);
    expect(meta.schema.missing).toEqual([]);
    expect(meta.schema.extra).toEqual([]);
  });

  test('100 reports RPT_200..RPT_299 with exactly 20 snapshots each', () => {
    expect(reports).toHaveLength(100);
    expect(reports[0].report_id).toBe('RPT_200');
    expect(reports[99].report_id).toBe('RPT_299');
    expect(reports.every((r) => r.snapshot_count === 20)).toBe(true);
  });

  test('file order is round-robin: row i is report 200 + (i mod 100), snapshot floor(i/100)+1', () => {
    snapshots.forEach((s, i) => {
      expect(s.report_id).toBe(`RPT_${200 + (i % 100)}`);
      expect(s.snapshot_seq).toBe(Math.floor(i / 100) + 1);
    });
    expect(meta.earliest_period).toBe('2025-02');
    expect(meta.latest_period).toBe('2026-09');
  });

  test('owners: 14 real users, 128 NaN + 117 ORPHANED_REPORT = 245 ownerless rows', () => {
    const users = new Set(snapshots.map((s) => s.owner_email).filter(Boolean));
    expect(users.size).toBe(14);
    expect(withFlag(FLAGS.MISSING_OWNER)).toBe(128);
    expect(withFlag(FLAGS.ORPHANED_OWNER_SENTINEL)).toBe(117);
    expect(withFlag(FLAGS.INVALID_OWNER_EMAIL)).toBe(0);
    expect(snapshots.filter((s) => s.owner_email === null)).toHaveLength(245);
  });

  test('refresh status: SUCCESS 1336, FAILED 382, TIMED_OUT 182, UNKNOWN 100', () => {
    const count = (st) => snapshots.filter((s) => s.last_refresh_status === st).length;
    expect(count('SUCCESS')).toBe(1336);
    expect(count('FAILED')).toBe(382);
    expect(count('TIMED_OUT')).toBe(182);
    expect(count('UNKNOWN')).toBe(100);
    expect(withFlag(FLAGS.UNRECOGNIZED_REFRESH_STATUS)).toBe(0);
  });

  test('views: 0..1499 with 4 zero-view rows', () => {
    expect(Math.min(...values('monthly_active_views'))).toBe(0);
    expect(Math.max(...values('monthly_active_views'))).toBe(1499);
    expect(withFlag(FLAGS.ZERO_VIEWS)).toBe(4);
  });

  test('credits: 24 negative values, min -13.6, max just under 1200', () => {
    expect(withFlag(FLAGS.NEGATIVE_CREDITS)).toBe(24);
    expect(Math.min(...values('snowflake_credits_consumed'))).toBe(-13.6);
    // The profile says "to 1200"; the real maximum is 1199.97.
    expect(Math.max(...values('snowflake_credits_consumed'))).toBe(1199.97);
    expect(snapshots.filter((s) => s.billable_credits === null)).toHaveLength(24);
  });

  test('load time: 0.6..55.0 s, 74.5% of rows above 15 s', () => {
    expect(Math.min(...values('avg_load_time_sec'))).toBe(0.6);
    expect(Math.max(...values('avg_load_time_sec'))).toBe(55);
    const breaches = withFlag(FLAGS.LATENCY_BREACH_WARNING) + withFlag(FLAGS.LATENCY_BREACH_CRITICAL);
    expect(breaches).toBe(1490);
    expect(breaches / 2000).toBeCloseTo(0.745, 3);
    expect(withFlag(FLAGS.LATENCY_BREACH_CRITICAL)).toBe(910);
  });

  test('AWS cost $15..$450, queries 20..~25,000, concurrent peak 1..149', () => {
    expect(Math.min(...values('aws_hosting_cost_usd'))).toBeGreaterThanOrEqual(15);
    expect(Math.max(...values('aws_hosting_cost_usd'))).toBeLessThanOrEqual(450);
    expect(Math.min(...values('query_count_last_30d'))).toBe(20);
    expect(Math.max(...values('query_count_last_30d'))).toBeLessThanOrEqual(25000);
    expect(Math.min(...values('concurrent_user_peak'))).toBe(1);
    expect(Math.max(...values('concurrent_user_peak'))).toBe(149);
  });

  test('no duplicates, no unparseable values, no name conflicts', () => {
    expect(withFlag(FLAGS.DUPLICATE_ROW)).toBe(0);
    expect(withFlag(FLAGS.INVALID_VALUE)).toBe(0);
    expect(reports.filter((r) => r.report_flags.includes(REPORT_FLAGS.REPORT_NAME_CONFLICT))).toHaveLength(0);
  });

  test('ownership: 7..13 distinct owners per report, 14 reports orphaned now', () => {
    const distinct = reports.map((r) => r.distinct_owner_count);
    expect(Math.min(...distinct)).toBe(7);
    expect(Math.max(...distinct)).toBe(13);
    expect(reports.filter((r) => r.is_orphaned)).toHaveLength(14);
    // Every orphaned report had a valid owner at some point.
    expect(reports.every((r) => r.canonical_owner_email !== null)).toBe(true);
  });

  test('discovered: 93 rows where peak concurrent users exceed monthly views', () => {
    expect(withFlag(FLAGS.CONCURRENT_USERS_EXCEED_VIEWS)).toBe(93);
  });

  test('cost-vs-usage outliers use a Tukey fence and flag a minority of rows', () => {
    const outliers = withFlag(FLAGS.AWS_COST_USAGE_OUTLIER);
    expect(meta.cost_outlier_rule.upperFence).toBeGreaterThan(meta.cost_outlier_rule.q3);
    expect(outliers).toBeGreaterThan(0);
    expect(outliers).toBeLessThan(400);
  });
});
