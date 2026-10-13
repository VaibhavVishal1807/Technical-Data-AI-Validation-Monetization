/**
 * Tests for authentication (JWT) and role-based access control (RBAC).
 *  1. The two middleware functions on their own, with fake req/res objects.
 *  2. The login endpoint.
 *  3. The full role x endpoint matrix against the real app: the backend must
 *     return 403 even if someone calls a hidden page's API directly.
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const { authenticate, requirePermission, signToken } = require('../src/auth');
const { hasPermission, permissionsFor, PERMISSIONS } = require('../src/permissions');
const { createApp } = require('../src/app');
const { createState } = require('../src/state');
const { loginAs } = require('./helpers');

/** Run a middleware with a fake request and capture what it passes to next(). */
function runMiddleware(middleware, req) {
  let nextArg = 'not called';
  middleware(req, {}, (arg) => { nextArg = arg; });
  return nextArg;
}

describe('permissions table', () => {
  test('roles map to the permissions in the brief', () => {
    expect(permissionsFor('admin')).toEqual(Object.keys(PERMISSIONS)); // everything
    expect(permissionsFor('analyst')).toEqual(['health:read', 'alerts:read', 'dataquality:read', 'reports:read', 'costs:read']);
    expect(permissionsFor('viewer')).toEqual(['health:read', 'alerts:read', 'dataquality:read']);
  });

  test('a typo in a permission name fails loudly instead of silently denying', () => {
    expect(() => hasPermission('admin', 'cost:read')).toThrow(/Unknown permission/);
  });

  test('an unknown role has no permissions', () => {
    expect(permissionsFor('hacker')).toEqual([]);
  });
});

describe('requirePermission middleware', () => {
  test('lets an allowed role through (next called with no error)', () => {
    const result = runMiddleware(requirePermission('costs:read'), { user: { role: 'analyst' } });
    expect(result).toBeUndefined();
  });

  test('blocks a role without the permission with 403', () => {
    const err = runMiddleware(requirePermission('costs:read'), { user: { role: 'viewer' } });
    expect(err.status).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });

  test('blocks a request with no user with 401', () => {
    const err = runMiddleware(requirePermission('health:read'), {});
    expect(err.status).toBe(401);
  });
});

describe('authenticate middleware', () => {
  const adminToken = signToken({ username: 'admin', role: 'admin', name: 'Platform Admin' });

  test('accepts a valid Bearer token and attaches the user', () => {
    const req = { headers: { authorization: `Bearer ${adminToken}` } };
    expect(runMiddleware(authenticate, req)).toBeUndefined();
    expect(req.user.username).toBe('admin');
    expect(req.user.role).toBe('admin');
    expect(req.user.permissions).toContain('replay:control');
  });

  test('rejects a missing header', () => {
    const err = runMiddleware(authenticate, { headers: {} });
    expect(err.status).toBe(401);
    expect(err.code).toBe('UNAUTHENTICATED');
  });

  test('rejects a token without the Bearer scheme', () => {
    const err = runMiddleware(authenticate, { headers: { authorization: adminToken } });
    expect(err.status).toBe(401);
  });

  test('rejects an expired token', () => {
    const expired = jwt.sign({ sub: 'admin', role: 'admin', exp: Math.floor(Date.now() / 1000) - 60 }, config.jwtSecret);
    const err = runMiddleware(authenticate, { headers: { authorization: `Bearer ${expired}` } });
    expect(err.code).toBe('TOKEN_EXPIRED');
  });

  test('rejects a token signed with a different secret (forged)', () => {
    const forged = jwt.sign({ sub: 'admin', role: 'admin' }, 'not-the-real-secret');
    const err = runMiddleware(authenticate, { headers: { authorization: `Bearer ${forged}` } });
    expect(err.code).toBe('INVALID_TOKEN');
  });

  test('rejects an unsigned "alg: none" token', () => {
    const unsigned = jwt.sign({ sub: 'admin', role: 'admin' }, null, { algorithm: 'none' });
    const err = runMiddleware(authenticate, { headers: { authorization: `Bearer ${unsigned}` } });
    expect(err.code).toBe('INVALID_TOKEN');
  });

  test('ignores a role claim that does not match the user list', () => {
    // A viewer's valid token edited to say "admin" would fail the signature
    // check; here we sign a mismatching claim legitimately and check the
    // server still uses the stored role.
    const token = jwt.sign({ sub: 'viewer', role: 'admin' }, config.jwtSecret, { algorithm: 'HS256' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    runMiddleware(authenticate, req);
    expect(req.user.role).toBe('viewer');
  });

  test('rejects a token for a user that does not exist', () => {
    const ghost = jwt.sign({ sub: 'ghost', role: 'admin' }, config.jwtSecret, { algorithm: 'HS256' });
    const err = runMiddleware(authenticate, { headers: { authorization: `Bearer ${ghost}` } });
    expect(err.status).toBe(401);
  });
});

describe('login endpoint', () => {
  const app = createApp(createState(config));

  test('correct credentials return a token and the role permissions', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'analyst', password: 'analyst123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toEqual({
      username: 'analyst',
      name: 'FinOps Analyst',
      role: 'analyst',
      permissions: permissionsFor('analyst'),
    });
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  test('username is case-insensitive', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'Admin', password: 'admin123' });
    expect(res.status).toBe(200);
  });

  test('wrong password and unknown user get the same 401 message', async () => {
    const wrongPw = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'nope' });
    const noUser = await request(app).post('/api/auth/login').send({ username: 'mallory', password: 'nope' });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body).toEqual(noUser.body);
  });

  test('missing fields give 400, malformed JSON gives 400', async () => {
    const missing = await request(app).post('/api/auth/login').send({ username: 'admin' });
    expect(missing.status).toBe(400);
    const badJson = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{not json');
    expect(badJson.status).toBe(400);
    expect(badJson.body.error.code).toBe('BAD_JSON');
  });

  test('GET /api/auth/me returns the logged-in user', async () => {
    const token = await loginAs(app, 'viewer');
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('viewer');
  });
});

describe('RBAC matrix enforced on the backend', () => {
  const app = createApp(createState(config));
  const tokens = {};

  beforeAll(async () => {
    for (const role of ['admin', 'analyst', 'viewer']) tokens[role] = await loginAs(app, role);
  });

  // [endpoint, admin, analyst, viewer]
  const MATRIX = [
    ['/api/health/summary', 200, 200, 200],
    ['/api/data-quality', 200, 200, 200],
    ['/api/reports', 200, 200, 403],
    ['/api/reports/orphaned', 200, 200, 403],
    ['/api/reports/RPT_200', 200, 200, 403],
    ['/api/costs/allocation', 200, 200, 403],
    ['/api/users', 200, 403, 403],
    ['/api/alerts', 200, 200, 200],
    ['/api/alerts/active', 200, 200, 200],
    ['/api/alerts/stats', 200, 200, 200],
    ['/api/replay/status', 200, 200, 200],
  ];

  describe.each(MATRIX)('GET %s', (endpoint, adminStatus, analystStatus, viewerStatus) => {
    test.each([
      ['admin', adminStatus],
      ['analyst', analystStatus],
      ['viewer', viewerStatus],
    ])('as %s -> %i', async (role, expected) => {
      const res = await request(app).get(endpoint).set('Authorization', `Bearer ${tokens[role]}`);
      expect(res.status).toBe(expected);
      if (expected === 403) expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('without a token -> 401', async () => {
      const res = await request(app).get(endpoint);
      expect(res.status).toBe(401);
    });
  });

  test('health summary hides cost figures from viewers (field-level RBAC)', async () => {
    const asViewer = await request(app).get('/api/health/summary').set('Authorization', `Bearer ${tokens.viewer}`);
    const asAnalyst = await request(app).get('/api/health/summary').set('Authorization', `Bearer ${tokens.analyst}`);
    expect(asViewer.body).not.toHaveProperty('cost');
    expect(asAnalyst.body.cost.total_cost_usd).toBeGreaterThan(0);
  });

  test.each([
    ['admin', 200],
    ['analyst', 403],
    ['viewer', 403],
  ])('only admin can control the replay: POST /api/replay/* as %s -> %i', async (role, expected) => {
    const auth = { Authorization: `Bearer ${tokens[role]}` };
    for (const action of ['start', 'pause', 'reset']) {
      const res = await request(app).post(`/api/replay/${action}`).set(auth).send({});
      expect(res.status).toBe(expected);
    }
  });

  test('liveness probe stays public', async () => {
    expect((await request(app).get('/api/health/live')).status).toBe(200);
  });
});
