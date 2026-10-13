/**
 * Shared test helpers: build the app once and log in as a demo user.
 */
const request = require('supertest');

const PASSWORDS = { admin: 'admin123', analyst: 'analyst123', viewer: 'viewer123' };

/** Log in through the real endpoint and return the JWT. */
async function loginAs(app, username) {
  const res = await request(app).post('/api/auth/login').send({ username, password: PASSWORDS[username] });
  if (res.status !== 200) throw new Error(`login as ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

module.exports = { loginAs, PASSWORDS };
