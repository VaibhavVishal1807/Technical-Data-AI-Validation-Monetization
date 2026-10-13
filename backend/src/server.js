/**
 * server.js
 * Entry point: loads the data, builds the app and starts listening.
 *   npm run dev   (restarts automatically when a file changes)
 *   npm start
 */
const http = require('http');
const config = require('./config');
const { createState } = require('./state');
const { createApp } = require('./app');
const { attachAlertSocket, WS_PATH } = require('./ws');

function start() {
  const state = createState(config);
  const app = createApp(state);

  // We create the HTTP server ourselves (instead of app.listen) so that the
  // WebSocket server can share the same port.
  const server = http.createServer(app);

  // Real-time alerts: everything the replay emits is broadcast to browsers.
  const socket = attachAlertSocket(server, state);
  state.replay.on('message', socket.broadcast);

  server.listen(config.port, config.host, () => {
    const { meta } = state.dataset;
    console.log(`[api] loaded ${meta.row_count} snapshots for ${meta.report_count} reports (${meta.earliest_period} to ${meta.latest_period})`);
    console.log(`[api] data quality: ${state.dataQuality.summary.checks_with_findings} checks with findings, ${state.dataQuality.summary.rows_dropped} rows dropped`);
    console.log(`[api] listening on http://${config.host}:${config.port}/api`);
    console.log(`[ws]  alerts on ws://${config.host}:${config.port}${WS_PATH}?token=<JWT>`);
    const sim = state.alertSimulation;
    console.log(`[alerts] full-file simulation: ${sim.naive_per_row_alerts} per-row alerts -> ${sim.actionable_notifications} actionable notifications (${sim.actionable_reduction_pct}% fewer pages)`);
    if (config.replayAutostart) {
      state.replay.start();
      console.log(`[replay] streaming ${state.dataset.meta.row_count} snapshots, one every ${config.replayIntervalMs} ms${config.replayLoop ? ' (looping)' : ''}`);
    }
    if (config.jwtSecretGenerated) {
      console.log('[api] note: JWT_SECRET not set, using a random secret (logins reset when the server restarts)');
    }
  });

  // Stop cleanly on Ctrl+C so the port is released straight away.
  const shutdown = () => {
    state.replay.stop();
    socket.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { server, state, socket };
}

if (require.main === module) {
  start();
}

module.exports = { start };
