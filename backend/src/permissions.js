/**
 * permissions.js
 * Role-based access control (RBAC) in one table. Routes ask "does this role
 * have permission X?" instead of hard-coding role names everywhere, so
 * changing who can do what means editing only this file.
 *
 *   admin   - everything, including costs, replay control and user management
 *   analyst - health, reports, costs (read-only)
 *   viewer  - health and alerts only
 */
const ROLES = ['admin', 'analyst', 'viewer'];

const PERMISSIONS = {
  'health:read': ['admin', 'analyst', 'viewer'],
  'alerts:read': ['admin', 'analyst', 'viewer'],
  'dataquality:read': ['admin', 'analyst', 'viewer'],
  'reports:read': ['admin', 'analyst'],
  'costs:read': ['admin', 'analyst'],
  'replay:control': ['admin'],
  'users:read': ['admin'],
};

function hasPermission(role, permission) {
  const allowed = PERMISSIONS[permission];
  if (!allowed) throw new Error(`Unknown permission "${permission}"`);
  return allowed.includes(role);
}

/** All permissions a role has; sent to the frontend so it can hide pages. */
function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((p) => PERMISSIONS[p].includes(role));
}

module.exports = { ROLES, PERMISSIONS, hasPermission, permissionsFor };
