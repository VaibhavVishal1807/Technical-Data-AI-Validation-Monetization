/**
 * errors.js
 * One error format for the whole API:
 *   { "error": { "code": "NOT_FOUND", "message": "Report RPT_999 not found" } }
 */

/** Throw this from a route to send a specific HTTP status and error code. */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Any /api URL that no route matched. */
function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No endpoint ${req.method} ${req.originalUrl}` } });
}

/**
 * Express recognises error handlers by their four arguments (err, req, res, next).
 * Express 5 also forwards errors thrown inside async routes here automatically.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.details) body.error.details = err.details;
    return res.status(err.status).json(body);
  }
  // Malformed JSON body sent by the client.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
  }
  console.error('[api] unexpected error:', err);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server' } });
}

module.exports = { ApiError, notFoundHandler, errorHandler };
