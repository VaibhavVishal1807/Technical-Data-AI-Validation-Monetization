# Pure Insights Command Center: REST API and WebSocket Specification

Version 1.0 · Backend: Node.js 20+ / Express 5 / `ws` 8 · Source: `backend/src`

This document is the contract between the backend and any client (the React dashboard, scripts,
other services). All example payloads were produced by the running code against the case-study
dataset.

---

## 1. Conventions

| Item | Value |
|---|---|
| Base URL (dev) | `http://127.0.0.1:4000/api` directly, or `http://localhost:5173/api` through the Vite dev proxy |
| WebSocket URL (dev) | `ws://127.0.0.1:4000/ws/alerts?token=<JWT>` (or `ws://localhost:5173/ws/alerts?token=<JWT>`) |
| Format | JSON (UTF-8) for requests and responses |
| Field names | `snake_case` |
| Timestamps | ISO 8601 UTC, e.g. `2026-10-12T19:46:26.198Z` |
| Periods | `YYYY-MM`. The CSV has no dates; snapshot *k* of a report is mapped to month *k* (2025-02 … 2026-09) |
| Money | USD, rounded to cents (per-view values to 4 decimals) |
| Missing / undefined values | `null`, never `NaN` or `Infinity` (e.g. cost per view when views = 0) |
| Authentication | `Authorization: Bearer <JWT>` on every endpoint except login and the liveness probe |

### Error format

Every error has the same shape:

```json
{ "error": { "code": "FORBIDDEN", "message": "Role \"analyst\" does not have permission \"users:read\"" } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `BAD_REQUEST`, `BAD_QUERY`, `BAD_JSON` | Missing or invalid body/query values, malformed JSON |
| 401 | `UNAUTHENTICATED` | No `Authorization: Bearer` header |
| 401 | `INVALID_TOKEN` | Bad signature, wrong algorithm, unknown user |
| 401 | `TOKEN_EXPIRED` | Token older than `JWT_EXPIRES_IN` (default 8h) |
| 401 | `INVALID_CREDENTIALS` | Wrong username or password (same message for both) |
| 403 | `FORBIDDEN` | Valid user whose role lacks the permission |
| 404 | `NOT_FOUND` | Unknown report id or unknown `/api` path |
| 500 | `INTERNAL_ERROR` | Unexpected server error (details are logged, not returned) |

---

## 2. Authentication and role-based access control

### Flow
1. `POST /api/auth/login` with username and password. The server checks the bcrypt hash and returns a JWT (HS256, 8h).
2. Send the token on every request: `Authorization: Bearer <token>`. For the WebSocket, use `?token=<token>`.
3. On each request the server verifies the signature (algorithm pinned to HS256), then **re-reads the
   role from the user store**, so a removed user or changed role takes effect at once.

### Roles and permissions

Access is checked **on the server** for every route. The UI hides pages as a convenience only.

| Permission | admin | analyst | viewer | Grants |
|---|:-:|:-:|:-:|---|
| `health:read` | ✅ | ✅ | ✅ | `GET /api/health/summary` |
| `alerts:read` | ✅ | ✅ | ✅ | `GET /api/alerts*`, `GET /api/replay/status`, WebSocket `/ws/alerts` |
| `dataquality:read` | ✅ | ✅ | ✅ | `GET /api/data-quality` |
| `reports:read` | ✅ | ✅ | ❌ | `GET /api/reports*` |
| `costs:read` | ✅ | ✅ | ❌ | `GET /api/costs/allocation`, and the `cost` block in the health summary |
| `replay:control` | ✅ | ❌ | ❌ | `POST /api/replay/start`, `/pause`, `/reset` |
| `users:read` | ✅ | ❌ | ❌ | `GET /api/users` |

Built-in accounts: `admin / admin123`, `analyst / analyst123`, `viewer / viewer123`.

---

## 3. REST endpoints

### Summary

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/health/live` | public | Liveness probe |
| POST | `/api/auth/login` | public | Exchange credentials for a JWT |
| GET | `/api/auth/me` | any logged-in user | Current user and permissions |
| GET | `/api/health/summary` | `health:read` | Platform health KPIs |
| GET | `/api/reports` | `reports:read` | All reports with latest snapshot (filterable) |
| GET | `/api/reports/orphaned` | `reports:read` | Reports with no valid owner now |
| GET | `/api/reports/:id` | `reports:read` | One report: summary, cost, 20-month history |
| GET | `/api/costs/allocation` | `costs:read` | Cost per report, cost per active view, waste flag |
| GET | `/api/data-quality` | `dataquality:read` | Every data check: count, detection, handling, rationale |
| GET | `/api/alerts` | `alerts:read` | Alert history (newest first) |
| GET | `/api/alerts/active` | `alerts:read` | Alerts open right now |
| GET | `/api/alerts/stats` | `alerts:read` | Live counters and full-file noise simulation |
| GET | `/api/replay/status` | `alerts:read` | Telemetry replay state |
| POST | `/api/replay/start` | `replay:control` | Start or resume the replay, optionally at a new speed |
| POST | `/api/replay/pause` | `replay:control` | Pause the replay |
| POST | `/api/replay/reset` | `replay:control` | Rewind, clear alert state and history |
| GET | `/api/users` | `users:read` | Users, roles and permissions |

---

### `GET /api/health/live`
Public. For load balancers and uptime checks.

```json
{ "status": "ok", "uptime_sec": 7 }
```

### `POST /api/auth/login`
Request:
```json
{ "username": "analyst", "password": "analyst123" }
```
Response `200`:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": "8h",
  "user": {
    "username": "analyst",
    "name": "FinOps Analyst",
    "role": "analyst",
    "permissions": ["health:read", "alerts:read", "dataquality:read", "reports:read", "costs:read"]
  }
}
```
Errors: `400 BAD_REQUEST` (missing or over-long fields), `401 INVALID_CREDENTIALS`. Usernames are
case-insensitive. An unknown user and a wrong password give the identical response, and both take
the same time (a dummy bcrypt comparison runs), so valid usernames cannot be discovered.

### `GET /api/auth/me`
```json
{ "user": { "username": "viewer", "name": "Ops Viewer", "role": "viewer", "permissions": ["health:read", "alerts:read", "dataquality:read"] } }
```

### `GET /api/health/summary`
Current platform health from each report's **latest** snapshot, plus live alert and replay state.
The `cost` block is **only included for roles with `costs:read`** (field-level access control).

```json
{
  "generated_at": "2026-10-12T19:46:26.299Z",
  "as_of_period": "2026-09",
  "reports_total": 100,
  "refresh": {
    "counts": { "SUCCESS": 70, "FAILED": 16, "TIMED_OUT": 9, "UNKNOWN": 5 },
    "failing": 25, "failing_pct": 25, "unknown": 5, "unknown_pct": 5
  },
  "latency": {
    "warning_threshold_sec": 15, "critical_threshold_sec": 30,
    "bands": { "OK": 24, "WARNING": 33, "CRITICAL": 43 },
    "breaching": 76, "breaching_pct": 76, "avg_load_time_sec": 26.3, "max_load_time_sec": 54.5
  },
  "ownership": { "orphaned_reports": 14, "orphaned_pct": 14 },
  "history": { "snapshots": 2000, "latency_breach_pct": 74.5, "refresh_failure_pct": 28.2 },
  "alerts": {
    "active_total": 113,
    "by_severity": { "CRITICAL": 77, "WARNING": 36 },
    "by_type": { "LATENCY_BREACH": 75, "REFRESH_FAILURE": 35, "MONITORING_GAP": 3 }
  },
  "replay": { "state": "running", "position": 150, "total": 2000, "progress_pct": 7.5, "interval_ms": 500, "loop": true, "cycle": 1, "current_period": "2025-03", "started_at": "2026-10-12T19:45:51.000Z" },
  "cost": {
    "total_cost_usd": 4081006.69, "total_snowflake_cost_usd": 3619057.44, "total_aws_hosting_cost_usd": 461949.25,
    "overall_cost_per_view_usd": 2.7147, "waste_report_count": 25, "period_range": "2025-02 to 2026-09"
  }
}
```

### `GET /api/reports`
All reports with their latest snapshot and history statistics.

| Query param | Values | Effect |
|---|---|---|
| `status` | `SUCCESS`, `FAILED`, `TIMED_OUT`, `UNKNOWN` (any case) | Latest refresh status |
| `band` | `OK`, `WARNING`, `CRITICAL` | Latest latency band |
| `orphaned` | `true`, `false` | Orphaned now or not |
| `q` | text | Substring of id, name or canonical owner |

Invalid values return `400 BAD_QUERY`. Response (one report shown):

```json
{
  "as_of_period": "2026-09",
  "count": 100,
  "reports": [{
    "report_id": "RPT_200", "report_name": "Analytics Dashboard 1", "snapshot_count": 20,
    "latest_period": "2026-09", "latest_refresh_status": "SUCCESS",
    "latest_load_time_sec": 17.9, "latest_latency_band": "WARNING",
    "latest_monthly_active_views": 1180, "latest_credits_consumed": 455.63,
    "latest_aws_hosting_cost_usd": 26.84, "latest_concurrent_user_peak": 106,
    "latest_anomaly_flags": ["LATENCY_BREACH_WARNING"],
    "latest_owner_email": "user_2@company.com", "latest_owner_status": "VALID", "is_orphaned": false,
    "canonical_owner_email": "user_2@company.com", "canonical_owner_period": "2026-09", "periods_since_valid_owner": 0,
    "distinct_owner_count": 10, "owner_change_count": 16, "ownerless_snapshot_count": 2,
    "failed_refresh_count": 2, "timed_out_refresh_count": 0, "unknown_refresh_count": 1,
    "avg_load_time_sec": 30.8, "max_load_time_sec": 49.7, "latency_breach_rate": 0.75,
    "report_flags": ["OWNERSHIP_UNSTABLE"]
  }]
}
```

Field notes:
- `latest_owner_status`: `VALID`, `MISSING` (empty or `nan`), `ORPHANED` (the `ORPHANED_REPORT` placeholder) or `INVALID` (not an email).
- `canonical_owner_email`: most recent valid owner in the history. For an orphaned report, this is the suggested contact.
- `report_flags`: `ORPHANED`, `OWNERSHIP_UNSTABLE` (more than one distinct owner), `NEVER_OWNED`, `REPORT_NAME_CONFLICT`.

### `GET /api/reports/orphaned`
Reports whose **latest** snapshot has no valid owner, most expensive first.

```json
{
  "as_of_period": "2026-09",
  "count": 14,
  "total_cost_usd": 587371.59,
  "reports": [{
    "report_id": "RPT_232", "report_name": "Analytics Dashboard 33",
    "latest_owner_status": "MISSING", "orphan_reason": "MISSING",
    "suggested_contact": "user_4@company.com", "canonical_owner_period": "2026-08", "periods_since_valid_owner": 1,
    "latest_refresh_status": "SUCCESS", "latest_load_time_sec": 54.2, "latest_latency_band": "CRITICAL",
    "total_cost_usd": 48162.18, "waste_flag": false,
    "…": "plus every field from GET /api/reports"
  }]
}
```

### `GET /api/reports/:id`
`:id` is case-insensitive (`rpt_200` works). Unknown id gives `404 NOT_FOUND`.

```json
{
  "report": { "…": "same shape as one item of GET /api/reports" },
  "cost": { "…": "same shape as one item of GET /api/costs/allocation" },
  "history": [{
    "snapshot_id": 1, "snapshot_seq": 1, "period": "2025-02", "snapshot_ts": "2025-02-01T00:00:00.000Z",
    "report_id": "RPT_200", "report_name": "Analytics Dashboard 1",
    "owner_email_raw": "user_7@company.com", "owner_email": "user_7@company.com", "owner_status": "VALID",
    "last_refresh_status": "SUCCESS", "monthly_active_views": 186,
    "snowflake_credits_consumed": 857.88, "billable_credits": 857.88,
    "avg_load_time_sec": 44.8, "latency_band": "CRITICAL",
    "aws_hosting_cost_usd": 75.51, "aws_cost_per_view": 0.406,
    "query_count_last_30d": 12825, "concurrent_user_peak": 142,
    "anomaly_flags": ["LATENCY_BREACH_CRITICAL"], "validation_issues": []
  }]
}
```
`history` has 20 snapshots, oldest first. `billable_credits` is `null` when the raw credits are
negative (excluded from cost). `aws_cost_per_view` is `null` when views are 0.

### `GET /api/costs/allocation`
Cost attribution per report over all 20 months. Same logic as `sql/03_cost_allocation.sql`
(a test proves they agree).

| Query param | Values | Effect |
|---|---|---|
| `waste` | `true` | Only reports with `waste_flag = true` |

```json
{
  "method": {
    "billable_credits": "SUM(snowflake_credits_consumed) WHERE credits >= 0 (negative rows excluded)",
    "cost_per_view": "cost / NULLIF(SUM(monthly_active_views), 0)",
    "snowflake_cost_usd": "billable_credits x $3 per credit (assumed)",
    "total_cost_usd": "snowflake_cost_usd + SUM(aws_hosting_cost_usd)",
    "waste_flag": "total_cost_per_view_usd >= 75th percentile across reports",
    "sql": "sql/03_cost_allocation.sql"
  },
  "summary": {
    "credit_price_usd": 3, "report_count": 100, "period_count": 20, "first_period": "2025-02", "last_period": "2026-09",
    "total_billable_credits": 1206352.48, "excluded_negative_credits": -161.04, "excluded_rows": 24,
    "total_snowflake_cost_usd": 3619057.44, "total_aws_hosting_cost_usd": 461949.25, "total_cost_usd": 4081006.69,
    "total_views": 1503281, "overall_cost_per_view_usd": 2.7147,
    "waste_threshold_cost_per_view_usd": 2.9429, "waste_report_count": 25, "waste_cost_usd": 1119928.95,
    "zero_usage_periods": 4, "zero_usage_cost_usd": 6959.11
  },
  "count": 100,
  "reports": [{
    "report_id": "RPT_223", "report_name": "Analytics Dashboard 24", "owner_email": "user_13@company.com", "is_orphaned": false,
    "periods": 20, "billable_credits": 17034.76, "excluded_negative_credits": 0, "excluded_rows": 0,
    "total_views": 11259, "total_queries": 220998,
    "snowflake_cost_usd": 51104.28, "aws_hosting_cost_usd": 5116.68, "total_cost_usd": 56220.96,
    "credits_per_view": 1.513, "snowflake_cost_per_view_usd": 4.539, "aws_cost_per_view_usd": 0.4545,
    "total_cost_per_view_usd": 4.9934,
    "zero_usage_periods": 1, "zero_usage_cost_usd": 2666.75,
    "waste_flag": true, "cost_per_view_rank": 1
  }],
  "by_period": [{
    "period": "2025-02", "billable_credits": 54674.26, "snowflake_cost_usd": 164022.78,
    "aws_hosting_cost_usd": 24762.88, "total_cost_usd": 188785.66, "total_views": 78478,
    "total_cost_per_view_usd": 2.4056, "excluded_rows": 1
  }]
}
```
Reports are sorted by `total_cost_per_view_usd` descending; reports with no views (`null`) come last.

### `GET /api/data-quality`
Every data check, computed from the data at startup. See `docs/DATA_QUALITY.md` for the full list.

```json
{
  "generated_at": "2026-10-12T19:46:26.170Z",
  "source_file": "Case_Study_3_Pure_Insights_Monitoring.csv",
  "summary": {
    "rows_total": 2000, "rows_dropped": 0, "rows_with_any_flag": 1743, "rows_excluded_from_cost_totals": 24,
    "reports_total": 100, "checks_run": 20, "checks_with_findings": 14,
    "schema": { "columns": ["report_id", "…"], "missing": [], "extra": [] }
  },
  "flag_counts": { "LATENCY_BREACH_CRITICAL": 910, "LATENCY_BREACH_WARNING": 580, "MISSING_OWNER": 128, "…": "…" },
  "refresh_status_counts": { "SUCCESS": 1336, "TIMED_OUT": 182, "FAILED": 382, "UNKNOWN": 100 },
  "owner_status_counts": { "VALID": 1755, "MISSING": 128, "ORPHANED": 117 },
  "column_profile": [{ "column": "monthly_active_views", "min": 0, "max": 1499, "mean": 751.64, "missing": 0 }],
  "checks": [{
    "id": "MISSING_OWNER", "title": "Owner email missing (NaN)", "category": "Ownership",
    "origin": "BRIEF", "level": "row", "count": 128, "total": 2000, "pct": 6.4, "status": "FOUND",
    "detection": "owner_email is empty or a null token (\"nan\", \"null\", \"none\", \"n/a\").",
    "handling": "Row kept. owner_email set to null, owner_status = MISSING, flag added.",
    "rationale": "Missing ownership is exactly what the admin dashboard must surface, so these rows are signal, not noise.",
    "examples": ["RPT_203", "RPT_211", "RPT_218", "RPT_222", "RPT_227"],
    "details": {}
  }]
}
```
`origin`: `BRIEF` (injected anomaly named in the brief), `DISCOVERED` (found while profiling),
`INTEGRITY` (routine check). `level`: `row`, `report` or `dataset`.

### `GET /api/alerts`
Alert history, newest first. Only **notified** alerts by default.

| Query param | Values | Default |
|---|---|---|
| `limit` | 1–1000 | 100 |
| `severity` | `INFO`, `WARNING`, `CRITICAL` | all |
| `type` | `LATENCY_BREACH`, `REFRESH_FAILURE`, `MONITORING_GAP`, `RECOVERED` | all |
| `report_id` | e.g. `RPT_249` | all |
| `include_suppressed` | `true` to include alerts held back by the cooldown | `false` |

```json
{
  "count": 2,
  "alerts": [{
    "id": "evt_000161", "type": "RECOVERED", "severity": "INFO",
    "report_id": "RPT_249", "report_name": "Analytics Dashboard 50",
    "metric": "avg_load_time_sec", "value": 10.7, "threshold": 15,
    "ts": "2026-10-12T19:46:26.198Z", "snapshot_ts": "2025-03-01T00:00:00.000Z", "period": "2025-03", "snapshot_id": 150,
    "previous_state": "CRITICAL", "message": "Load time recovered to 10.7s (at or below 15s)",
    "notified": true, "suppressed_reason": null,
    "resolves": "evt_000054", "resolved_type": "LATENCY_BREACH"
  }]
}
```
The alert object is defined in [§4.3](#43-alert-object).

### `GET /api/alerts/active`
Every alert open right now, most severe first, **including alerts whose notification is held back
by the cooldown**, so this list always matches reality (a test checks it equals the set of reports
currently breaching or failing).

```json
{
  "summary": { "active_total": 113, "by_severity": { "CRITICAL": 77, "WARNING": 36 }, "by_type": { "LATENCY_BREACH": 75, "REFRESH_FAILURE": 35, "MONITORING_GAP": 3 } },
  "count": 113,
  "alerts": [{
    "alert_id": "evt_000001", "type": "LATENCY_BREACH", "severity": "CRITICAL",
    "report_id": "RPT_200", "report_name": "Analytics Dashboard 1",
    "metric": "avg_load_time_sec", "value": 28.2, "threshold": 30,
    "opened_at": "2026-10-12T19:46:26.188Z", "opened_period": "2025-02", "last_period": "2025-03",
    "notified": true
  }]
}
```
`value` is the latest reading. `severity` is the highest reached while the alert has been open
(severity only goes up until the alert closes).

### `GET /api/alerts/stats`
`live`: counters since the replay started. `full_dataset_simulation`: the alert rules run over
the whole file at startup, compared with "one alert per bad row".

```json
{
  "live": {
    "snapshots_processed": 150, "naive_alert_count": 168, "events_total": 162, "notifications_sent": 162,
    "suppressed_total": 0, "suppressed_by_reason": {}, "delayed_notifications": 0,
    "by_type": { "LATENCY_BREACH": 90, "REFRESH_FAILURE": 45, "MONITORING_GAP": 5, "RECOVERED": 22 },
    "by_severity": { "CRITICAL": 93, "WARNING": 47, "INFO": 22 },
    "actionable_notifications": 140, "noise_reduction_pct": 3.6, "actionable_reduction_pct": 16.7,
    "cooldown_snapshots": 3, "thresholds": { "warning_sec": 15, "critical_sec": 30 }
  },
  "full_dataset_simulation": {
    "snapshots": 2000,
    "naive_per_row_alerts": 2154,
    "state_change_only_notifications": 1817,
    "state_change_with_cooldown_notifications": 1526,
    "state_change_only_actionable": 1025,
    "actionable_notifications": 860,
    "actionable_reduction_pct": 60.1,
    "noise_reduction_pct": 29.2,
    "suppressed": { "COOLDOWN": 233, "PARENT_NOT_NOTIFIED": 126 },
    "delayed_notifications": 68,
    "by_type": { "LATENCY_BREACH": 465, "REFRESH_FAILURE": 330, "MONITORING_GAP": 65, "RECOVERED": 666 },
    "by_severity": { "CRITICAL": 654, "WARNING": 206, "INFO": 666 },
    "cooldown_snapshots": 3
  }
}
```
"Actionable" means WARNING or CRITICAL; RECOVERED messages are INFO.

### `GET /api/replay/status`
```json
{ "state": "running", "position": 150, "total": 2000, "progress_pct": 7.5, "interval_ms": 500, "loop": true, "cycle": 1, "current_period": "2025-03", "started_at": "2026-10-12T19:45:51.000Z" }
```
`state`: `idle`, `running`, `paused` or `finished` (only when `loop` is off).

### `POST /api/replay/start` · `POST /api/replay/pause` · `POST /api/replay/reset`
Admin only (`replay:control`). Each returns the replay status (as above) and broadcasts a
`REPLAY_STATE` WebSocket message to all clients.

- `start` body (optional): `{ "interval_ms": 200 }`, between 20 and 60000, otherwise `400 BAD_REQUEST`.
  Starting while running applies the new speed.
- `reset`: stops, rewinds to the first row and clears alert state **and** history.

### `GET /api/users`
Admin only.
```json
{
  "count": 3,
  "users": [
    { "username": "admin", "name": "Platform Admin", "role": "admin", "permissions": ["health:read", "alerts:read", "dataquality:read", "reports:read", "costs:read", "replay:control", "users:read"] },
    { "username": "analyst", "name": "FinOps Analyst", "role": "analyst", "permissions": ["…"] },
    { "username": "viewer", "name": "Ops Viewer", "role": "viewer", "permissions": ["…"] }
  ]
}
```

---

## 4. WebSocket: real-time alerts

### 4.1 Connecting

```
ws://<host>:<port>/ws/alerts?token=<JWT>
```

- The token is checked **during the HTTP upgrade handshake**, before a socket is opened.
  Browsers cannot send an `Authorization` header on a WebSocket, which is why it is a query parameter.
  - No or invalid token → HTTP `401 Unauthorized`, connection refused
  - Role without `alerts:read` → HTTP `403 Forbidden`
  - Any other path → HTTP `404 Not Found`
- The server sends a ping every 30 s and closes connections that don't answer with a pong.
- Clients should reconnect with exponential backoff (the dashboard uses 1 s, 2 s, 4 s … up to 10 s).
- Communication is **server → client**. Messages sent by the client are ignored.

### 4.2 Message envelope

Every message is one JSON object with a `kind` and a `type`:

| `kind` | `type` | When |
|---|---|---|
| `system` | `WELCOME` | Once, right after connecting |
| `telemetry` | `TELEMETRY` | Every replayed snapshot (every `REPLAY_INTERVAL_MS`, default 500 ms) |
| `alert` | `LATENCY_BREACH`, `REFRESH_FAILURE`, `MONITORING_GAP`, `RECOVERED` | Whenever the alert engine sends a notification |
| `system` | `REPLAY_STATE` | Replay started, paused, reset, looped or finished |

#### `WELCOME`
```json
{
  "kind": "system", "type": "WELCOME", "ts": "2026-10-12T19:22:31.400Z",
  "user": { "username": "viewer", "role": "viewer" },
  "replay": { "state": "running", "position": 104, "total": 2000, "…": "…" },
  "active_alerts": [ { "…": "same shape as GET /api/alerts/active items" } ],
  "recent_alerts": [ { "…": "last 50 notified alerts, newest first" } ]
}
```

#### `TELEMETRY`
```json
{
  "kind": "telemetry", "type": "TELEMETRY", "ts": "2026-10-12T19:22:32.961Z",
  "snapshot_id": 237, "report_id": "RPT_236", "period": "2025-03",
  "avg_load_time_sec": 23.6, "latency_band": "WARNING", "last_refresh_status": "SUCCESS",
  "monthly_active_views": 1178, "position": 237, "total": 2000,
  "active_summary": { "active_total": 111, "by_severity": { "CRITICAL": 72, "WARNING": 39 }, "by_type": { "…": "…" } }
}
```

#### Alert messages
The alert object ([§4.3](#43-alert-object)) is sent **flat**, with `kind: "alert"` added:

```json
{
  "kind": "alert",
  "id": "evt_000013", "type": "LATENCY_BREACH", "severity": "CRITICAL",
  "report_id": "RPT_210", "report_name": "Analytics Dashboard 11",
  "metric": "avg_load_time_sec", "value": 45.4, "threshold": 30,
  "ts": "2026-10-12T19:22:32.961Z", "snapshot_ts": "2025-02-01T00:00:00.000Z", "period": "2025-02", "snapshot_id": 11,
  "previous_state": "OK", "message": "Load time 45.4s exceeds 30s",
  "notified": true, "suppressed_reason": null
}
```

#### `REPLAY_STATE`
```json
{ "kind": "system", "type": "REPLAY_STATE", "reason": "paused", "ts": "…", "replay": { "state": "paused", "…": "…" } }
```
`reason`: `started`, `paused`, `reset`, `looped` or `finished`. After `reset` or `looped`, open
alerts are cleared, so clients should reload `GET /api/alerts/active`.

### 4.3 Alert object

| Field | Type | Description |
|---|---|---|
| `id` | string | `evt_000123`, unique per server process |
| `type` | string | `LATENCY_BREACH`, `REFRESH_FAILURE`, `MONITORING_GAP`, `RECOVERED` |
| `severity` | string | `CRITICAL`, `WARNING`, `INFO` |
| `report_id`, `report_name` | string | Which report |
| `metric` | string | `avg_load_time_sec` or `last_refresh_status` |
| `value` | number or string | Reading that triggered the alert (seconds, or the status) |
| `threshold` | number or null | Threshold crossed (15 or 30); `null` for refresh-status alerts |
| `ts` | ISO time | When the alert was raised (wall clock) |
| `snapshot_ts`, `period`, `snapshot_id` | | Which data snapshot it is about |
| `previous_state` | string | State before the change (`OK`, `WARNING`, `MONITORING_GAP`, …) |
| `message` | string | Human-readable summary |
| `notified` | boolean | `false` if the cooldown held back the notification (history only) |
| `suppressed_reason` | string or null | `COOLDOWN`, or `PARENT_NOT_NOTIFIED` for the recovery of a held-back alert |
| `escalation` | boolean (optional) | `true` for a WARNING → CRITICAL escalation |
| `delayed` | boolean (optional) | `true` when sent after the cooldown because the problem persisted |
| `resolves`, `resolved_type` | (RECOVERED only) | Id and type of the alert this recovery closes |

### 4.4 When alerts fire

Alerts fire on **state changes**, per report and per metric, never on every bad row:

| Transition | Alert | Severity |
|---|---|---|
| Load time OK → above 15 s | `LATENCY_BREACH` (`threshold` 15) | WARNING |
| Load time OK → above 30 s | `LATENCY_BREACH` (`threshold` 30) | CRITICAL |
| WARNING → above 30 s (alert still open) | `LATENCY_BREACH`, `escalation: true` | CRITICAL |
| Breach → at or below 15 s | `RECOVERED` | INFO |
| Refresh → `FAILED` or `TIMED_OUT` | `REFRESH_FAILURE` | CRITICAL |
| Refresh → `UNKNOWN` (or an unrecognised value) | `MONITORING_GAP` | WARNING |
| `MONITORING_GAP` → `FAILED`/`TIMED_OUT` | `REFRESH_FAILURE` (skips the cooldown) | CRITICAL |
| Failing or gap → `SUCCESS` | `RECOVERED` | INFO |
| Staying in the same bad state, or `UNKNOWN` after `FAILED` | nothing | |

"Exceeds 15 seconds" is strict: exactly 15.0 s is OK, and 30.0 s is WARNING.

**Cooldown** (`ALERT_COOLDOWN_SNAPSHOTS`, default 3): after a notification of a given type for a
report, the next notification of that type for that report is held back for 3 of its snapshots.
The alert is still recorded and listed as active. If it is still open when the cooldown ends, the
notification is sent then (`delayed: true`). Escalations and gap → failure upgrades are never held back.

Example (brief scenario, RPT_200): 12 s → 44 s sends `LATENCY_BREACH` CRITICAL; the next reading
of 40 s sends nothing (still in breach); a drop to 9 s sends `RECOVERED` INFO.

---

## 5. Configuration

Environment variables (`backend/.env`, see `backend/.env.example`). All are optional.

| Variable | Default | Meaning |
|---|---|---|
| `API_PORT` | `4000` | Backend port (the Vite proxy reads the same value) |
| `HOST` | `127.0.0.1` | Bind address |
| `JWT_SECRET` | random per start | Token signing secret. If unset, a random one is generated (logins reset on restart) |
| `JWT_EXPIRES_IN` | `8h` | Token lifetime |
| `DATA_PATH` | `data/Case_Study_3_Pure_Insights_Monitoring.csv` | Source CSV |
| `LATEST_PERIOD` | `2026-09` | Month assigned to each report's newest snapshot |
| `CREDIT_PRICE_USD` | `3` | Assumed price per Snowflake credit |
| `LATENCY_WARNING_SEC` / `LATENCY_CRITICAL_SEC` | `15` / `30` | Alert thresholds |
| `ALERT_COOLDOWN_SNAPSHOTS` | `3` | Cooldown length, in snapshots of the same report |
| `REPLAY_INTERVAL_MS` | `500` | Milliseconds between replayed snapshots |
| `REPLAY_AUTOSTART` | `true` | Start streaming when the server starts |
| `REPLAY_LOOP` | `true` | Start again after the last row |

---

## 6. Production notes

Deliberate simplifications for a case study, and what production would change:

| Area | Here | Production |
|---|---|---|
| Identity | 3 hard-coded users, bcrypt hashes | Company SSO / OIDC; roles from IdP groups |
| Token storage (browser) | `localStorage` | httpOnly, Secure, SameSite cookie |
| WebSocket auth | JWT in query string | Short-lived one-time ticket, or cookie; always `wss://` |
| Transport | HTTP on localhost | HTTPS behind a load balancer; `helmet` security headers |
| Abuse protection | none | Rate limiting on `/api/auth/login`, request size limits (already 100 kB) |
| Data | CSV in memory, replayed | Snowflake tables (see `sql/`), live telemetry from a queue |
| Scale-out | single process | Alert state and pub/sub in Redis so every instance broadcasts every alert |
| Versioning | unversioned `/api` | `/api/v1` once there are external consumers |
