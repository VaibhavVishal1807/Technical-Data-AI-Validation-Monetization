/**
 * state.js
 * Builds everything the API serves, once, at startup. The dataset is static,
 * so cleaning, data quality and cost allocation are computed a single time and
 * kept in memory (no database needed to run the app).
 *
 * It also creates the alert engine and the telemetry replay. The replay is
 * created stopped; server.js starts it (tests drive it step by step).
 */
const { loadDataset } = require('./loadData');
const { buildDataQualityReport } = require('./dataQuality');
const { computeCostAllocation } = require('./costs');
const { AlertEngine, simulateAlerts } = require('./alerts/engine');
const { ReplayService } = require('./alerts/replay');

function createState(config) {
  const dataset = loadDataset(config.dataPath, {
    latestPeriod: config.latestPeriod,
    latencyWarningSec: config.latencyWarningSec,
    latencyCriticalSec: config.latencyCriticalSec,
  });
  const dataQuality = buildDataQualityReport(dataset, { creditPriceUsd: config.creditPriceUsd });
  const costs = computeCostAllocation(dataset.snapshots, dataset.reports, { creditPriceUsd: config.creditPriceUsd });

  const alertOptions = {
    warningSec: config.latencyWarningSec,
    criticalSec: config.latencyCriticalSec,
    cooldownSnapshots: config.alertCooldownSnapshots,
  };
  const alertEngine = new AlertEngine(alertOptions);
  const replay = new ReplayService({
    snapshots: dataset.snapshots,
    engine: alertEngine,
    intervalMs: config.replayIntervalMs,
    loop: config.replayLoop,
  });

  return {
    config,
    dataset,
    dataQuality,
    costs,
    // Lookups by report_id, so routes don't scan arrays.
    reportIndex: new Map(dataset.reports.map((r) => [r.report_id, r])),
    costIndex: new Map(costs.reports.map((r) => [r.report_id, r])),
    alertEngine,
    replay,
    // How many notifications the alert rules send over the whole file,
    // compared with one alert per bad row.
    alertSimulation: simulateAlerts(dataset.snapshots, alertOptions),
  };
}

module.exports = { createState };
