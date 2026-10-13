/**
 * Tests for the alert engine (state-change alerting, severity, cooldown)
 * and the telemetry replay service.
 */
const path = require('path');
const { AlertEngine, simulateAlerts } = require('../src/alerts/engine');
const { ReplayService } = require('../src/alerts/replay');
const { loadDataset } = require('../src/loadData');

const CSV_PATH = path.join(__dirname, '..', '..', 'data', 'Case_Study_3_Pure_Insights_Monitoring.csv');
const FIXED_NOW = () => new Date('2026-10-13T09:00:00.000Z');

let idCounter = 0;
/** Minimal snapshot with the fields the engine reads. */
function snap(reportId, loadTime, status = 'SUCCESS') {
  idCounter += 1;
  return {
    snapshot_id: idCounter,
    report_id: reportId,
    report_name: `Report ${reportId}`,
    avg_load_time_sec: loadTime,
    last_refresh_status: status,
    period: '2026-09',
    snapshot_ts: '2026-09-01T00:00:00.000Z',
  };
}

function newEngine(options = {}) {
  return new AlertEngine({ warningSec: 15, criticalSec: 30, cooldownSnapshots: 3, now: FIXED_NOW, ...options });
}

describe('latency alerts: the examples from the brief', () => {
  const engine = newEngine();

  test('12 s: healthy, no alert', () => {
    expect(engine.process(snap('RPT_200', 12))).toEqual([]);
  });

  let breach;
  test('12 s -> 44 s: LATENCY_BREACH, CRITICAL', () => {
    const events = engine.process(snap('RPT_200', 44));
    expect(events).toHaveLength(1);
    [breach] = events;
    expect(breach).toMatchObject({
      type: 'LATENCY_BREACH',
      severity: 'CRITICAL',
      report_id: 'RPT_200',
      metric: 'avg_load_time_sec',
      value: 44,
      threshold: 30,
      ts: '2026-10-13T09:00:00.000Z',
      notified: true,
      previous_state: 'OK',
    });
  });

  test('next snapshot 40 s: no new alert (still in breach)', () => {
    expect(engine.process(snap('RPT_200', 40))).toEqual([]);
    expect(engine.getActive()).toHaveLength(1);
  });

  test('drops to 9 s: RECOVERED, INFO, which resolves the breach', () => {
    const [recovered] = engine.process(snap('RPT_200', 9));
    expect(recovered).toMatchObject({ type: 'RECOVERED', severity: 'INFO', value: 9, resolves: breach.id, notified: true });
    expect(engine.getActive()).toHaveLength(0);
  });
});

describe('latency severity bands', () => {
  test('exactly 15.0 s is not a breach, 15.1 s is a WARNING', () => {
    const engine = newEngine();
    expect(engine.process(snap('A', 15.0))).toEqual([]);
    const [warning] = engine.process(snap('A', 15.1));
    expect(warning).toMatchObject({ type: 'LATENCY_BREACH', severity: 'WARNING', threshold: 15 });
  });

  test('WARNING escalates to CRITICAL once, and does not flap back and forth', () => {
    const engine = newEngine();
    engine.process(snap('A', 20)); // WARNING
    const [escalated] = engine.process(snap('A', 35));
    expect(escalated).toMatchObject({ type: 'LATENCY_BREACH', severity: 'CRITICAL', escalation: true, previous_state: 'WARNING' });
    expect(engine.process(snap('A', 25))).toEqual([]); // stays CRITICAL while open
    expect(engine.process(snap('A', 40))).toEqual([]); // no second escalation
    expect(engine.getActive()[0].severity).toBe('CRITICAL');
  });
});

describe('refresh alerts', () => {
  test('FAILED -> REFRESH_FAILURE CRITICAL; TIMED_OUT next is the same problem; SUCCESS recovers', () => {
    const engine = newEngine();
    const [failure] = engine.process(snap('A', 5, 'FAILED'));
    expect(failure).toMatchObject({ type: 'REFRESH_FAILURE', severity: 'CRITICAL', metric: 'last_refresh_status', value: 'FAILED', threshold: null });
    expect(engine.process(snap('A', 5, 'TIMED_OUT'))).toEqual([]);
    const [recovered] = engine.process(snap('A', 5, 'SUCCESS'));
    expect(recovered).toMatchObject({ type: 'RECOVERED', resolved_type: 'REFRESH_FAILURE', value: 'SUCCESS' });
  });

  test('TIMED_OUT on its own is a refresh failure too', () => {
    const [failure] = newEngine().process(snap('A', 5, 'TIMED_OUT'));
    expect(failure).toMatchObject({ type: 'REFRESH_FAILURE', severity: 'CRITICAL', value: 'TIMED_OUT' });
  });

  test('UNKNOWN -> MONITORING_GAP WARNING; then FAILED escalates even inside the cooldown', () => {
    const engine = newEngine();
    const [gap] = engine.process(snap('A', 5, 'UNKNOWN'));
    expect(gap).toMatchObject({ type: 'MONITORING_GAP', severity: 'WARNING' });
    expect(engine.process(snap('A', 5, 'UNKNOWN'))).toEqual([]);
    const [failure] = engine.process(snap('A', 5, 'FAILED'));
    expect(failure).toMatchObject({ type: 'REFRESH_FAILURE', notified: true, previous_state: 'MONITORING_GAP' });
  });

  test('UNKNOWN after FAILED does not count as recovery', () => {
    const engine = newEngine();
    engine.process(snap('A', 5, 'FAILED'));
    expect(engine.process(snap('A', 5, 'UNKNOWN'))).toEqual([]);
    expect(engine.getActive()[0].type).toBe('REFRESH_FAILURE');
  });

  test('one snapshot can raise a latency and a refresh alert at the same time', () => {
    const events = newEngine().process(snap('A', 50, 'FAILED'));
    expect(events.map((e) => e.type)).toEqual(['LATENCY_BREACH', 'REFRESH_FAILURE']);
  });
});

describe('cooldown', () => {
  test('a flapping report is notified once; the quick repeat is held back', () => {
    const engine = newEngine({ cooldownSnapshots: 3 });
    const notified = (events) => events.filter((e) => e.notified).map((e) => e.type);

    expect(notified(engine.process(snap('A', 44)))).toEqual(['LATENCY_BREACH']); // seq 1: notify
    expect(notified(engine.process(snap('A', 9)))).toEqual(['RECOVERED']); //       seq 2
    const held = engine.process(snap('A', 44)); //                                  seq 3: 2 snapshots later -> cooldown
    expect(held[0]).toMatchObject({ type: 'LATENCY_BREACH', notified: false, suppressed_reason: 'COOLDOWN' });
    const quietRecovery = engine.process(snap('A', 9)); //                          seq 4: its recovery is quiet too
    expect(quietRecovery[0]).toMatchObject({ type: 'RECOVERED', notified: false, suppressed_reason: 'PARENT_NOT_NOTIFIED' });
    expect(notified(engine.process(snap('A', 44)))).toEqual(['LATENCY_BREACH']); // seq 5: cooldown over -> notify
  });

  test('a held-back alert that is still active after the cooldown is notified late, never lost', () => {
    const engine = newEngine({ cooldownSnapshots: 3 });
    engine.process(snap('A', 44)); //                    seq 1 notify
    engine.process(snap('A', 9)); //                     seq 2 recovered
    expect(engine.process(snap('A', 44))[0].notified).toBe(false); // seq 3 held back
    expect(engine.process(snap('A', 44))).toEqual([]); // seq 4 still cooling
    const [late] = engine.process(snap('A', 44)); //     seq 5 cooldown over, still breaching
    expect(late).toMatchObject({ type: 'LATENCY_BREACH', notified: true, delayed: true });
    const [recovered] = engine.process(snap('A', 9));
    expect(recovered.notified).toBe(true); //            people were told, so they hear about the recovery
  });

  test('cooldowns are per report', () => {
    const engine = newEngine({ cooldownSnapshots: 3 });
    engine.process(snap('A', 44));
    engine.process(snap('A', 9));
    const [b] = engine.process(snap('B', 44));
    expect(b.notified).toBe(true);
  });

  test('cooldown 0 means pure state-change alerting', () => {
    const engine = newEngine({ cooldownSnapshots: 0 });
    engine.process(snap('A', 44));
    engine.process(snap('A', 9));
    expect(engine.process(snap('A', 44))[0].notified).toBe(true);
  });
});

describe('history, active alerts and reset', () => {
  const engine = newEngine();
  engine.process(snap('A', 44)); // CRITICAL
  engine.process(snap('B', 20)); // WARNING
  engine.process(snap('C', 5, 'UNKNOWN')); // WARNING gap
  engine.process(snap('A', 9)); // RECOVERED

  test('active alerts are listed most severe first', () => {
    const active = engine.getActive();
    expect(active.map((a) => a.report_id)).toEqual(['B', 'C']);
    expect(engine.getActiveSummary()).toEqual({
      active_total: 2,
      by_severity: { CRITICAL: 0, WARNING: 2 },
      by_type: { LATENCY_BREACH: 1, MONITORING_GAP: 1 },
    });
  });

  test('history is newest first and filterable', () => {
    const all = engine.getHistory();
    expect(all[0].type).toBe('RECOVERED');
    expect(engine.getHistory({ severity: 'CRITICAL' })).toHaveLength(1);
    expect(engine.getHistory({ reportId: 'B' })[0].severity).toBe('WARNING');
    expect(engine.getHistory({ limit: 2 })).toHaveLength(2);
  });

  test('reset({ keepHistory: true }) clears state but keeps history; reset() clears everything', () => {
    engine.reset({ keepHistory: true });
    expect(engine.getActive()).toEqual([]);
    expect(engine.getHistory().length).toBe(4);
    engine.reset();
    expect(engine.getHistory()).toEqual([]);
    expect(engine.getStats().events_total).toBe(0);
  });

  test('history is capped so memory cannot grow forever', () => {
    const small = newEngine({ historyLimit: 3, cooldownSnapshots: 0 });
    for (let i = 0; i < 10; i += 1) small.process(snap('A', i % 2 ? 44 : 9));
    expect(small.history).toHaveLength(3);
  });
});

describe('full dataset', () => {
  const { snapshots } = loadDataset(CSV_PATH);

  test('every event carries the fields promised in the API spec', () => {
    const engine = newEngine();
    const events = snapshots.flatMap((s) => engine.process(s));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      for (const field of ['id', 'type', 'severity', 'report_id', 'metric', 'value', 'threshold', 'ts', 'snapshot_ts', 'message', 'notified']) {
        expect(e).toHaveProperty(field);
      }
    }
  });

  test('active alerts always match reality: exactly the reports currently breaching or failing', () => {
    const engine = newEngine();
    snapshots.forEach((s) => engine.process(s));
    const latest = new Map(snapshots.map((s) => [s.report_id, s])); // last one per report wins
    const breaching = [...latest.values()].filter((s) => s.avg_load_time_sec > 15).map((s) => s.report_id).sort();
    const notOk = [...latest.values()].filter((s) => s.last_refresh_status !== 'SUCCESS').map((s) => s.report_id).sort();
    const active = engine.getActive();
    expect(active.filter((a) => a.type === 'LATENCY_BREACH').map((a) => a.report_id).sort()).toEqual(breaching);
    expect(active.filter((a) => a.type !== 'LATENCY_BREACH').map((a) => a.report_id).sort()).toEqual(notOk);
  });

  test('alert rules send far fewer notifications than one alert per bad row', () => {
    const sim = simulateAlerts(snapshots, { warningSec: 15, criticalSec: 30, cooldownSnapshots: 3 });
    expect(sim.snapshots).toBe(2000);
    expect(sim.naive_per_row_alerts).toBe(1490 + 382 + 182 + 100);
    expect(sim.state_change_only_notifications).toBeLessThan(sim.naive_per_row_alerts);
    expect(sim.state_change_with_cooldown_notifications).toBeLessThan(sim.state_change_only_notifications);
    // Pages (WARNING/CRITICAL) a person must act on drop by more than half.
    expect(sim.actionable_notifications).toBeLessThan(sim.state_change_only_actionable);
    expect(sim.actionable_reduction_pct).toBeGreaterThan(50);
    expect(sim.noise_reduction_pct).toBeGreaterThan(20);
  });
});

describe('ReplayService', () => {
  const snapshots = [snap('A', 10), snap('B', 44), snap('A', 50, 'FAILED')];

  test('step() plays rows in order and emits telemetry and alert messages', () => {
    const replay = new ReplayService({ snapshots, engine: newEngine(), loop: false });
    const messages = [];
    replay.on('message', (m) => messages.push(m));

    replay.step();
    replay.step();
    expect(messages.map((m) => m.type)).toEqual(['TELEMETRY', 'TELEMETRY', 'LATENCY_BREACH']);
    expect(messages[2]).toMatchObject({ kind: 'alert', severity: 'CRITICAL', report_id: 'B' });
    expect(replay.getStatus()).toMatchObject({ position: 2, total: 3, progress_pct: 66.7 });
  });

  test('without loop, the replay finishes at the end', () => {
    const replay = new ReplayService({ snapshots, engine: newEngine(), loop: false });
    const states = [];
    replay.on('message', (m) => { if (m.type === 'REPLAY_STATE') states.push(m.reason); });
    for (let i = 0; i < 4; i += 1) replay.step();
    expect(replay.getStatus().state).toBe('finished');
    expect(states).toEqual(['finished']);
  });

  test('with loop, it starts again with fresh alert state and counts cycles', () => {
    const engine = newEngine();
    const replay = new ReplayService({ snapshots, engine, loop: true });
    for (let i = 0; i < 4; i += 1) replay.step();
    expect(replay.getStatus()).toMatchObject({ cycle: 2, position: 1 });
    expect(engine.getActive()).toEqual([]); // state reset on loop (A at 10 s is healthy)
    expect(engine.getHistory().length).toBeGreaterThan(0); // history kept
  });

  test('start/pause drive a timer at the configured speed', () => {
    jest.useFakeTimers();
    const replay = new ReplayService({ snapshots, engine: newEngine(), intervalMs: 500, loop: false });
    replay.start();
    expect(replay.getStatus().state).toBe('running');
    jest.advanceTimersByTime(1000);
    expect(replay.getStatus().position).toBe(2);
    replay.pause();
    jest.advanceTimersByTime(5000);
    expect(replay.getStatus()).toMatchObject({ state: 'paused', position: 2 });
    jest.useRealTimers();
  });

  test('start rejects silly speeds; reset rewinds and clears alerts', () => {
    const engine = newEngine();
    const replay = new ReplayService({ snapshots, engine });
    expect(() => replay.start(1)).toThrow(RangeError);
    replay.step();
    replay.step();
    replay.reset();
    expect(replay.getStatus()).toMatchObject({ state: 'idle', position: 0, cycle: 1 });
    expect(engine.getHistory()).toEqual([]);
  });
});
