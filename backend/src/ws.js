/**
 * ws.js
 * WebSocket endpoint for real-time alerts:  ws://<host>/ws/alerts?token=<JWT>
 *
 * A WebSocket starts life as a normal HTTP request asking to "upgrade" the
 * connection. We check the login token during that handshake, so an
 * unauthenticated client is rejected before a socket is ever opened.
 * (Browsers cannot add an Authorization header to a WebSocket, which is why
 * the token travels in the query string.)
 *
 * After connecting, the client receives:
 *   1. one WELCOME message with the current state (active alerts, recent history)
 *   2. a live stream of TELEMETRY, alert and REPLAY_STATE messages
 */
const { WebSocketServer, WebSocket } = require('ws');
const { userFromToken } = require('./auth');
const { hasPermission } = require('./permissions');

const WS_PATH = '/ws/alerts';
const HEARTBEAT_MS = 30000;

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}\n`);
  socket.destroy();
}

function attachAlertSocket(server, state) {
  // noServer: we handle the HTTP upgrade ourselves so we can authenticate first.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== WS_PATH) return rejectUpgrade(socket, 404, 'Not Found');

    let user;
    try {
      user = userFromToken(url.searchParams.get('token'));
    } catch (err) {
      return rejectUpgrade(socket, 401, 'Unauthorized');
    }
    if (!hasPermission(user.role, 'alerts:read')) return rejectUpgrade(socket, 403, 'Forbidden');

    return wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {}); // a broken client must not crash the server

    send(ws, {
      kind: 'system',
      type: 'WELCOME',
      ts: new Date().toISOString(),
      user: { username: ws.user.username, role: ws.user.role },
      replay: state.replay ? state.replay.getStatus() : null,
      active_alerts: state.alertEngine ? state.alertEngine.getActive() : [],
      recent_alerts: state.alertEngine ? state.alertEngine.getHistory({ limit: 50 }) : [],
    });
  });

  // Heartbeat: ping every client; drop the ones that stopped answering
  // (closed laptop lid, lost Wi-Fi) so we don't keep sending into the void.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  /** Send a message to every connected client. */
  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  return { wss, broadcast, close, clientCount: () => wss.clients.size };
}

module.exports = { attachAlertSocket, WS_PATH };
