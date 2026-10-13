/**
 * alerts/replay.js
 * Simulates live telemetry. The CSV is a static file, so this service plays
 * its rows back in order (one every REPLAY_INTERVAL_MS) as if they were
 * arriving from the portal in real time. Each row goes through the alert
 * engine, and the results are emitted as 'message' events, which the
 * WebSocket layer broadcasts to connected browsers.
 *
 * Messages emitted (every message has a `kind` and a `type`):
 *   kind 'alert'     type LATENCY_BREACH | REFRESH_FAILURE | MONITORING_GAP | RECOVERED
 *                    flat: { kind, type, severity, report_id, metric, value, threshold, ts, ... }
 *   kind 'telemetry' type TELEMETRY     every row (a live feed of readings)
 *   kind 'system'    type REPLAY_STATE  when the replay starts, pauses, resets, loops or finishes
 */
const { EventEmitter } = require('events');

class ReplayService extends EventEmitter {
  constructor({ snapshots, engine, intervalMs = 500, loop = true }) {
    super();
    // File order = chronological order (see loadData.js).
    this.snapshots = [...snapshots].sort((a, b) => a.snapshot_id - b.snapshot_id);
    this.engine = engine;
    this.intervalMs = intervalMs;
    this.loop = loop;
    this.position = 0; // index of the next snapshot to play
    this.cycle = 1;
    this.state = 'idle'; // idle | running | paused | finished
    this.timer = null;
    this.startedAt = null;
  }

  getStatus() {
    const total = this.snapshots.length;
    const last = this.position > 0 ? this.snapshots[this.position - 1] : null;
    return {
      state: this.state,
      position: this.position,
      total,
      progress_pct: total ? Math.round((this.position / total) * 1000) / 10 : 0,
      interval_ms: this.intervalMs,
      loop: this.loop,
      cycle: this.cycle,
      current_period: last ? last.period : null,
      started_at: this.startedAt,
    };
  }

  _emitState(reason) {
    this.emit('message', { kind: 'system', type: 'REPLAY_STATE', reason, ts: new Date().toISOString(), replay: this.getStatus() });
  }

  start(intervalMs) {
    if (intervalMs !== undefined) {
      if (!Number.isFinite(intervalMs) || intervalMs < 20 || intervalMs > 60000) {
        throw new RangeError('intervalMs must be between 20 and 60000');
      }
      this.intervalMs = intervalMs;
    }
    if (this.state === 'finished') this._rewind();
    this._clearTimer();
    this.timer = setInterval(() => this.step(), this.intervalMs);
    // Don't keep the Node process alive just for this timer (helps tests exit).
    if (this.timer.unref) this.timer.unref();
    this.state = 'running';
    this.startedAt = this.startedAt || new Date().toISOString();
    this._emitState('started');
    return this.getStatus();
  }

  pause() {
    this._clearTimer();
    if (this.state === 'running') this.state = 'paused';
    this._emitState('paused');
    return this.getStatus();
  }

  /** Stop, go back to the first row and clear all alert state and history. */
  reset() {
    this._clearTimer();
    this.position = 0;
    this.cycle = 1;
    this.startedAt = null;
    this.engine.reset();
    this.state = 'idle';
    this._emitState('reset');
    return this.getStatus();
  }

  /** Play exactly one snapshot. Called by the timer, or directly in tests. */
  step() {
    if (this.position >= this.snapshots.length) {
      if (!this.loop) {
        this._clearTimer();
        this.state = 'finished';
        this._emitState('finished');
        return [];
      }
      // Loop: start the stream again with fresh alert state, keep history.
      this._rewind();
      this.cycle += 1;
      this._emitState('looped');
    }

    const snapshot = this.snapshots[this.position];
    this.position += 1;
    const events = this.engine.process(snapshot);

    this.emit('message', {
      kind: 'telemetry',
      type: 'TELEMETRY',
      ts: new Date().toISOString(),
      snapshot_id: snapshot.snapshot_id,
      report_id: snapshot.report_id,
      period: snapshot.period,
      avg_load_time_sec: snapshot.avg_load_time_sec,
      latency_band: snapshot.latency_band,
      last_refresh_status: snapshot.last_refresh_status,
      monthly_active_views: snapshot.monthly_active_views,
      position: this.position,
      total: this.snapshots.length,
      // Lets the UI keep its "active alerts" badge exact without polling.
      active_summary: this.engine.getActiveSummary(),
    });
    for (const event of events) {
      if (event.notified) this.emit('message', { kind: 'alert', ...event });
    }
    return events;
  }

  _rewind() {
    this.position = 0;
    this.engine.reset({ keepHistory: true });
  }

  _clearTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stop() {
    this._clearTimer();
  }
}

module.exports = { ReplayService };
