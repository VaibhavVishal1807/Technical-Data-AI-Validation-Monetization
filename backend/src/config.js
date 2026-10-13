/**
 * config.js
 * One place for every tunable setting. Values come from environment variables
 * (backend/.env, see .env.example) and fall back to safe defaults, so the app
 * runs straight after `git clone` with no setup.
 */
const path = require('path');
const crypto = require('crypto');

// quiet: true stops dotenv from printing a banner on every start.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Config error: ${name} must be a number, got "${raw}"`);
  }
  return value;
}

function readBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

// If no JWT secret is configured we generate a random one for this process.
// That keeps a fresh clone working without ever committing a real secret;
// the only side effect is that logins do not survive a server restart.
let jwtSecret = process.env.JWT_SECRET;
const jwtSecretGenerated = !jwtSecret;
if (!jwtSecret) {
  jwtSecret = crypto.randomBytes(32).toString('hex');
}

const config = {
  // API_PORT rather than the generic PORT: dev tools often set PORT for the
  // frontend dev server, and the API must not grab the same port.
  port: readNumber('API_PORT', 4000),
  // 127.0.0.1 = only reachable from this machine (safe default for a demo).
  host: process.env.HOST || '127.0.0.1',

  dataPath: process.env.DATA_PATH
    ? path.resolve(process.env.DATA_PATH)
    : path.join(__dirname, '..', '..', 'data', 'Case_Study_3_Pure_Insights_Monitoring.csv'),

  // The CSV has no dates. Snapshots are mapped to monthly periods ending here.
  latestPeriod: process.env.LATEST_PERIOD || '2026-09',

  jwtSecret,
  jwtSecretGenerated,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',

  // Assumed Snowflake price per credit (USD). Real price depends on edition/region.
  creditPriceUsd: readNumber('CREDIT_PRICE_USD', 3),

  // Alert thresholds from the brief: >15 s is a breach, >30 s is critical.
  latencyWarningSec: readNumber('LATENCY_WARNING_SEC', 15),
  latencyCriticalSec: readNumber('LATENCY_CRITICAL_SEC', 30),

  // After an alert notification for a report, the same alert type for that
  // report stays quiet for this many of its next snapshots (anti-flapping).
  alertCooldownSnapshots: readNumber('ALERT_COOLDOWN_SNAPSHOTS', 3),

  // Telemetry replay: one CSV row is "received" every N milliseconds.
  replayIntervalMs: readNumber('REPLAY_INTERVAL_MS', 500),
  replayAutostart: readBoolean('REPLAY_AUTOSTART', true),
  replayLoop: readBoolean('REPLAY_LOOP', true),
};

module.exports = config;
