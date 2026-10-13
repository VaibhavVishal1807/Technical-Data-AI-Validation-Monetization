# Snowflake cost allocation SQL suite

Deliverable 3 of the case study. Four scripts, run in order:

| File | What it does |
|---|---|
| `01_schema.sql` | Schemas `RAW`, `ANALYTICS`, `USAGE_SIM`. Raw landing table, settings (credit price, thresholds), monthly calendar, cleaned snapshot table, and three **simulated source views** shaped like the real feeds: `USAGE_SIM.QUERY_ATTRIBUTION_HISTORY` (Snowflake `ACCOUNT_USAGE`), `PORTAL_REPORT_USAGE` (portal telemetry) and `AWS_HOSTING_COSTS` (AWS billing). |
| `02_load_clean.sql` | Loads the CSV (`COPY INTO` with `METADATA$FILE_ROW_NUMBER` to keep file order), then types, validates and flags every row into `ANALYTICS.REPORT_SNAPSHOTS`. No row is dropped. Ends with a load reconciliation query. |
| `03_cost_allocation.sql` | **Cost attribution.** Joins credits, views and AWS cost per report and month. Negative credits are excluded and counted; cost per active view uses `NULLIF(views, 0)`. Views: `V_REPORT_PERIOD_COST`, `V_REPORT_COST_ALLOCATION`, `V_PLATFORM_COST_BY_PERIOD`. Includes the **production version** on the real `SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY` (by `QUERY_TAG`), with warehouse idle time spread across reports. |
| `04_waste_and_anomalies.sql` | Waste flag (top quartile of cost per view), AWS cost vs usage outliers (Tukey fence), orphaned reports with suggested contact, ownership instability, latency state changes (alert triggers) and a data-quality summary with one row per check. |

## Key rules

```sql
billable_credits = SUM(CASE WHEN credits >= 0 THEN credits ELSE 0 END)   -- negatives excluded
snowflake_usd    = billable_credits * CREDIT_PRICE_USD                    -- $3 assumed (ANALYTICS.SETTINGS)
total_usd        = snowflake_usd + aws_hosting_usd
cost_per_view    = total_usd / NULLIF(SUM(views), 0)                      -- NULL, not an error, for zero views
waste_flag       = cost_per_view >= PERCENTILE_CONT(0.75)                  -- top quartile
```

## Running it

**On Snowflake:** run `01_schema.sql`, upload the CSV to the stage it creates (SnowSQL:
`PUT file://data/Case_Study_3_Pure_Insights_Monitoring.csv @RAW.MONITORING_STAGE`), then run
`02`, `03` and `04` in order.

**Locally, no Snowflake account needed:** the same files run on DuckDB, an embedded SQL engine:

```bash
cd backend
npm run sql      # runs 01-04 and prints totals, top waste, data-quality summary, orphaned reports
npm test         # sql.test.js checks every SQL result against the JavaScript engine
```

Statements between `-- @snowflake-only begin` and `-- @snowflake-only end` (warehouse, stage,
`COPY INTO`, real `ACCOUNT_USAGE` views) need a real account, so the local runner skips them and
loads the CSV with plain `INSERT`s instead. Everything else is written in SQL that both engines
accept: `QUALIFY`, `TRY_CAST`, `PERCENTILE_CONT … WITHIN GROUP`, and `DATE '…'` literals.
Ratios are cast to `DOUBLE` so percentiles keep full precision on both engines.

## What the tests prove

`backend/tests/sql.test.js` runs the suite and asserts that SQL and JavaScript agree on:
the flags and period of all 2,000 snapshots, cost allocation for all 100 reports, the 20 monthly
totals, the waste threshold and the 25 waste reports, the 14 orphaned reports and their suggested
contacts, every data-quality count, and the number of latency alert state changes.
