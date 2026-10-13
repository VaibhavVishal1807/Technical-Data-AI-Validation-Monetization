/**
 * Tests for costs.js: cost per view with negative credits excluded, zero views
 * handled with NULLIF semantics, and the top-quartile waste flag.
 */
const path = require('path');
const { buildDataset, loadDataset } = require('../src/loadData');
const { computeCostAllocation, safeDivide } = require('../src/costs');

const HEADER = 'report_id,report_name,owner_email,last_refresh_status,monthly_active_views,snowflake_credits_consumed,avg_load_time_sec,aws_hosting_cost_usd,query_count_last_30d,concurrent_user_peak';
const CSV_PATH = path.join(__dirname, '..', '..', 'data', 'Case_Study_3_Pure_Insights_Monitoring.csv');

describe('safeDivide (NULLIF in JavaScript)', () => {
  test('returns null instead of Infinity when dividing by zero', () => {
    expect(safeDivide(10, 0)).toBeNull();
    expect(safeDivide(10, null)).toBeNull();
    expect(safeDivide(10, 4)).toBe(2.5);
  });
});

describe('computeCostAllocation on a hand-checked example ($3 per credit)', () => {
  // Expected values worked out by hand:
  //  A: credits 10+5=15 -> $45, AWS 50+20=$70, total $115, views 100      -> $1.15/view; one zero-view month costs 5*3+20=$35
  //  B: credits 20 (the -2 is excluded) -> $60, AWS $200, total $260, views 400 -> $0.65/view
  //  C: credits 100 -> $300, AWS $100, total $400, views 50              -> $8.00/view
  //  D: credits 10 -> $30, AWS $10, total $40, views 1000                -> $0.04/view
  //  E: never viewed: cost per view undefined -> null, all spend is waste
  //  P75 of [0.04, 0.65, 1.15, 8] = 1.15 + 0.25 * (8 - 1.15) = 2.8625 -> only C is above
  const csv = [
    HEADER,
    'A,Report A,a@x.com,SUCCESS,100,10,5,50,100,1',
    'B,Report B,b@x.com,SUCCESS,200,-2,5,100,100,1',
    'C,Report C,c@x.com,SUCCESS,50,100,5,100,100,1',
    'D,Report D,d@x.com,SUCCESS,1000,10,5,10,100,1',
    'E,Report E,e@x.com,SUCCESS,0,10,5,10,100,0',
    'A,Report A,a@x.com,SUCCESS,0,5,5,20,100,0',
    'B,Report B,b@x.com,SUCCESS,200,20,5,100,100,1',
  ].join('\n');
  const dataset = buildDataset(csv);
  const result = computeCostAllocation(dataset.snapshots, dataset.reports, { creditPriceUsd: 3 });
  const row = (id) => result.reports.find((r) => r.report_id === id);

  test('report A: credits, USD, cost per view and zero-usage cost', () => {
    const a = row('A');
    expect(a.billable_credits).toBe(15);
    expect(a.snowflake_cost_usd).toBe(45);
    expect(a.aws_hosting_cost_usd).toBe(70);
    expect(a.total_cost_usd).toBe(115);
    expect(a.total_views).toBe(100);
    expect(a.total_cost_per_view_usd).toBe(1.15);
    expect(a.credits_per_view).toBe(0.15);
    expect(a.zero_usage_periods).toBe(1);
    expect(a.zero_usage_cost_usd).toBe(35);
  });

  test('report B: negative credits are excluded, not netted off', () => {
    const b = row('B');
    expect(b.billable_credits).toBe(20);
    expect(b.excluded_negative_credits).toBe(-2);
    expect(b.excluded_rows).toBe(1);
    expect(b.total_cost_per_view_usd).toBe(0.65);
  });

  test('report E: zero total views gives null cost per view (not Infinity) and counts as waste', () => {
    const e = row('E');
    expect(e.total_cost_per_view_usd).toBeNull();
    expect(e.credits_per_view).toBeNull();
    expect(e.waste_flag).toBe(true);
  });

  test('waste flag = top quartile of cost per view', () => {
    expect(result.summary.waste_threshold_cost_per_view_usd).toBe(2.8625);
    expect(row('C').waste_flag).toBe(true);
    expect(row('A').waste_flag).toBe(false);
    expect(row('B').waste_flag).toBe(false);
    expect(row('D').waste_flag).toBe(false);
  });

  test('reports are ranked most expensive per view first, nulls last', () => {
    expect(result.reports.map((r) => r.report_id)).toEqual(['C', 'A', 'B', 'D', 'E']);
    expect(row('C').cost_per_view_rank).toBe(1);
  });

  test('platform summary adds up', () => {
    expect(result.summary.total_billable_credits).toBe(15 + 20 + 100 + 10 + 10);
    expect(result.summary.excluded_negative_credits).toBe(-2);
    expect(result.summary.total_cost_usd).toBe(115 + 260 + 400 + 40 + 40);
    expect(result.summary.zero_usage_periods).toBe(2);
  });
});

describe('computeCostAllocation on the real dataset', () => {
  const dataset = loadDataset(CSV_PATH);
  const result = computeCostAllocation(dataset.snapshots, dataset.reports, { creditPriceUsd: 3 });

  test('totals match an independent calculation over the raw rows', () => {
    const credits = dataset.snapshots.map((s) => s.snowflake_credits_consumed);
    const billable = credits.filter((c) => c >= 0).reduce((a, b) => a + b, 0);
    const negative = credits.filter((c) => c < 0).reduce((a, b) => a + b, 0);
    const aws = dataset.snapshots.reduce((a, s) => a + s.aws_hosting_cost_usd, 0);
    expect(result.summary.total_billable_credits).toBeCloseTo(billable, 2);
    expect(result.summary.excluded_negative_credits).toBeCloseTo(negative, 2);
    expect(result.summary.excluded_rows).toBe(24);
    expect(result.summary.total_aws_hosting_cost_usd).toBeCloseTo(aws, 2);
    expect(result.summary.total_cost_usd).toBeCloseTo(billable * 3 + aws, 1);
  });

  test('per-report totals add up to the platform total', () => {
    const sumReports = result.reports.reduce((a, r) => a + r.total_cost_usd, 0);
    expect(sumReports).toBeCloseTo(result.summary.total_cost_usd, 0);
  });

  test('100 reports, 20 monthly periods, a quarter flagged as waste', () => {
    expect(result.reports).toHaveLength(100);
    expect(result.by_period).toHaveLength(20);
    expect(result.summary.waste_report_count).toBe(25);
  });

  test('4 zero-view periods are reported as zero-usage cost, never Infinity or NaN', () => {
    expect(result.summary.zero_usage_periods).toBe(4);
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/Infinity|NaN/);
  });
});
