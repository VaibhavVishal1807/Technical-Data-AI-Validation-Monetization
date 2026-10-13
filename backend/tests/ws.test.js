/**
 * End-to-end WebSocket tests: a real HTTP server on a random free port, a real
 * WebSocket client, and the real replay feeding alerts through.
 */
const http = require('http');
const { WebSocket } = require('ws');
const config = require('../src/config');
const { createState } = require('../src/state');
const { createApp } = require('../src/app');
const { attachAlertSocket } = require('../src/ws');
const { loginAs } = require('./helpers');

let server;
let socketHub;
let state;
let baseUrl;
let viewerToken;

beforeAll(async () => {
  state = createState(config);
  const app = createApp(state);
  server = http.createServer(app);
  socketHub = attachAlertSocket(server, state);
  state.replay.on('message', socketHub.broadcast);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); // port 0 = any free port
  baseUrl = `ws://127.0.0.1:${server.address().port}`;
  viewerToken = await loginAs(app, 'viewer');
});

afterAll(async () => {
  state.replay.stop();
  socketHub.close();
  await new Promise((resolve) => server.close(resolve));
});

/** Try to connect; resolve with the HTTP status if the server refuses. */
function expectRejected(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.on('open', () => { ws.close(); reject(new Error('connection should have been refused')); });
    ws.on('error', () => {});
  });
}

/** Connect and collect messages; resolves once the socket is open. */
function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}/ws/alerts?token=${token}`);
    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

async function waitFor(check, timeoutMs = 3000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('connection without a token is refused with 401', async () => {
  expect(await expectRejected(`${baseUrl}/ws/alerts`)).toBe(401);
});

test('connection with a forged token is refused with 401', async () => {
  expect(await expectRejected(`${baseUrl}/ws/alerts?token=abc.def.ghi`)).toBe(401);
});

test('unknown WebSocket path is refused with 404', async () => {
  expect(await expectRejected(`${baseUrl}/ws/other?token=${viewerToken}`)).toBe(404);
});

test('a logged-in viewer gets a WELCOME message, then live telemetry and alerts', async () => {
  const { ws, messages } = await connect(viewerToken);
  await waitFor(() => messages.length >= 1);
  expect(messages[0]).toMatchObject({ kind: 'system', type: 'WELCOME', user: { username: 'viewer', role: 'viewer' } });
  expect(Array.isArray(messages[0].active_alerts)).toBe(true);

  // Play the first 100 rows (one per report). Many breach 15 s, so alerts must arrive.
  for (let i = 0; i < 100; i += 1) state.replay.step();
  await waitFor(() => messages.filter((m) => m.kind === 'telemetry').length === 100);
  const alerts = messages.filter((m) => m.kind === 'alert');
  expect(alerts.length).toBeGreaterThan(0);
  for (const a of alerts) {
    expect(a).toEqual(expect.objectContaining({
      type: expect.stringMatching(/LATENCY_BREACH|REFRESH_FAILURE|MONITORING_GAP|RECOVERED/),
      severity: expect.stringMatching(/INFO|WARNING|CRITICAL/),
      report_id: expect.stringMatching(/^RPT_\d+$/),
      metric: expect.any(String),
      ts: expect.any(String),
    }));
    expect(a).toHaveProperty('value');
    expect(a).toHaveProperty('threshold');
  }
  ws.close();
});

test('every connected client receives the same broadcast', async () => {
  const a = await connect(viewerToken);
  const b = await connect(viewerToken);
  state.replay.step();
  await waitFor(() => a.messages.some((m) => m.kind === 'telemetry') && b.messages.some((m) => m.kind === 'telemetry'));
  a.ws.close();
  b.ws.close();
});
