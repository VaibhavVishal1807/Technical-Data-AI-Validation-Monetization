/**
 * routes/users.js
 *   GET /api/users  - list platform users and their roles (admin only)
 */
const express = require('express');
const { USERS, publicUser } = require('../users');
const { permissionsFor } = require('../permissions');

function usersRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({
      count: USERS.length,
      users: USERS.map((u) => ({ ...publicUser(u), permissions: permissionsFor(u.role) })),
    });
  });

  return router;
}

module.exports = usersRouter;
