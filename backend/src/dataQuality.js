/**
 * dataQuality.js
 * Builds the data-quality report shown on the Data Quality page and served by
 * GET /api/data-quality. Every number here is computed from the loaded data,
 * so the page, the API and docs/DATA_QUALITY.md cannot drift apart.
 *
 * Each check answers: what is wrong, how many, how we detect it, what we do
 * with it, and why.
 */
const { FLAGS, REPORT_FLAGS } = require('./loadData');
const { round, pearson, sum } = require('./stats');

function rowsWithFlag(snapshots, flag) {
  return snapshots.filter((s) => s.anomaly_flags.includes(flag));
}

function exampleIds(rows, key = 'report_id', limit = 5) {
  return [...new Set(rows.map((r) => r[key]))].slice(0, limit);
}

/** min / max / mean / missing count for a numeric column. */
function profileColumn(snapshots, column) {
  const values = snapshots.map((s) => s[column]).filter((v) => v !== null);
  return {
    column,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    mean: values.length ? round(sum(values) / values.length, 2) : null,
    missing: snapshots.length - values.length,
  };
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/**
 * Turn a list of affected rows into a check record.
 * level: 'row' (counts snapshot rows) or 'report' (counts reports).
 */
function makeCheck({ id, title, category, origin, level, rows, total, detection, handling, rationale, details }) {
  const count = rows.length;
  return {
    id,
    title,
    category,
    origin, // BRIEF = injected anomaly named in the brief, DISCOVERED = found while profiling, INTEGRITY = routine check
    level,
    count,
    total,
    pct: total ? round((count / total) * 100, 2) : null,
    status: count > 0 ? 'FOUND' : 'PASS',
    detection,
    handling,
    rationale,
    examples: exampleIds(rows),
    details: details || {},
  };
}

function buildDataQualityReport(dataset, { creditPriceUsd = 3 } = {}) {
  const { snapshots, reports, meta } = dataset;
  const totalRows = snapshots.length;
  const totalReports = reports.length;
  const checks = [];

  // ---------------- Ownership ----------------
  const missingOwner = rowsWithFlag(snapshots, FLAGS.MISSING_OWNER);
  checks.push(makeCheck({
    id: FLAGS.MISSING_OWNER,
    title: 'Owner email missing (NaN)',
    category: 'Ownership',
    origin: 'BRIEF',
    level: 'row',
    rows: missingOwner,
    total: totalRows,
    detection: 'owner_email is empty or a null token ("nan", "null", "none", "n/a").',
    handling: 'Row kept. owner_email set to null, owner_status = MISSING, flag added.',
    rationale: 'Missing ownership is exactly what the admin dashboard must surface, so these rows are signal, not noise.',
  }));

  const sentinelOwner = rowsWithFlag(snapshots, FLAGS.ORPHANED_OWNER_SENTINEL);
  checks.push(makeCheck({
    id: FLAGS.ORPHANED_OWNER_SENTINEL,
    title: 'Owner email is the placeholder "ORPHANED_REPORT"',
    category: 'Ownership',
    origin: 'BRIEF',
    level: 'row',
    rows: sentinelOwner,
    total: totalRows,
    detection: 'owner_email equals "ORPHANED_REPORT" (case-insensitive).',
    handling: 'Row kept. Treated the same as a missing owner (owner_email = null, owner_status = ORPHANED).',
    rationale: 'A sentinel string is not an email. Treating both spellings of "no owner" the same avoids counting the placeholder as a 15th user.',
  }));

  const invalidEmail = rowsWithFlag(snapshots, FLAGS.INVALID_OWNER_EMAIL);
  checks.push(makeCheck({
    id: FLAGS.INVALID_OWNER_EMAIL,
    title: 'Owner present but not a valid email',
    category: 'Ownership',
    origin: 'INTEGRITY',
    level: 'row',
    rows: invalidEmail,
    total: totalRows,
    detection: 'owner_email is not missing, not the sentinel, and does not match name@domain.tld.',
    handling: 'Row kept, owner treated as missing.',
    rationale: 'Defensive check so a typo cannot silently create a fake owner.',
  }));

  const orphanedReports = reports.filter((r) => r.is_orphaned);
  checks.push(makeCheck({
    id: 'ORPHANED_REPORTS',
    title: 'Reports orphaned right now (latest snapshot has no valid owner)',
    category: 'Ownership',
    origin: 'BRIEF',
    level: 'report',
    rows: orphanedReports,
    total: totalReports,
    detection: 'For each report, take the latest snapshot; orphaned if its owner is missing or the sentinel.',
    handling: 'Listed on the Orphaned page with the last known valid owner as a suggested contact.',
    rationale: 'Ownership changes between snapshots, so only the latest snapshot tells us who owns the report today.',
    details: {
      never_owned_reports: reports.filter((r) => r.report_flags.includes(REPORT_FLAGS.NEVER_OWNED)).length,
      ownerless_rows_total: missingOwner.length + sentinelOwner.length + invalidEmail.length,
    },
  }));

  const unstable = reports.filter((r) => r.report_flags.includes(REPORT_FLAGS.OWNERSHIP_UNSTABLE));
  const distinctCounts = reports.map((r) => r.distinct_owner_count);
  checks.push(makeCheck({
    id: REPORT_FLAGS.OWNERSHIP_UNSTABLE,
    title: 'Owner changes between snapshots of the same report',
    category: 'Ownership',
    origin: 'DISCOVERED',
    level: 'report',
    rows: unstable,
    total: totalReports,
    detection: 'More than one distinct valid owner across a report\'s snapshots.',
    handling: 'Canonical owner = most recent valid owner. Owner change count shown per report.',
    rationale: 'An owner field that changes almost every month looks like "last editor", not "accountable owner". Worth raising with the data producer.',
    details: {
      min_distinct_owners: distinctCounts.length ? Math.min(...distinctCounts) : null,
      max_distinct_owners: distinctCounts.length ? Math.max(...distinctCounts) : null,
    },
  }));

  // ---------------- Cost ----------------
  const negativeCredits = rowsWithFlag(snapshots, FLAGS.NEGATIVE_CREDITS);
  const negativeTotal = sum(negativeCredits.map((s) => s.snowflake_credits_consumed));
  checks.push(makeCheck({
    id: FLAGS.NEGATIVE_CREDITS,
    title: 'Negative Snowflake credit consumption',
    category: 'Cost',
    origin: 'BRIEF',
    level: 'row',
    rows: negativeCredits,
    total: totalRows,
    detection: 'snowflake_credits_consumed < 0.',
    handling: 'Row kept and flagged; billable_credits = null so it is excluded from every cost total (SQL: SUM(CASE WHEN credits >= 0 ...)).',
    rationale: 'Compute cannot be "un-spent". Negative values look like refunds or adjustment rows mixed into usage data; netting them off would understate cost.',
    details: {
      excluded_credits: round(negativeTotal, 2),
      excluded_usd: round(negativeTotal * creditPriceUsd, 2),
      min_value: negativeCredits.length ? Math.min(...negativeCredits.map((s) => s.snowflake_credits_consumed)) : null,
    },
  }));

  const zeroViews = rowsWithFlag(snapshots, FLAGS.ZERO_VIEWS);
  const zeroViewCost = sum(zeroViews.map((s) => (s.billable_credits || 0) * creditPriceUsd + (s.aws_hosting_cost_usd || 0)));
  checks.push(makeCheck({
    id: FLAGS.ZERO_VIEWS,
    title: 'Zero monthly views (cost with zero usage)',
    category: 'Cost',
    origin: 'DISCOVERED',
    level: 'row',
    rows: zeroViews,
    total: totalRows,
    detection: 'monthly_active_views = 0.',
    handling: 'Cost per view = null (SQL: NULLIF(views, 0)), never Infinity or an error. The cost of these periods is reported as "zero-usage cost".',
    rationale: 'Dividing by zero views would crash or produce Infinity. Money spent on a report nobody opened is pure waste and should be visible.',
    details: { zero_usage_cost_usd: round(zeroViewCost, 2) },
  }));

  const costOutliers = rowsWithFlag(snapshots, FLAGS.AWS_COST_USAGE_OUTLIER);
  const rule = meta.cost_outlier_rule || {};
  checks.push(makeCheck({
    id: FLAGS.AWS_COST_USAGE_OUTLIER,
    title: 'AWS hosting cost out of line with usage',
    category: 'Cost',
    origin: 'BRIEF',
    level: 'row',
    rows: costOutliers,
    total: totalRows,
    detection: `aws_hosting_cost_usd / monthly_active_views above Tukey's upper fence (Q3 + 1.5 x IQR = $${round(rule.upperFence, 3)} per view).`,
    handling: 'Row kept and flagged. At report level, the top quartile of total cost per view gets the waste flag on the Costs page.',
    rationale: 'This is the brief\'s "active users vs AWS cost" discrepancy: hosting spend that usage cannot justify.',
    details: {
      q1_usd_per_view: round(rule.q1, 4),
      q3_usd_per_view: round(rule.q3, 4),
      upper_fence_usd_per_view: round(rule.upperFence, 4),
    },
  }));

  // Correlation between usage and cost columns (dataset-level finding).
  const pairs = [
    ['monthly_active_views', 'aws_hosting_cost_usd'],
    ['monthly_active_views', 'snowflake_credits_consumed'],
    ['monthly_active_views', 'query_count_last_30d'],
    ['concurrent_user_peak', 'aws_hosting_cost_usd'],
    ['query_count_last_30d', 'snowflake_credits_consumed'],
  ];
  const correlations = pairs.map(([a, b]) => {
    const rows = snapshots.filter((s) => s[a] !== null && s[b] !== null);
    return { x: a, y: b, r: round(pearson(rows.map((s) => s[a]), rows.map((s) => s[b])), 3) };
  });
  const maxAbsR = Math.max(...correlations.map((c) => Math.abs(c.r ?? 0)));
  checks.push({
    id: 'COST_NOT_EXPLAINED_BY_USAGE',
    title: 'Cost columns are not correlated with usage columns',
    category: 'Cost',
    origin: 'DISCOVERED',
    level: 'dataset',
    count: correlations.filter((c) => Math.abs(c.r ?? 0) < 0.1).length,
    total: correlations.length,
    pct: null,
    status: maxAbsR < 0.1 ? 'FOUND' : 'PASS',
    detection: 'Pearson correlation between usage (views, users, queries) and cost (AWS USD, credits). |r| < 0.1 means no linear relationship.',
    handling: 'Cost per view is reported per report and the waste flag highlights the worst quartile. No cost is "corrected".',
    rationale: `Max |r| = ${maxAbsR}. In real platforms cost tracks usage; here it does not, which suggests synthetic data. Findings show the method, not real business conclusions.`,
    examples: [],
    details: { correlations, max_abs_r: maxAbsR },
  });

  // ---------------- Usage ----------------
  const usersExceedViews = rowsWithFlag(snapshots, FLAGS.CONCURRENT_USERS_EXCEED_VIEWS);
  checks.push(makeCheck({
    id: FLAGS.CONCURRENT_USERS_EXCEED_VIEWS,
    title: 'Peak concurrent users higher than monthly views',
    category: 'Usage',
    origin: 'DISCOVERED',
    level: 'row',
    rows: usersExceedViews,
    total: totalRows,
    detection: 'concurrent_user_peak > monthly_active_views.',
    handling: 'Row kept and flagged. Values are not changed, because we cannot tell which of the two columns is wrong.',
    rationale: 'Every user online at the same moment must have opened the report at least once, so peak users cannot exceed total views. A second "user count" discrepancy beyond the cost one.',
  }));

  // ---------------- Latency ----------------
  const warn = rowsWithFlag(snapshots, FLAGS.LATENCY_BREACH_WARNING);
  const crit = rowsWithFlag(snapshots, FLAGS.LATENCY_BREACH_CRITICAL);
  const loadTimes = snapshots.map((s) => s.avg_load_time_sec).filter((v) => v !== null);
  checks.push(makeCheck({
    id: 'LATENCY_BREACH',
    title: `Load time above ${meta.latency_warning_sec} s`,
    category: 'Latency',
    origin: 'BRIEF',
    level: 'row',
    rows: [...warn, ...crit],
    total: totalRows,
    detection: `avg_load_time_sec > ${meta.latency_warning_sec} (WARNING), > ${meta.latency_critical_sec} (CRITICAL). Exactly ${meta.latency_warning_sec}.0 s is not a breach ("exceeds").`,
    handling: 'Rows kept: they are the alert signal. The alert engine fires on state changes with a cooldown instead of on every row.',
    rationale: 'With most rows breaching, one alert per row would be an alert storm that people learn to ignore.',
    details: {
      warning_rows: warn.length,
      critical_rows: crit.length,
      exactly_at_threshold_rows: snapshots.filter((s) => s.avg_load_time_sec === meta.latency_warning_sec).length,
      max_load_time_sec: loadTimes.length ? Math.max(...loadTimes) : null,
    },
  }));

  // ---------------- Refresh ----------------
  const failed = rowsWithFlag(snapshots, FLAGS.REFRESH_FAILED);
  const timedOut = rowsWithFlag(snapshots, FLAGS.REFRESH_TIMED_OUT);
  checks.push(makeCheck({
    id: 'REFRESH_FAILURE',
    title: 'Scheduled refresh FAILED or TIMED_OUT',
    category: 'Refresh',
    origin: 'BRIEF',
    level: 'row',
    rows: [...failed, ...timedOut],
    total: totalRows,
    detection: 'last_refresh_status in (FAILED, TIMED_OUT).',
    handling: 'Rows kept. Both raise a CRITICAL REFRESH_FAILURE alert when a report enters the failing state.',
    rationale: 'A timeout is a failure from the user\'s point of view: the data on the dashboard is stale either way.',
    details: { failed_rows: failed.length, timed_out_rows: timedOut.length },
  }));

  const unknown = rowsWithFlag(snapshots, FLAGS.REFRESH_STATUS_UNKNOWN);
  checks.push(makeCheck({
    id: FLAGS.REFRESH_STATUS_UNKNOWN,
    title: 'Refresh status UNKNOWN (monitoring gap)',
    category: 'Refresh',
    origin: 'DISCOVERED',
    level: 'row',
    rows: unknown,
    total: totalRows,
    detection: 'last_refresh_status = UNKNOWN.',
    handling: 'Shown separately from success and failure. Raises a WARNING MONITORING_GAP alert.',
    rationale: 'UNKNOWN is neither a success nor a failure. Counting it as either would hide that monitoring itself is broken.',
  }));

  const unrecognized = rowsWithFlag(snapshots, FLAGS.UNRECOGNIZED_REFRESH_STATUS);
  checks.push(makeCheck({
    id: FLAGS.UNRECOGNIZED_REFRESH_STATUS,
    title: 'Refresh status outside the known set',
    category: 'Refresh',
    origin: 'INTEGRITY',
    level: 'row',
    rows: unrecognized,
    total: totalRows,
    detection: 'last_refresh_status not in (SUCCESS, FAILED, TIMED_OUT, UNKNOWN).',
    handling: 'Row kept, treated like UNKNOWN by the alert engine.',
    rationale: 'Defensive check so a new status value from the source system is noticed, not silently ignored.',
  }));

  // ---------------- Time ----------------
  checks.push({
    id: 'NO_TIMESTAMP',
    title: 'No timestamp column',
    category: 'Time',
    origin: 'DISCOVERED',
    level: 'dataset',
    count: totalRows,
    total: totalRows,
    pct: 100,
    status: 'FOUND',
    detection: 'The schema has no date/time column; each report appears 20 times in round-robin file order.',
    handling: `File order treated as chronological. snapshot_seq = k-th appearance of the report; each snapshot mapped to one monthly period, ${meta.earliest_period} to ${meta.latest_period}.`,
    rationale: 'Monthly periods match the monthly columns (monthly_active_views, query_count_last_30d), so summing periods does not double count.',
    examples: [],
    details: { snapshots_per_report: meta.snapshots_per_report, earliest_period: meta.earliest_period, latest_period: meta.latest_period },
  });

  // Does a bad month predict a bad next month? In real telemetry, incidents
  // persist; here we compare P(breach | breached last month) with
  // P(breach | fine last month). Equal values mean months are independent.
  const transitions = { afterBreach: [0, 0], afterOk: [0, 0] }; // [breaches, total]
  const byReport = new Map();
  for (const s of snapshots) {
    if (!byReport.has(s.report_id)) byReport.set(s.report_id, []);
    byReport.get(s.report_id).push(s);
  }
  const isBreach = (s) => s.latency_band === 'WARNING' || s.latency_band === 'CRITICAL';
  for (const history of byReport.values()) {
    history.sort((a, b) => a.snapshot_seq - b.snapshot_seq);
    for (let i = 1; i < history.length; i += 1) {
      const bucket = isBreach(history[i - 1]) ? transitions.afterBreach : transitions.afterOk;
      bucket[1] += 1;
      if (isBreach(history[i])) bucket[0] += 1;
    }
  }
  const pAfterBreach = transitions.afterBreach[1] ? transitions.afterBreach[0] / transitions.afterBreach[1] : null;
  const pAfterOk = transitions.afterOk[1] ? transitions.afterOk[0] / transitions.afterOk[1] : null;
  const persistenceGap = pAfterBreach !== null && pAfterOk !== null ? Math.abs(pAfterBreach - pAfterOk) : null;
  checks.push({
    id: 'NO_TEMPORAL_PERSISTENCE',
    title: 'A bad month does not predict a bad next month',
    category: 'Time',
    origin: 'DISCOVERED',
    level: 'dataset',
    count: transitions.afterBreach[1] + transitions.afterOk[1],
    total: transitions.afterBreach[1] + transitions.afterOk[1],
    pct: null,
    status: persistenceGap !== null && persistenceGap < 0.05 ? 'FOUND' : 'PASS',
    detection: 'Compare P(latency breach | breached in the previous snapshot) with P(latency breach | healthy in the previous snapshot), per report.',
    handling: 'No change to the data. Explains why state-change alerting alone removes less noise here than it would on real telemetry; the per-report cooldown does the rest.',
    rationale: `P(breach | previous breach) = ${round(pAfterBreach, 3)} vs P(breach | previous OK) = ${round(pAfterOk, 3)}. Real incidents persist; independent months are another sign of synthetic data.`,
    examples: [],
    details: { p_breach_after_breach: round(pAfterBreach, 3), p_breach_after_ok: round(pAfterOk, 3) },
  });

  // ---------------- Integrity ----------------
  const duplicates = rowsWithFlag(snapshots, FLAGS.DUPLICATE_ROW);
  checks.push(makeCheck({
    id: FLAGS.DUPLICATE_ROW,
    title: 'Exact duplicate rows',
    category: 'Integrity',
    origin: 'INTEGRITY',
    level: 'row',
    rows: duplicates,
    total: totalRows,
    detection: 'Same value in all 10 columns as an earlier row.',
    handling: 'Second and later copies flagged (not dropped).',
    rationale: 'Duplicates would double count cost and usage.',
  }));

  const invalid = rowsWithFlag(snapshots, FLAGS.INVALID_VALUE);
  checks.push(makeCheck({
    id: FLAGS.INVALID_VALUE,
    title: 'Unparseable or out-of-range values',
    category: 'Integrity',
    origin: 'INTEGRITY',
    level: 'row',
    rows: invalid,
    total: totalRows,
    detection: 'Numeric cell not a number, below its minimum (views, latency, AWS cost, queries, users >= 0), or a non-integer count.',
    handling: 'Unusable value set to null and listed in validation_issues; row kept.',
    rationale: 'Bad values should be visible and excluded from maths, not crash the loader or turn into NaN.',
    details: { issues: invalid.slice(0, 10).map((s) => ({ snapshot_id: s.snapshot_id, issues: s.validation_issues })) },
  }));

  const nameConflicts = reports.filter((r) => r.report_flags.includes(REPORT_FLAGS.REPORT_NAME_CONFLICT));
  checks.push(makeCheck({
    id: REPORT_FLAGS.REPORT_NAME_CONFLICT,
    title: 'Same report_id with different report names',
    category: 'Integrity',
    origin: 'INTEGRITY',
    level: 'report',
    rows: nameConflicts,
    total: totalReports,
    detection: 'More than one distinct report_name for a report_id.',
    handling: 'Latest name used for display; report flagged.',
    rationale: 'report_id is the join key for cost attribution, so it must identify one report.',
  }));

  const counts = reports.map((r) => r.snapshot_count);
  const uneven = reports.filter((r) => r.snapshot_count !== Math.max(...counts));
  checks.push(makeCheck({
    id: 'UNEVEN_SNAPSHOT_COUNTS',
    title: 'Reports with fewer snapshots than others',
    category: 'Integrity',
    origin: 'INTEGRITY',
    level: 'report',
    rows: uneven,
    total: totalReports,
    detection: 'snapshot_count differs from the maximum snapshot_count.',
    handling: 'Periods are aligned from the latest snapshot backwards.',
    rationale: 'Missing snapshots would make period-by-period comparisons misleading.',
    details: { min_snapshots: Math.min(...counts), max_snapshots: Math.max(...counts) },
  }));

  // ---------------- Summary ----------------
  const flaggedRows = snapshots.filter((s) => s.anomaly_flags.length > 0).length;
  const flagCounts = countBy(snapshots.flatMap((s) => s.anomaly_flags), (f) => f);

  return {
    generated_at: new Date().toISOString(),
    source_file: meta.source_file || null,
    summary: {
      rows_total: totalRows,
      rows_dropped: 0,
      rows_with_any_flag: flaggedRows,
      rows_excluded_from_cost_totals: negativeCredits.length,
      reports_total: totalReports,
      checks_run: checks.length,
      checks_with_findings: checks.filter((c) => c.status === 'FOUND').length,
      schema: meta.schema,
    },
    flag_counts: flagCounts,
    refresh_status_counts: countBy(snapshots, (s) => s.last_refresh_status),
    owner_status_counts: countBy(snapshots, (s) => s.owner_status),
    column_profile: [
      'monthly_active_views',
      'snowflake_credits_consumed',
      'avg_load_time_sec',
      'aws_hosting_cost_usd',
      'query_count_last_30d',
      'concurrent_user_peak',
    ].map((c) => profileColumn(snapshots, c)),
    checks,
  };
}

module.exports = { buildDataQualityReport };
