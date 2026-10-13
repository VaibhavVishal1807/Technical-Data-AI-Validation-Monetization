/**
 * HTTP-level tests for the REST API using supertest, which sends requests
 * straight to the Express app without opening a network port.
 * Requests are made as admin; access rules are tested in auth.test.js.
 */
const request = require('supertest');
const { createApp } = require('../src/app');
const { createState } = require('../src/state');
const config = require('../src/config');
const { loginAs } = require('./helpers');

const state = createState(config);
const app = createApp(state);
let token;

beforeAll(async () => {
  token = await loginAs(app, 'admin');
});

/** GET as the logged-in admin. */
const get = (url) => request(app).get(url).set('Authorization', `Bearer ${token}`);

describe('health', () => {
  test('GET /api/health/live is public and returns ok', async () => {
    const res = await request(app).get('/api/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET /api/health/summary returns current KPIs from the latest snapshots', async () => {
    const res = await get('/api/health/summary');
    expect(res.status).toBe(200);
    expect(res.body.reports_total).toBe(100);
    expect(res.body.as_of_period).toBe('2026-09');
    const counts = res.body.refresh.counts;
    expect(counts.SUCCESS + counts.FAILED + counts.TIMED_OUT + counts.UNKNOWN).toBe(100);
    expect(res.body.ownership.orphaned_reports).toBe(14);
    expect(res.body.history.latency_breach_pct).toBe(74.5);
  });
});

describe('reports', () => {
  test('GET /api/reports lists all 100 reports with their latest snapshot', async () => {
    const res = await get('/api/reports');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(100);
    expect(res.body.reports[0]).toHaveProperty('latest_refresh_status');
    expect(res.body.reports[0]).toHaveProperty('canonical_owner_email');
  });

  test('filters combine, and bad filter values are rejected with 400', async () => {
    const failed = await get('/api/reports?status=failed');
    expect(failed.status).toBe(200);
    expect(failed.body.reports.every((r) => r.latest_refresh_status === 'FAILED')).toBe(true);

    const orphaned = await get('/api/reports?orphaned=true');
    expect(orphaned.body.count).toBe(14);

    const bad = await get('/api/reports?status=EXPLODED');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_QUERY');
  });

  test('GET /api/reports/orphaned returns the 14 orphaned reports, most expensive first', async () => {
    const res = await get('/api/reports/orphaned');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(14);
    const costs = res.body.reports.map((r) => r.total_cost_usd);
    expect([...costs].sort((a, b) => b - a)).toEqual(costs);
    for (const r of res.body.reports) {
      expect(r.is_orphaned).toBe(true);
      expect(['MISSING', 'ORPHANED']).toContain(r.orphan_reason);
      expect(r.suggested_contact).toMatch(/@/);
    }
  });

  test('GET /api/reports/:id returns history (case-insensitive id)', async () => {
    const res = await get('/api/reports/rpt_200');
    expect(res.status).toBe(200);
    expect(res.body.report.report_id).toBe('RPT_200');
    expect(res.body.history).toHaveLength(20);
    expect(res.body.history[0].period).toBe('2025-02');
    expect(res.body.cost.report_id).toBe('RPT_200');
  });

  test('unknown report gives a JSON 404', async () => {
    const res = await get('/api/reports/RPT_999');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('costs and data quality', () => {
  test('GET /api/costs/allocation returns per-report allocation and method', async () => {
    const res = await get('/api/costs/allocation');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(100);
    expect(res.body.summary.credit_price_usd).toBe(3);
    expect(res.body.method.sql).toBe('sql/03_cost_allocation.sql');
    expect(res.body.by_period).toHaveLength(20);

    const waste = await get('/api/costs/allocation?waste=true');
    expect(waste.body.count).toBe(25);
  });

  test('GET /api/data-quality returns the documented checks', async () => {
    const res = await get('/api/data-quality');
    expect(res.status).toBe(200);
    expect(res.body.summary.rows_total).toBe(2000);
    expect(res.body.summary.rows_dropped).toBe(0);
    expect(res.body.checks.length).toBeGreaterThan(10);
  });
});

describe('alerts and replay', () => {
  beforeAll(() => {
    state.replay.reset();
    for (let i = 0; i < 300; i += 1) state.replay.step(); // three rounds of telemetry
  });

  test('GET /api/alerts returns notified alerts newest first', async () => {
    const res = await get('/api/alerts?limit=20');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeLessThanOrEqual(20);
    expect(res.body.alerts.every((a) => a.notified)).toBe(true);
    const ids = res.body.alerts.map((a) => a.id);
    expect([...ids].sort().reverse()).toEqual(ids);
  });

  test('filters work and bad values give 400', async () => {
    const crit = await get('/api/alerts?severity=CRITICAL');
    expect(crit.body.alerts.every((a) => a.severity === 'CRITICAL')).toBe(true);
    expect((await get('/api/alerts?severity=LOUD')).status).toBe(400);
    expect((await get('/api/alerts?limit=0')).status).toBe(400);
    const withSuppressed = await get('/api/alerts?include_suppressed=true&limit=1000');
    expect(withSuppressed.body.alerts.some((a) => !a.notified)).toBe(true);
  });

  test('GET /api/alerts/active and health summary agree', async () => {
    const active = await get('/api/alerts/active');
    const health = await get('/api/health/summary');
    expect(active.body.count).toBe(health.body.alerts.active_total);
    expect(health.body.replay.position).toBe(300);
  });

  test('GET /api/alerts/stats includes the full-dataset noise simulation', async () => {
    const res = await get('/api/alerts/stats');
    expect(res.body.full_dataset_simulation.naive_per_row_alerts).toBe(2154);
    expect(res.body.live.snapshots_processed).toBe(300);
  });

  test('replay control: start with a custom speed, pause, bad speed rejected', async () => {
    const start = await request(app).post('/api/replay/start').set('Authorization', `Bearer ${token}`).send({ interval_ms: 1000 });
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ state: 'running', interval_ms: 1000 });
    const pause = await request(app).post('/api/replay/pause').set('Authorization', `Bearer ${token}`);
    expect(pause.body.state).toBe('paused');
    const bad = await request(app).post('/api/replay/start').set('Authorization', `Bearer ${token}`).send({ interval_ms: 1 });
    expect(bad.status).toBe(400);
    state.replay.pause();
  });
});

describe('errors', () => {
  test('unknown /api path returns JSON 404, not HTML', async () => {
    const res = await get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });
});
