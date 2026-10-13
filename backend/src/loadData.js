/**
 * loadData.js
 * Turns the raw monitoring CSV into clean, typed, flagged snapshot records,
 * plus one summary per report.
 *
 *   read file -> parse CSV -> check schema -> clean each row (type + flag)
 *   -> dataset-level checks (order, duplicates, cost outliers) -> report summaries
 *
 * Golden rule: rows are NEVER dropped. Every problem becomes an entry in the
 * row's `anomaly_flags` list and is counted in the data-quality report
 * (see dataQuality.js). Decisions about what to exclude from a calculation
 * (for example negative credits from cost totals) are made later, explicitly.
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { percentileCont } = require('./stats');

const EXPECTED_COLUMNS = [
  'report_id',
  'report_name',
  'owner_email',
  'last_refresh_status',
  'monthly_active_views',
  'snowflake_credits_consumed',
  'avg_load_time_sec',
  'aws_hosting_cost_usd',
  'query_count_last_30d',
  'concurrent_user_peak',
];

const REFRESH_STATUSES = ['SUCCESS', 'FAILED', 'TIMED_OUT', 'UNKNOWN'];
const ORPHAN_SENTINEL = 'ORPHANED_REPORT';
// Spellings that mean "no value". pandas writes missing values as "nan".
const MISSING_TOKENS = ['', 'nan', 'null', 'none', 'n/a', 'na'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Rules for each numeric column. Credits have no minimum here because
// negative credits get their own, more specific flag.
const NUMERIC_COLUMNS = {
  monthly_active_views: { integer: true, min: 0 },
  snowflake_credits_consumed: { integer: false, min: null },
  avg_load_time_sec: { integer: false, min: 0 },
  aws_hosting_cost_usd: { integer: false, min: 0 },
  query_count_last_30d: { integer: true, min: 0 },
  concurrent_user_peak: { integer: true, min: 0 },
};

// Every flag a snapshot row can carry. Using constants avoids typos.
const FLAGS = {
  MISSING_OWNER: 'MISSING_OWNER',
  ORPHANED_OWNER_SENTINEL: 'ORPHANED_OWNER_SENTINEL',
  INVALID_OWNER_EMAIL: 'INVALID_OWNER_EMAIL',
  NEGATIVE_CREDITS: 'NEGATIVE_CREDITS',
  LATENCY_BREACH_WARNING: 'LATENCY_BREACH_WARNING',
  LATENCY_BREACH_CRITICAL: 'LATENCY_BREACH_CRITICAL',
  REFRESH_FAILED: 'REFRESH_FAILED',
  REFRESH_TIMED_OUT: 'REFRESH_TIMED_OUT',
  REFRESH_STATUS_UNKNOWN: 'REFRESH_STATUS_UNKNOWN',
  UNRECOGNIZED_REFRESH_STATUS: 'UNRECOGNIZED_REFRESH_STATUS',
  ZERO_VIEWS: 'ZERO_VIEWS',
  CONCURRENT_USERS_EXCEED_VIEWS: 'CONCURRENT_USERS_EXCEED_VIEWS',
  AWS_COST_USAGE_OUTLIER: 'AWS_COST_USAGE_OUTLIER',
  INVALID_VALUE: 'INVALID_VALUE',
  DUPLICATE_ROW: 'DUPLICATE_ROW',
};

// Flags that describe a whole report rather than a single row.
const REPORT_FLAGS = {
  ORPHANED: 'ORPHANED',
  OWNERSHIP_UNSTABLE: 'OWNERSHIP_UNSTABLE',
  NEVER_OWNED: 'NEVER_OWNED',
  REPORT_NAME_CONFLICT: 'REPORT_NAME_CONFLICT',
};

const DEFAULT_OPTIONS = {
  latestPeriod: '2026-09',
  latencyWarningSec: 15,
  latencyCriticalSec: 30,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** "2026-09" minus 3 months -> "2026-06". */
function shiftPeriod(period, monthsBack) {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error(`Invalid period "${period}", expected YYYY-MM`);
  const monthIndex = Number(match[1]) * 12 + (Number(match[2]) - 1) - monthsBack;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Latency band used by both the flags and the alert engine. */
function latencyBand(seconds, warningSec, criticalSec) {
  if (seconds === null) return null;
  if (seconds > criticalSec) return 'CRITICAL';
  if (seconds > warningSec) return 'WARNING';
  return 'OK';
}

/**
 * Parse one numeric cell. Returns { value, issue } where value is null when
 * the cell cannot be used (not a number, or below the allowed minimum).
 */
function parseNumericCell(column, rawValue) {
  const rule = NUMERIC_COLUMNS[column];
  const text = String(rawValue ?? '').trim();
  if (MISSING_TOKENS.includes(text.toLowerCase())) {
    return { value: null, issue: `${column}: missing value` };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { value: null, issue: `${column}: not a number ("${text}")` };
  }
  if (rule.min !== null && value < rule.min) {
    return { value: null, issue: `${column}: ${value} is below the minimum ${rule.min}` };
  }
  if (rule.integer && !Number.isInteger(value)) {
    // Still usable, but worth knowing about.
    return { value, issue: `${column}: expected a whole number, got ${value}` };
  }
  return { value, issue: null };
}

// ---------------------------------------------------------------------------
// Step 1: parse
// ---------------------------------------------------------------------------

/** Parse CSV text into { columns, records } where records are plain objects. */
function parseCsvText(text) {
  let columns = [];
  const records = parse(text, {
    bom: true,
    skip_empty_lines: true,
    trim: true,
    // Keep going if a row has too few/many cells; missing cells are flagged later.
    relax_column_count: true,
    columns: (header) => {
      columns = header.map((name) => String(name).trim());
      return columns;
    },
  });
  return { columns, records };
}

/** Compare the CSV header with the columns we need. */
function checkSchema(columns) {
  const missing = EXPECTED_COLUMNS.filter((c) => !columns.includes(c));
  const extra = columns.filter((c) => !EXPECTED_COLUMNS.includes(c));
  return { columns, missing, extra };
}

// ---------------------------------------------------------------------------
// Step 2: clean one row
// ---------------------------------------------------------------------------

/**
 * Validate and type one raw CSV record. Never throws for bad data: problems
 * are recorded in anomaly_flags / validation_issues instead.
 * @param {object} raw       record from the CSV (all strings)
 * @param {number} rowNumber 1-based position in the file (header excluded)
 */
function cleanRow(raw, rowNumber, options = DEFAULT_OPTIONS) {
  const flags = [];
  const issues = [];
  let hasInvalidValue = false;

  const reportId = String(raw.report_id ?? '').trim().toUpperCase();
  const reportName = String(raw.report_name ?? '').trim();
  if (!reportId) {
    hasInvalidValue = true;
    issues.push('report_id: missing value');
  }

  // --- Owner -------------------------------------------------------------
  const ownerRaw = String(raw.owner_email ?? '').trim();
  let ownerEmail = null;
  let ownerStatus;
  if (MISSING_TOKENS.includes(ownerRaw.toLowerCase())) {
    ownerStatus = 'MISSING';
    flags.push(FLAGS.MISSING_OWNER);
  } else if (ownerRaw.toUpperCase() === ORPHAN_SENTINEL) {
    ownerStatus = 'ORPHANED';
    flags.push(FLAGS.ORPHANED_OWNER_SENTINEL);
  } else if (!EMAIL_PATTERN.test(ownerRaw)) {
    ownerStatus = 'INVALID';
    flags.push(FLAGS.INVALID_OWNER_EMAIL);
  } else {
    ownerStatus = 'VALID';
    ownerEmail = ownerRaw.toLowerCase();
  }

  // --- Refresh status ----------------------------------------------------
  const refreshStatus = String(raw.last_refresh_status ?? '').trim().toUpperCase();
  if (!REFRESH_STATUSES.includes(refreshStatus)) {
    flags.push(FLAGS.UNRECOGNIZED_REFRESH_STATUS);
    issues.push(`last_refresh_status: unrecognized value "${refreshStatus}"`);
  } else if (refreshStatus === 'FAILED') {
    flags.push(FLAGS.REFRESH_FAILED);
  } else if (refreshStatus === 'TIMED_OUT') {
    flags.push(FLAGS.REFRESH_TIMED_OUT);
  } else if (refreshStatus === 'UNKNOWN') {
    flags.push(FLAGS.REFRESH_STATUS_UNKNOWN);
  }

  // --- Numbers -----------------------------------------------------------
  const numbers = {};
  for (const column of Object.keys(NUMERIC_COLUMNS)) {
    const { value, issue } = parseNumericCell(column, raw[column]);
    numbers[column] = value;
    if (issue) {
      issues.push(issue);
      hasInvalidValue = true;
    }
  }
  if (hasInvalidValue) flags.push(FLAGS.INVALID_VALUE);

  const views = numbers.monthly_active_views;
  const credits = numbers.snowflake_credits_consumed;
  const loadTime = numbers.avg_load_time_sec;
  const awsCost = numbers.aws_hosting_cost_usd;
  const userPeak = numbers.concurrent_user_peak;

  // Negative credits are impossible (you cannot un-spend compute). Keep the
  // raw value for auditing, but exclude it from cost totals.
  let billableCredits = credits;
  if (credits !== null && credits < 0) {
    flags.push(FLAGS.NEGATIVE_CREDITS);
    billableCredits = null;
  }

  const band = latencyBand(loadTime, options.latencyWarningSec, options.latencyCriticalSec);
  if (band === 'WARNING') flags.push(FLAGS.LATENCY_BREACH_WARNING);
  if (band === 'CRITICAL') flags.push(FLAGS.LATENCY_BREACH_CRITICAL);

  if (views === 0) flags.push(FLAGS.ZERO_VIEWS);

  // Peak concurrent users should never exceed the month's total views:
  // every user online at the same time must have opened the report at least once.
  if (views !== null && userPeak !== null && userPeak > views) {
    flags.push(FLAGS.CONCURRENT_USERS_EXCEED_VIEWS);
  }

  return {
    snapshot_id: rowNumber,
    snapshot_seq: null, // filled in by the dataset-level pass
    period: null,
    snapshot_ts: null,
    report_id: reportId,
    report_name: reportName,
    owner_email_raw: ownerRaw,
    owner_email: ownerEmail,
    owner_status: ownerStatus,
    last_refresh_status: refreshStatus,
    monthly_active_views: views,
    snowflake_credits_consumed: credits,
    billable_credits: billableCredits,
    avg_load_time_sec: loadTime,
    latency_band: band,
    aws_hosting_cost_usd: awsCost,
    // null when views is 0 or unknown: no divide-by-zero, no Infinity.
    aws_cost_per_view: views && awsCost !== null ? awsCost / views : null,
    query_count_last_30d: numbers.query_count_last_30d,
    concurrent_user_peak: userPeak,
    anomaly_flags: flags,
    validation_issues: issues,
  };
}

// ---------------------------------------------------------------------------
// Step 3: dataset-level checks
// ---------------------------------------------------------------------------

/**
 * The CSV has no timestamp. We treat file order as chronological: the k-th
 * time a report appears is its k-th snapshot. Each snapshot covers one month
 * (the columns are monthly: monthly_active_views, query_count_last_30d), and
 * the most recent snapshot is mapped to options.latestPeriod.
 */
function assignSnapshotOrder(snapshots, latestPeriod) {
  const seen = new Map();
  for (const s of snapshots) {
    const seq = (seen.get(s.report_id) || 0) + 1;
    seen.set(s.report_id, seq);
    s.snapshot_seq = seq;
  }
  const maxSeq = Math.max(0, ...seen.values());
  for (const s of snapshots) {
    s.period = shiftPeriod(latestPeriod, maxSeq - s.snapshot_seq);
    s.snapshot_ts = `${s.period}-01T00:00:00.000Z`;
  }
  return maxSeq;
}

/** Flag exact repeats of an earlier row (same values in every column). */
function flagDuplicates(snapshots, records) {
  const seen = new Set();
  snapshots.forEach((s, i) => {
    const key = JSON.stringify(EXPECTED_COLUMNS.map((c) => records[i][c]));
    if (seen.has(key)) s.anomaly_flags.push(FLAGS.DUPLICATE_ROW);
    seen.add(key);
  });
}

/**
 * "AWS cost does not match usage": flag rows whose AWS cost per view is a
 * statistical outlier, using Tukey's rule (above Q3 + 1.5 x IQR).
 * Zero-view rows are not included here; they are flagged ZERO_VIEWS instead.
 */
function flagCostUsageOutliers(snapshots) {
  const ratios = snapshots.map((s) => s.aws_cost_per_view).filter((r) => r !== null);
  if (ratios.length === 0) return null;
  const q1 = percentileCont(ratios, 0.25);
  const q3 = percentileCont(ratios, 0.75);
  const upperFence = q3 + 1.5 * (q3 - q1);
  for (const s of snapshots) {
    if (s.aws_cost_per_view !== null && s.aws_cost_per_view > upperFence) {
      s.anomaly_flags.push(FLAGS.AWS_COST_USAGE_OUTLIER);
    }
  }
  return { q1, q3, upperFence };
}

// ---------------------------------------------------------------------------
// Step 4: one summary per report
// ---------------------------------------------------------------------------

/** Build a per-report summary: latest state, ownership and history stats. */
function buildReportSummaries(snapshots) {
  const byReport = new Map();
  for (const s of snapshots) {
    if (!byReport.has(s.report_id)) byReport.set(s.report_id, []);
    byReport.get(s.report_id).push(s);
  }

  const reports = [];
  for (const [reportId, history] of byReport) {
    history.sort((a, b) => a.snapshot_seq - b.snapshot_seq);
    const latest = history[history.length - 1];
    const reportFlags = [];

    // Ownership. Canonical owner = most recent valid owner (searching back
    // from the latest snapshot). A report is orphaned when its latest
    // snapshot has no valid owner, even if someone owned it before.
    const validOwners = history.filter((s) => s.owner_email !== null);
    const lastValid = validOwners[validOwners.length - 1] || null;
    let ownerChanges = 0;
    for (let i = 1; i < validOwners.length; i += 1) {
      if (validOwners[i].owner_email !== validOwners[i - 1].owner_email) ownerChanges += 1;
    }
    const distinctOwners = new Set(validOwners.map((s) => s.owner_email)).size;
    const isOrphaned = latest.owner_email === null;
    if (isOrphaned) reportFlags.push(REPORT_FLAGS.ORPHANED);
    if (!lastValid) reportFlags.push(REPORT_FLAGS.NEVER_OWNED);
    if (distinctOwners > 1) reportFlags.push(REPORT_FLAGS.OWNERSHIP_UNSTABLE);

    const names = new Set(history.map((s) => s.report_name));
    if (names.size > 1) reportFlags.push(REPORT_FLAGS.REPORT_NAME_CONFLICT);

    const loadTimes = history.map((s) => s.avg_load_time_sec).filter((v) => v !== null);
    const breaches = history.filter((s) => s.latency_band === 'WARNING' || s.latency_band === 'CRITICAL');
    const countStatus = (status) => history.filter((s) => s.last_refresh_status === status).length;

    reports.push({
      report_id: reportId,
      report_name: latest.report_name,
      snapshot_count: history.length,

      latest_period: latest.period,
      latest_refresh_status: latest.last_refresh_status,
      latest_load_time_sec: latest.avg_load_time_sec,
      latest_latency_band: latest.latency_band,
      latest_monthly_active_views: latest.monthly_active_views,
      latest_credits_consumed: latest.snowflake_credits_consumed,
      latest_aws_hosting_cost_usd: latest.aws_hosting_cost_usd,
      latest_concurrent_user_peak: latest.concurrent_user_peak,
      latest_anomaly_flags: latest.anomaly_flags,

      latest_owner_email: latest.owner_email,
      latest_owner_status: latest.owner_status,
      is_orphaned: isOrphaned,
      canonical_owner_email: lastValid ? lastValid.owner_email : null,
      canonical_owner_period: lastValid ? lastValid.period : null,
      periods_since_valid_owner: lastValid ? latest.snapshot_seq - lastValid.snapshot_seq : null,
      distinct_owner_count: distinctOwners,
      owner_change_count: ownerChanges,
      ownerless_snapshot_count: history.length - validOwners.length,

      failed_refresh_count: countStatus('FAILED'),
      timed_out_refresh_count: countStatus('TIMED_OUT'),
      unknown_refresh_count: countStatus('UNKNOWN'),
      avg_load_time_sec: loadTimes.length ? loadTimes.reduce((a, b) => a + b, 0) / loadTimes.length : null,
      max_load_time_sec: loadTimes.length ? Math.max(...loadTimes) : null,
      latency_breach_rate: history.length ? breaches.length / history.length : null,

      report_flags: reportFlags,
    });
  }

  reports.sort((a, b) => a.report_id.localeCompare(b.report_id));
  return reports;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Clean already-parsed CSV text. Useful for tests with small inline CSVs. */
function buildDataset(text, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { columns, records } = parseCsvText(text);
  const schema = checkSchema(columns);
  if (schema.missing.length > 0) {
    // Without these columns nothing downstream can work, so fail loudly.
    throw new Error(`CSV is missing required columns: ${schema.missing.join(', ')}`);
  }

  const snapshots = records.map((raw, i) => cleanRow(raw, i + 1, opts));
  const snapshotsPerReport = assignSnapshotOrder(snapshots, opts.latestPeriod);
  flagDuplicates(snapshots, records);
  const costOutlierRule = flagCostUsageOutliers(snapshots);
  const reports = buildReportSummaries(snapshots);

  return {
    snapshots,
    reports,
    meta: {
      schema,
      row_count: snapshots.length,
      report_count: reports.length,
      snapshots_per_report: snapshotsPerReport,
      latest_period: opts.latestPeriod,
      earliest_period: snapshotsPerReport ? shiftPeriod(opts.latestPeriod, snapshotsPerReport - 1) : null,
      latency_warning_sec: opts.latencyWarningSec,
      latency_critical_sec: opts.latencyCriticalSec,
      cost_outlier_rule: costOutlierRule,
    },
  };
}

/** Read the CSV from disk and clean it. */
function loadDataset(filePath, options = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  const dataset = buildDataset(text, options);
  dataset.meta.source_file = path.basename(filePath);
  dataset.meta.loaded_at = new Date().toISOString();
  return dataset;
}

module.exports = {
  EXPECTED_COLUMNS,
  REFRESH_STATUSES,
  FLAGS,
  REPORT_FLAGS,
  shiftPeriod,
  latencyBand,
  parseCsvText,
  checkSchema,
  cleanRow,
  buildReportSummaries,
  buildDataset,
  loadDataset,
};
