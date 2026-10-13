/**
 * app.js
 * Builds the Express application (routes + middleware) without starting a
 * server. Keeping this separate from server.js lets tests send requests to the
 * app directly (with supertest) without opening a real network port.
 */
const path = require('path');
const fs = require('fs');
const express = require('express');

const { notFoundHandler, errorHandler } = require('./errors');
const { authenticate, requirePermission } = require('./auth');
const authRouter = require('./routes/auth');
const healthRouter = require('./routes/health');
const reportsRouter = require('./routes/reports');
const costsRouter = require('./routes/costs');
const dataQualityRouter = require('./routes/dataQuality');
const usersRouter = require('./routes/users');
const alertsRouter = require('./routes/alerts');
const replayRouter = require('./routes/replay');

function createApp(state) {
  const app = express();
  app.disable('x-powered-by'); // don't advertise the framework
  app.use(express.json({ limit: '100kb' })); // parse JSON request bodies

  // ---------------------------------------------------------------------
  // Access-control map. Every route is listed here with the permission it
  // needs (see permissions.js for which roles have which permission).
  // The check runs on the server, so hiding a page in the UI is not the
  // only protection: calling the API directly still returns 401/403.
  // ---------------------------------------------------------------------
  const guard = (permission) => [authenticate, requirePermission(permission)];

  // Public
  app.get('/api', (req, res) => res.json({ name: 'Pure Insights Command Center API', docs: 'docs/API_SPEC.md' }));
  app.get('/api/health/live', (req, res) => res.json({ status: 'ok', uptime_sec: Math.round(process.uptime()) }));
  app.use('/api/auth', authRouter()); // login is public; /me checks the token itself

  // Protected
  app.use('/api/health', guard('health:read'), healthRouter(state)); //            admin, analyst, viewer
  app.use('/api/data-quality', guard('dataquality:read'), dataQualityRouter(state)); // admin, analyst, viewer
  app.use('/api/alerts', guard('alerts:read'), alertsRouter(state)); //            admin, analyst, viewer
  app.use('/api/replay', guard('alerts:read'), replayRouter(state)); //            status: all roles; POST start/pause/reset also need replay:control (admin)
  app.use('/api/reports', guard('reports:read'), reportsRouter(state)); //         admin, analyst
  app.use('/api/costs', guard('costs:read'), costsRouter(state)); //               admin, analyst
  app.use('/api/users', guard('users:read'), usersRouter()); //                    admin

  // Unknown /api/* paths get a JSON 404 instead of an HTML page.
  app.use('/api', notFoundHandler);

  // In production (after `npm run build`), serve the React app from the same server.
  const distDir = path.join(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    // Any other path returns index.html so React Router can handle it.
    app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
