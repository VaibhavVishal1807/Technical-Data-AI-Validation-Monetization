/**
 * routes/dataQuality.js
 *   GET /api/data-quality  - every data check: count, detection rule, handling, rationale
 */
const express = require('express');

function dataQualityRouter(state) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json(state.dataQuality);
  });

  return router;
}

module.exports = dataQualityRouter;
