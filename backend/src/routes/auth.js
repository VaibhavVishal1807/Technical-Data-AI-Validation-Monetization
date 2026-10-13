/**
 * routes/auth.js
 *   POST /api/auth/login  - body { username, password } -> { token, user }
 *   GET  /api/auth/me     - who am I? (requires a token)
 */
const express = require('express');
const config = require('../config');
const { verifyCredentials, signToken, authenticate } = require('../auth');
const { publicUser } = require('../users');
const { permissionsFor } = require('../permissions');
const { ApiError } = require('../errors');

function authRouter() {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password
      || username.length > 100 || password.length > 200) {
      throw new ApiError(400, 'BAD_REQUEST', 'Send JSON { "username": "...", "password": "..." }');
    }

    const user = await verifyCredentials(username, password);
    if (!user) {
      // Same message for "no such user" and "wrong password".
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Wrong username or password');
    }

    res.json({
      token: signToken(user),
      token_type: 'Bearer',
      expires_in: config.jwtExpiresIn,
      user: { ...publicUser(user), permissions: permissionsFor(user.role) },
    });
  });

  router.get('/me', authenticate, (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}

module.exports = authRouter;
