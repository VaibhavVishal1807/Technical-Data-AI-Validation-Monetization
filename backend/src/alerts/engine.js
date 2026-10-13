/**
 * alerts/engine.js
 * Turns a stream of telemetry snapshots into alerts.
 *
 * Why not "one alert per bad row"? 74.5% of rows breach 15 s. Alerting on
 * every row would bury real problems in noise (an "alert storm"). Instead:
 *
 *  1. STATE-CHANGE alerting. Each report has a state per metric (load time,
 *     refresh). We alert when the state changes:
 *        OK -> breach                 LATENCY_BREACH   (WARNING >15 s, CRITICAL >30 s)
 *        WARNING -> CRITICAL          LATENCY_BREACH   (escalation)
 *        refresh FAILED / TIMED_OUT   REFRESH_FAILURE  (CRITICAL)
 *        refresh UNKNOWN              MONITORING_GAP   (WARNING)
 *        back to normal               RECOVERED        (INFO)
 *     Staying in the same bad state sends nothing new.
 *
 *  2. COOLDOWN. After notifying about a report, the same alert type for that
 *     report stays quiet for its next N snapshots, so a report flapping in and
 *     out of breach does not page people every time. The alert is still
 *     recorded and shown as active; only the notification is held back. If
 *     the problem is still there when the cooldown ends, the notification is
 *     sent then, so a persistent problem is never hidden.
 *
 * The engine is pure logic: no timers, no network. The replay service feeds
 * it snapshots, and the WebSocket layer broadcasts what it returns.
 */
const { latencyBand } = require('../loadData');

const SEVERITY = { INFO: 'INFO', WARNING: 'WARNING', CRITICAL: 'CRITICAL' };
const ALERT_TYPES = {
  LATENCY_BREACH: 'LATENCY_BREACH',
  REFRESH_FAILURE: 'REFRESH_FAILURE',
  MONITORING_GAP: 'MONITORING_GAP',
  RECOVERED: 'RECOVERED',
};
const FAILING_STATUSES = ['FAILED', 'TIMED_OUT'];

class AlertEngine {
  constructor({
    warningSec = 15,
    criticalSec = 30,
    cooldownSnapshots = 3,
    historyLimit = 1000,
    now = () => new Date(),
  } = {}) {
    this.warningSec = warningSec;
    this.criticalSec = criticalSec;
    this.cooldownSnapshots = cooldownSnapshots;
    this.historyLimit = historyLimit;
    this.now = now;
    this.eventCounter = 0;
    this.reset();
  }

  /**
   * Forget all report states and active alerts.
   * keepHistory = true keeps past events (used when the replay loops).
   */
  reset({ keepHistory = false } = {}) {
    this.reports = new Map(); // report_id -> { seq, latency, refresh, lastNotified }
    if (!keepHistory) {
      this.history = [];
      this.stats = {
        snapshots_processed: 0,
        naive_alert_count: 0, // what "one alert per bad row" would have sent
        events_total: 0,
        notifications_sent: 0,
        suppressed_total: 0,
        suppressed_by_reason: {}, // COOLDOWN, or PARENT_NOT_NOTIFIED for a quiet recovery
        delayed_notifications: 0,
        by_type: {},
        by_severity: {},
      };
    }
  }

  _stateFor(reportId) {
    if (!this.reports.has(reportId)) {
      this.reports.set(reportId, {
        seq: 0, // how many snapshots of this report we have seen
        latency: null, // active latency alert, or null when OK
        refresh: null, // active refresh alert, or null when OK
        lastNotified: {}, // alert type -> seq of the last notification
      });
    }
    return this.reports.get(reportId);
  }

  /** True while the cooldown for this alert type is still running. */
  _inCooldown(st, type) {
    const last = st.lastNotified[type];
    return last !== undefined && st.seq - last <= this.cooldownSnapshots;
  }

  _makeEvent(type, severity, snapshot, fields) {
    this.eventCounter += 1;
    return {
      id: `evt_${String(this.eventCounter).padStart(6, '0')}`,
      type,
      severity,
      report_id: snapshot.report_id,
      report_name: snapshot.report_name,
      metric: fields.metric,
      value: fields.value,
      threshold: fields.threshold, // number for load time, null for refresh status
      ts: this.now().toISOString(), // when the alert was raised
      snapshot_ts: snapshot.snapshot_ts, // which data period it is about
      period: snapshot.period,
      snapshot_id: snapshot.snapshot_id,
      previous_state: fields.previous,
      message: fields.message,
      notified: fields.notify,
      suppressed_reason: fields.notify ? null : (fields.suppressedReason || 'COOLDOWN'),
      ...(fields.extra || {}),
    };
  }

  /**
   * Open a new alert (or hold it back if the cooldown is running).
   * force = true skips the cooldown, for a situation that just got worse.
   */
  _open(st, slot, type, severity, snapshot, fields, { force = false } = {}) {
    const cooling = !force && this._inCooldown(st, type);
    const event = this._makeEvent(type, severity, snapshot, { ...fields, notify: !cooling });
    if (!cooling) st.lastNotified[type] = st.seq;
    st[slot] = {
      alert_id: event.id,
      type,
      severity,
      report_id: snapshot.report_id,
      report_name: snapshot.report_name,
      metric: fields.metric,
      value: fields.value,
      threshold: fields.threshold,
      opened_at: event.ts,
      opened_period: snapshot.period,
      last_period: snapshot.period,
      notified: !cooling,
    };
    return event;
  }

  /** Close an active alert with a RECOVERED event. */
  _recover(st, slot, snapshot, fields) {
    const active = st[slot];
    st[slot] = null;
    // Only announce a recovery if people were told about the problem.
    return this._makeEvent(ALERT_TYPES.RECOVERED, SEVERITY.INFO, snapshot, {
      ...fields,
      previous: active.type === ALERT_TYPES.LATENCY_BREACH ? active.severity : active.type,
      notify: active.notified,
      suppressedReason: 'PARENT_NOT_NOTIFIED',
      extra: { resolves: active.alert_id, resolved_type: active.type },
    });
  }

  /** A held-back alert whose cooldown has ended and is still active: notify now. */
  _releaseIfDue(st, slot, snapshot) {
    const active = st[slot];
    if (!active || active.notified || this._inCooldown(st, active.type)) return null;
    active.notified = true;
    st.lastNotified[active.type] = st.seq;
    this.stats.delayed_notifications += 1;
    return this._makeEvent(active.type, active.severity, snapshot, {
      metric: active.metric,
      value: active.value,
      threshold: active.threshold,
      previous: active.severity,
      message: `Still active after cooldown: ${describeActive(active)}`,
      notify: true,
      extra: { delayed: true, alert_id: active.alert_id },
    });
  }

  _checkLatency(snapshot, st) {
    const value = snapshot.avg_load_time_sec;
    if (value === null || value === undefined) return [];
    const band = latencyBand(value, this.warningSec, this.criticalSec);
    const active = st.latency;
    const metric = 'avg_load_time_sec';

    if (band === 'OK') {
      if (!active) return [];
      return [this._recover(st, 'latency', snapshot, {
        metric,
        value,
        threshold: this.warningSec,
        message: `Load time recovered to ${value}s (at or below ${this.warningSec}s)`,
      })];
    }

    const threshold = band === 'CRITICAL' ? this.criticalSec : this.warningSec;
    if (!active) {
      return [this._open(st, 'latency', ALERT_TYPES.LATENCY_BREACH, band, snapshot, {
        metric,
        value,
        threshold,
        previous: 'OK',
        message: `Load time ${value}s exceeds ${threshold}s`,
      })];
    }

    // Already in breach. Severity only goes up while the alert is open, so a
    // report bouncing between 25 s and 35 s escalates once, not every time.
    active.value = value;
    active.last_period = snapshot.period;
    if (band === 'CRITICAL' && active.severity === 'WARNING') {
      active.severity = 'CRITICAL';
      active.threshold = this.criticalSec;
      active.notified = true;
      st.lastNotified[ALERT_TYPES.LATENCY_BREACH] = st.seq;
      return [this._makeEvent(ALERT_TYPES.LATENCY_BREACH, SEVERITY.CRITICAL, snapshot, {
        metric,
        value,
        threshold: this.criticalSec,
        previous: 'WARNING',
        message: `Load time escalated to ${value}s (above ${this.criticalSec}s)`,
        notify: true, // a worse situation is always worth telling people about
        extra: { escalation: true, alert_id: active.alert_id },
      })];
    }
    const released = this._releaseIfDue(st, 'latency', snapshot);
    return released ? [released] : [];
  }

  _checkRefresh(snapshot, st) {
    const status = snapshot.last_refresh_status;
    const active = st.refresh;
    const metric = 'last_refresh_status';

    if (status === 'SUCCESS') {
      if (!active) return [];
      return [this._recover(st, 'refresh', snapshot, {
        metric,
        value: status,
        threshold: null,
        message: `Refresh succeeded again (was ${active.value})`,
      })];
    }

    if (FAILING_STATUSES.includes(status)) {
      if (active && active.type === ALERT_TYPES.REFRESH_FAILURE) {
        active.value = status; // still failing: nothing new to say
        active.last_period = snapshot.period;
        const released = this._releaseIfDue(st, 'refresh', snapshot);
        return released ? [released] : [];
      }
      const wasGap = Boolean(active); // UNKNOWN -> FAILED got worse, so skip the cooldown
      return [this._open(st, 'refresh', ALERT_TYPES.REFRESH_FAILURE, SEVERITY.CRITICAL, snapshot, {
        metric,
        value: status,
        threshold: null,
        previous: wasGap ? ALERT_TYPES.MONITORING_GAP : 'SUCCESS',
        message: status === 'TIMED_OUT' ? 'Scheduled refresh timed out' : 'Scheduled refresh failed',
      }, { force: wasGap })];
    }

    // UNKNOWN (or any unrecognised status): we cannot tell if it worked.
    if (active) {
      // Already failing or already in a gap; UNKNOWN does not prove recovery.
      active.last_period = snapshot.period;
      const released = this._releaseIfDue(st, 'refresh', snapshot);
      return released ? [released] : [];
    }
    return [this._open(st, 'refresh', ALERT_TYPES.MONITORING_GAP, SEVERITY.WARNING, snapshot, {
      metric,
      value: status,
      threshold: null,
      previous: 'SUCCESS',
      message: 'Refresh status UNKNOWN: monitoring gap',
    })];
  }

  _record(event) {
    this.stats.events_total += 1;
    if (event.notified) {
      this.stats.notifications_sent += 1;
      this.stats.by_type[event.type] = (this.stats.by_type[event.type] || 0) + 1;
      this.stats.by_severity[event.severity] = (this.stats.by_severity[event.severity] || 0) + 1;
    } else {
      const reason = event.suppressed_reason;
      this.stats.suppressed_total += 1;
      this.stats.suppressed_by_reason[reason] = (this.stats.suppressed_by_reason[reason] || 0) + 1;
    }
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.shift();
  }

  /**
   * Feed one snapshot. Returns every event it produced; events with
   * notified === false were held back by the cooldown.
   */
  process(snapshot) {
    const st = this._stateFor(snapshot.report_id);
    st.seq += 1;
    this.stats.snapshots_processed += 1;

    const band = latencyBand(snapshot.avg_load_time_sec ?? null, this.warningSec, this.criticalSec);
    if (band === 'WARNING' || band === 'CRITICAL') this.stats.naive_alert_count += 1;
    if (snapshot.last_refresh_status !== 'SUCCESS') this.stats.naive_alert_count += 1;

    const events = [...this._checkLatency(snapshot, st), ...this._checkRefresh(snapshot, st)];
    events.forEach((e) => this._record(e));
    return events;
  }

  /** Alerts that are open right now (most severe first). */
  getActive() {
    const order = { CRITICAL: 0, WARNING: 1, INFO: 2 };
    const active = [];
    for (const st of this.reports.values()) {
      if (st.latency) active.push({ ...st.latency });
      if (st.refresh) active.push({ ...st.refresh });
    }
    return active.sort((a, b) => order[a.severity] - order[b.severity] || a.report_id.localeCompare(b.report_id));
  }

  getActiveSummary() {
    const active = this.getActive();
    const bySeverity = { CRITICAL: 0, WARNING: 0 };
    const byType = {};
    for (const a of active) {
      bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
      byType[a.type] = (byType[a.type] || 0) + 1;
    }
    return { active_total: active.length, by_severity: bySeverity, by_type: byType };
  }

  /** Past events, newest first, with optional filters. */
  getHistory({ limit = 100, severity, type, reportId, includeSuppressed = false } = {}) {
    let events = this.history;
    if (!includeSuppressed) events = events.filter((e) => e.notified);
    if (severity) events = events.filter((e) => e.severity === severity);
    if (type) events = events.filter((e) => e.type === type);
    if (reportId) events = events.filter((e) => e.report_id === reportId);
    return events.slice(-limit).reverse();
  }

  getStats() {
    const { naive_alert_count: naive, notifications_sent: sent } = this.stats;
    // "Actionable" = WARNING or CRITICAL, i.e. something a person must look at.
    // RECOVERED messages are INFO: good news, not a page.
    const actionable = sent - (this.stats.by_type.RECOVERED || 0);
    const reduction = (n) => (naive ? Math.round((1 - n / naive) * 1000) / 10 : null);
    return {
      ...this.stats,
      actionable_notifications: actionable,
      noise_reduction_pct: reduction(sent),
      actionable_reduction_pct: reduction(actionable),
      cooldown_snapshots: this.cooldownSnapshots,
      thresholds: { warning_sec: this.warningSec, critical_sec: this.criticalSec },
    };
  }
}

function describeActive(active) {
  if (active.type === ALERT_TYPES.LATENCY_BREACH) return `load time ${active.value}s above ${active.threshold}s`;
  if (active.type === ALERT_TYPES.REFRESH_FAILURE) return `refresh ${active.value}`;
  return 'refresh status UNKNOWN';
}

/**
 * Run a fresh engine over a list of snapshots and return its statistics.
 * Used at startup to show how much noise the alert rules remove.
 */
function simulateAlerts(snapshots, options) {
  const withCooldown = new AlertEngine({ ...options, historyLimit: 1 });
  const stateChangeOnly = new AlertEngine({ ...options, cooldownSnapshots: 0, historyLimit: 1 });
  const fixedClock = () => new Date(0);
  withCooldown.now = fixedClock;
  stateChangeOnly.now = fixedClock;
  for (const s of snapshots) {
    withCooldown.process(s);
    stateChangeOnly.process(s);
  }
  const a = withCooldown.getStats();
  const b = stateChangeOnly.getStats();
  return {
    snapshots: a.snapshots_processed,
    naive_per_row_alerts: a.naive_alert_count,
    state_change_only_notifications: b.notifications_sent,
    state_change_with_cooldown_notifications: a.notifications_sent,
    suppressed: a.suppressed_by_reason,
    delayed_notifications: a.delayed_notifications,
    actionable_notifications: a.actionable_notifications,
    state_change_only_actionable: b.actionable_notifications,
    noise_reduction_pct: a.noise_reduction_pct,
    actionable_reduction_pct: a.actionable_reduction_pct,
    by_type: a.by_type,
    by_severity: a.by_severity,
    cooldown_snapshots: a.cooldown_snapshots,
  };
}

module.exports = { AlertEngine, simulateAlerts, SEVERITY, ALERT_TYPES };
