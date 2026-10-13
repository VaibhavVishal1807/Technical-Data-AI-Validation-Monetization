/**
 * routes/replay.js
 *   GET  /api/replay/status  - is the telemetry replay running, and how far along?
 *   POST /api/replay/start   - start or resume; optional body { "interval_ms": 200 }   (admin)
 *   POST /api/replay/pause   - pause                                                   (admin)
 *   POST /api/replay/reset   - back to the first row, clear alert state and history    (admin)
 *
 * Reading the status needs alerts:read (checked in app.js). Controlling the
 * replay changes what every user sees, so it needs replay:control (admin).
 */
const express = require('express');
const { requirePermission } = require('../auth');
const { ApiError } = require('../errors');

function replayRouter(state) {
  const router = express.Router();
  const canControl = requirePermission('replay:control');

  router.get('/status', (req, res) => {
    res.json(state.replay.getStatus());
  });

  router.post('/start', canControl, (req, res) => {
    const raw = req.body ? req.body.interval_ms : undefined;
    try {
      res.json(state.replay.start(raw === undefined ? undefined : Number(raw)));
    } catch (err) {
      if (err instanceof RangeError) throw new ApiError(400, 'BAD_REQUEST', 'interval_ms must be between 20 and 60000');
      throw err;
    }
  });

  router.post('/pause', canControl, (req, res) => {
    res.json(state.replay.pause());
  });

  router.post('/reset', canControl, (req, res) => {
    res.json(state.replay.reset());
  });

  return router;
}

module.exports = replayRouter;
