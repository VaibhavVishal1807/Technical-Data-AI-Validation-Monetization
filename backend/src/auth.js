/**
 * auth.js
 * Login with JWT, plus the two middleware functions that protect routes:
 *
 *   authenticate             "who are you?"  -> 401 if no valid token
 *   requirePermission(perm)  "are you allowed?" -> 403 if the role lacks perm
 *
 * Flow: POST /api/auth/login with username + password -> server checks the
 * bcrypt hash -> returns a signed token. The browser sends it back on every
 * request in the header "Authorization: Bearer <token>".
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { findUser, publicUser } = require('./users');
const { hasPermission, permissionsFor } = require('./permissions');
const { ApiError } = require('./errors');

// Hash of a random string. Used when the username does not exist so that a
// failed login takes the same time either way and does not reveal which
// usernames are real.
const DUMMY_HASH = '$2b$10$y.r/lzo5D001Avu6bH0AMuQqRjYuYG2HNdXl1/38c9/K5OY93WBQy';

/** Returns the user if username + password are correct, otherwise null. */
async function verifyCredentials(username, password) {
  const user = findUser(username);
  const ok = await bcrypt.compare(String(password), user ? user.passwordHash : DUMMY_HASH);
  return user && ok ? user : null;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.username, role: user.role, name: user.name },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: config.jwtExpiresIn },
  );
}

/**
 * Check a token and return the matching user, or throw an ApiError(401).
 * Shared by the HTTP middleware and the WebSocket handshake.
 */
function userFromToken(token) {
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Log in first: no token provided');
  let payload;
  try {
    // Pin the algorithm so a forged token cannot pick a weaker one.
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new ApiError(401, 'TOKEN_EXPIRED', 'Your session has expired, please log in again');
    }
    throw new ApiError(401, 'INVALID_TOKEN', 'Token is invalid');
  }
  // Read the role from the user list, not only from the token, so a removed
  // user or changed role takes effect immediately.
  const user = findUser(payload.sub);
  if (!user) throw new ApiError(401, 'INVALID_TOKEN', 'User no longer exists');
  return { ...publicUser(user), permissions: permissionsFor(user.role) };
}

/** Middleware: require a valid "Authorization: Bearer <token>" header. */
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  try {
    if (scheme !== 'Bearer') throw new ApiError(401, 'UNAUTHENTICATED', 'Log in first: missing "Authorization: Bearer <token>" header');
    req.user = userFromToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

/** Middleware factory: allow the request only if the user's role has `permission`. */
function requirePermission(permission) {
  return function checkPermission(req, res, next) {
    if (!req.user) return next(new ApiError(401, 'UNAUTHENTICATED', 'Log in first'));
    if (!hasPermission(req.user.role, permission)) {
      return next(new ApiError(403, 'FORBIDDEN', `Role "${req.user.role}" does not have permission "${permission}"`));
    }
    return next();
  };
}

module.exports = { verifyCredentials, signToken, userFromToken, authenticate, requirePermission };
