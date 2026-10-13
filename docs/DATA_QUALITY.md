# Data Quality Report: `Case_Study_3_Pure_Insights_Monitoring.csv`

Every anomaly in the source data: what it is, how many rows it affects, how it is detected, how it
is handled, and why. All numbers are **computed by the code** and checked by tests, so this document,
the Data Quality page, `GET /api/data-quality` and the SQL view `ANALYTICS.V_DATA_QUALITY_SUMMARY`
cannot drift apart.

Reproduce every number:
```bash
cd backend
npm run dq     # JavaScript data-quality report as a table
npm run sql    # the same checks in SQL (sql/04_waste_and_anomalies.sql on DuckDB)
npm test       # loadData, dataQuality and sql tests assert every count below
```

## 1. Summary

| | |
|---|---|
| Rows | 2,000 (100 reports × 20 snapshots), 10 columns |
| Rows dropped | **0**: every problem is flagged and counted, never deleted |
| Rows with at least one flag | 1,743 (mostly latency breaches, which are the alert signal) |
| Rows excluded from cost totals | 24 (negative credits; kept in the data, flagged) |
| Checks run | 20, of which 14 have findings and 6 pass |
| Implementations | JavaScript (`backend/src/loadData.js`, `dataQuality.js`) and SQL (`sql/02`, `sql/04`), cross-checked by `backend/tests/sql.test.js` |

### Principles
1. **Flag, don't drop.** Each row carries an `anomaly_flags` list (SQL: one `FLAG_*` column per issue).
2. **Exclude explicitly, per calculation.** Negative credits are left out of cost totals; latency
   spikes are kept because they *are* the alert signal; ownerless rows are kept because they *are*
   the orphaned-reports feature.
3. **Never invent values.** Nothing is imputed, made positive, or "corrected". Unusable values become `null`.
4. **Every check is documented** with detection rule, handling and rationale (`dataQuality.js`), and served by the API.

---

## 2. Verification of the documented dataset profile

The project brief came with a dataset profile. Each figure was re-checked against the file by an
automated test (`backend/tests/loadData.test.js`, block "real dataset").

| Profile item | Expected | Observed | Result |
|---|---|---|---|
| Rows | 2,000 | 2,000 | ✅ |
| Reports | 100 (RPT_200–RPT_299), 20 rows each | 100, all 20 rows | ✅ |
| Real owners | 14 | 14 | ✅ |
| `nan` owners | 128 | 128 | ✅ |
| `ORPHANED_REPORT` owners | 117 | 117 | ✅ |
| Refresh status | SUCCESS 1336, FAILED 382, TIMED_OUT 182, UNKNOWN 100 | identical | ✅ |
| `monthly_active_views` | 0–1499, 4 zeros | 0–1499, 4 zeros | ✅ |
| `snowflake_credits_consumed` | −13.6 to 1200, 24 negative | −13.6 to **1199.97**, 24 negative | ✅ (max is 1199.97, "1200" was rounded) |
| `avg_load_time_sec` | 0.6–55.0, 74.5% > 15 s | 0.6–55.0, 1,490 rows = 74.5% | ✅ |
| `aws_hosting_cost_usd` | $15–$450 | $15.04–$449.64 | ✅ |
| `query_count_last_30d` | 20 – ~25,000 | 20–24,998 | ✅ |
| `concurrent_user_peak` | 1–149 | 1–149 | ✅ |
| Duplicates / other nulls | none | none | ✅ |
| Distinct owners per report | 7–13 | 7–13 | ✅ |
| \|r\| between usage and cost | ≤ 0.05 | max 0.048 | ✅ |

**No discrepancies found.** The only difference is cosmetic: the credit maximum is 1199.97, not 1200.

---

## 3. Injected anomalies named in the brief

### 3.1 Orphaned report records: owner missing (`nan`) or `ORPHANED_REPORT`

| | |
|---|---|
| **Count** | 128 `nan` + 117 `ORPHANED_REPORT` = **245 ownerless rows** (12.25%). **14 reports** are orphaned *now* (latest snapshot has no valid owner): 10 with `nan`, 4 with the placeholder |
| **Detection** | `owner_email` empty or a null token (`nan`, `null`, `none`, `n/a`, `na`) → `MISSING`; equals `ORPHANED_REPORT` (any case) → `ORPHANED`; anything else must look like `name@domain.tld`, otherwise `INVALID` (0 rows) |
| **Handling** | Rows kept. `owner_email = null`, `owner_status` records which kind. A report is **orphaned if its latest snapshot** has no valid owner. Its **canonical owner** (suggested contact) is the most recent valid owner in its history |
| **Rationale** | Two spellings of "no owner" must not count the placeholder as a 15th user. Ownership changes between snapshots (see 4.2), so only the latest snapshot says who owns the report today |
| **Impact** | The 14 orphaned reports account for **$587,371.59** of spend with no accountable owner; 3 of them are also in the waste quartile |
| **Where** | `loadData.js` → `cleanRow`, `buildReportSummaries`; SQL `02_load_clean.sql`, `04` → `V_ORPHANED_REPORTS`; UI: Orphaned page |

### 3.2 Negative Snowflake credit consumption

| | |
|---|---|
| **Count** | **24 rows** (1.2%), from −0.80 to −13.60 credits, **−161.04 credits** in total (−$483.12 at $3/credit) |
| **Detection** | `snowflake_credits_consumed < 0` |
| **Handling** | Raw value kept (`snowflake_credits_consumed`), `billable_credits = null`, flag `NEGATIVE_CREDITS`. Excluded from every cost total (SQL: `SUM(CASE WHEN credits >= 0 …)`). Counted per report (`excluded_rows`, `excluded_negative_credits`) |
| **Rationale** | Compute cannot be "un-spent". These look like refunds or adjustments mixed into usage logs. **Netting** them would understate cost, and **`ABS()`** would invent spend. Excluding and reporting them lets finance reconcile them separately |
| **Where** | `cleanRow`, `costs.js`; SQL `02` (`BILLABLE_CREDITS`), `03` (`EXCLUDED_*` columns) |

### 3.3 Extreme load latency spikes (up to 55 s)

| | |
|---|---|
| **Count** | **1,490 rows above 15 s (74.5%)**: 580 WARNING (15–30 s) and 910 CRITICAL (> 30 s). Maximum 55.0 s (6 rows). 7 rows are exactly 15.0 s |
| **Detection** | `avg_load_time_sec > 15` → WARNING, `> 30` → CRITICAL. **Strictly greater**: the brief says "exceeds 15 seconds", so 15.0 s is OK and 30.0 s is WARNING |
| **Handling** | Rows kept: they are the alert signal. The alert engine fires on **state changes** with a per-report **cooldown**, not on every row (section 4.3) |
| **Rationale** | With three quarters of rows breaching, one alert per row would be 2,154 alerts, an alert storm people learn to ignore |
| **Where** | `latencyBand()` in `loadData.js`; `alerts/engine.js`; SQL `02` (`LATENCY_BAND`), `04` (`V_LATENCY_STATE_CHANGES`) |

### 3.4 Discrepancy between active users and AWS hosting cost

| | |
|---|---|
| **Count** | **212 rows** (10.6%) are cost-vs-usage outliers. At report level, **25 reports** are flagged as waste. Usage and AWS cost are uncorrelated: r(views, AWS cost) = −0.027 |
| **Detection** | Per row: AWS cost per view above **Tukey's upper fence**, Q3 + 1.5 × IQR = **$1.35 per view** (Q1 = $0.16, Q3 = $0.64). Per report: total cost per view ≥ 75th percentile (**$2.94**) → `waste_flag` |
| **Handling** | Rows kept and flagged `AWS_COST_USAGE_OUTLIER`. Costs page highlights waste reports. Nothing is "corrected" |
| **Rationale** | Hosting spend should scale with usage. A robust outlier rule (quartiles, not mean ± SD) suits the long-tailed ratio. The top-quartile rule gives a stable, explainable review shortlist when there is no "expected cost" model to compare against |
| **Where** | `flagCostUsageOutliers()` in `loadData.js`, `costs.js`; SQL `04` → `V_AWS_COST_USAGE_OUTLIERS`, `V_COST_WASTE` |

---

## 4. Additional issues discovered while profiling

### 4.1 No timestamp column
| | |
|---|---|
| **Finding** | The schema has no date or time. Each report appears exactly 20 times in strict **round-robin** order: row *i* is report `RPT_(200 + i mod 100)` |
| **Handling** | File order is treated as chronological: the k-th appearance is snapshot k (`snapshot_seq`). Each snapshot is mapped to one **month**, 2025-02 to 2026-09 (newest = `LATEST_PERIOD`, configurable). SQL uses `METADATA$FILE_ROW_NUMBER` to keep file order on load |
| **Rationale** | Monthly, not daily, because the columns are monthly (`monthly_active_views`, `query_count_last_30d`). With daily snapshots the 30-day windows would overlap, and adding periods (needed for cost per view) would double count |

### 4.2 Ownership changes between snapshots of the same report
| | |
|---|---|
| **Finding** | **All 100 reports** have between 7 and 13 different valid owners across 20 snapshots |
| **Handling** | Flag `OWNERSHIP_UNSTABLE` per report; canonical owner = most recent valid owner; owner-change counts shown per report |
| **Rationale** | An owner that changes almost every month behaves like "last editor", not "accountable owner". Worth raising with the data producer (section 6) |

### 4.3 Alert storm risk, and months are independent
| | |
|---|---|
| **Finding** | 74.5% of rows breach 15 s. Also, **a bad month does not predict a bad next month**: P(breach \| breached last month) = 0.748 vs P(breach \| healthy last month) = 0.733 (check `NO_TEMPORAL_PERSISTENCE`) |
| **Handling** | State-change alerting + per-report cooldown (3 snapshots) + severity. Over the whole file: **2,154 per-row alerts → 860 actionable notifications (−60.1%)**. The cooldown delays rather than drops: active alerts always equal the reports currently in breach (tested) |
| **Rationale** | Real incidents persist, so state-change alerting usually compresses them a lot. Here each month is an independent draw, so reports flip in and out of breach constantly: state changes alone cut actionable pages to 1,025 (−52%) but still send 792 recovery messages. The cooldown takes pages to 860 (−60%). The independence is also a strong sign the data is synthetic |

### 4.4 Zero monthly views
| | |
|---|---|
| **Count** | 4 rows (RPT_223, RPT_230, RPT_278, RPT_299), costing **$6,959.11** in total |
| **Handling** | Cost per view = `null` (SQL `NULLIF(views, 0)`), never an error or Infinity. That spend is reported as **zero-usage cost**, which is pure waste |
| **Note** | All 4 rows still report concurrent users and thousands of queries, which is inconsistent (see 4.6). Scheduled refreshes could explain the queries, but not the users |

### 4.5 `UNKNOWN` refresh status
| | |
|---|---|
| **Count** | 100 rows (5%); 5 reports are UNKNOWN in their latest snapshot |
| **Handling** | Shown as its own category, never folded into success or failure. Raises a **MONITORING_GAP** WARNING alert. `UNKNOWN` after `FAILED` does not close the failure alert |
| **Rationale** | UNKNOWN means the monitoring itself failed. Counting it as success hides outages; counting it as failure creates false alarms |

### 4.6 Peak concurrent users higher than monthly views
| | |
|---|---|
| **Count** | **93 rows** (4.65%) where `concurrent_user_peak > monthly_active_views` |
| **Handling** | Flag `CONCURRENT_USERS_EXCEED_VIEWS`; values unchanged |
| **Rationale** | Everyone online at the same moment must have opened the report at least once, so peak users cannot exceed total views. A second "user count" discrepancy beyond the cost one. We cannot tell which column is wrong, so neither is changed |

### 4.7 Cost is not explained by usage
| | |
|---|---|
| **Finding** | Pearson r between usage (views, users, queries) and cost (AWS USD, credits): all \|r\| < 0.05 (views–credits 0.048, views–AWS −0.027, queries–credits 0.012, users–AWS −0.018, views–queries −0.004) |
| **Handling** | Reported as a dataset-level finding. Cost per view is still computed per report; the waste flag is relative (top quartile) |
| **Rationale** | In a real platform, credits track queries and hosting tracks users. Zero correlation everywhere, plus independent months (4.3) and uniform distributions, says the data is synthetic: **the findings demonstrate the method, not real business conclusions** |

---

## 5. Integrity checks that passed

| Check | Rule | Result |
|---|---|---|
| Schema | All 10 expected columns present, no extras (missing column → load stops with a clear error) | PASS |
| Duplicate rows | Same value in all 10 columns as an earlier row | 0 (PASS) |
| Unparseable / out-of-range values | Numbers must parse; views, latency, AWS cost, queries, users ≥ 0; counts must be whole numbers | 0 (PASS) |
| Invalid owner email | Not missing, not the placeholder, not `name@domain.tld` | 0 (PASS) |
| Unrecognised refresh status | Outside SUCCESS / FAILED / TIMED_OUT / UNKNOWN | 0 (PASS) |
| Report name conflicts | One `report_id` with several names | 0 (PASS) |
| Uneven snapshot counts | Every report has the same number of snapshots | PASS (all 20) |

These pass on this file but are there for the next one: unit tests feed deliberately broken rows
(`"abc"` views, negative AWS cost, unknown status, renamed reports, duplicates) and check each is
flagged, not dropped and not crashing.

---

## 6. Recommendations for the data producer

1. **Add a snapshot timestamp** (`snapshot_date`) so ordering does not depend on file order.
2. **Use real nulls** for missing owners instead of the strings `nan` and `ORPHANED_REPORT`, and
   separate *accountable owner* from *last editor*. The owner changes almost every month today.
3. **Separate billing adjustments** (negative credits) from usage, for example in their own table
   with a reason code.
4. **Define the `UNKNOWN` refresh status** and fix the monitoring gap that produces it.
5. **Validate at source** that `concurrent_user_peak ≤ monthly_active_views`.
6. **Tag workloads** (`QUERY_TAG = 'report:<id>'` in Snowflake, a `report_id` resource tag in AWS) so
   cost can be attributed from `ACCOUNT_USAGE` and the AWS Cost and Usage Report directly (see `sql/03`).
