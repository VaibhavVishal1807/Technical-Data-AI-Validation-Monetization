-- =====================================================================
-- 03_cost_allocation.sql  |  Attribute cloud cost to individual reports
-- ---------------------------------------------------------------------
-- Joins the three sources on (report, month):
--   Snowflake credits  USAGE_SIM.QUERY_ATTRIBUTION_HISTORY (by QUERY_TAG)
--   Active views       USAGE_SIM.PORTAL_REPORT_USAGE
--   AWS hosting        USAGE_SIM.AWS_HOSTING_COSTS
-- and computes the unit cost per active user view.
--
-- Rules (same as backend/src/costs.js; a test checks they agree):
--   billable credits     = SUM(credits) WHERE credits >= 0
--                          (negative credit rows are invalid adjustments:
--                           excluded and counted, never netted off)
--   Snowflake cost (USD) = billable credits x CREDIT_PRICE_USD (assumed $3)
--   total cost (USD)     = Snowflake cost + AWS hosting cost
--   cost per view        = cost / NULLIF(SUM(views), 0)
--                          -> NULL, not an error, when nobody viewed the report;
--                             that spend is reported as ZERO_USAGE_COST_USD
-- Ratios are cast to DOUBLE so percentile maths keeps full precision on
-- every engine.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Cost per report per month
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW ANALYTICS.V_REPORT_PERIOD_COST AS
WITH credits AS (
    SELECT
        REPLACE(q.QUERY_TAG, s.QUERY_TAG_PREFIX, '')                                        AS REPORT_ID,
        q.START_TIME                                                                         AS PERIOD_START,
        SUM(q.QUERY_COUNT)                                                                   AS QUERY_COUNT,
        SUM(CASE WHEN q.CREDITS_ATTRIBUTED_COMPUTE >= 0 THEN q.CREDITS_ATTRIBUTED_COMPUTE ELSE 0 END) AS BILLABLE_CREDITS,
        SUM(CASE WHEN q.CREDITS_ATTRIBUTED_COMPUTE < 0 THEN q.CREDITS_ATTRIBUTED_COMPUTE ELSE 0 END)  AS EXCLUDED_NEGATIVE_CREDITS,
        SUM(CASE WHEN q.CREDITS_ATTRIBUTED_COMPUTE < 0 THEN 1 ELSE 0 END)                    AS EXCLUDED_ROWS
    FROM USAGE_SIM.QUERY_ATTRIBUTION_HISTORY q
    CROSS JOIN ANALYTICS.SETTINGS s
    WHERE q.QUERY_TAG LIKE (s.QUERY_TAG_PREFIX || '%')
    GROUP BY REPLACE(q.QUERY_TAG, s.QUERY_TAG_PREFIX, ''), q.START_TIME
),
portal AS (
    SELECT REPORT_ID, PERIOD_START, SUM(MONTHLY_ACTIVE_VIEWS) AS VIEWS
    FROM USAGE_SIM.PORTAL_REPORT_USAGE
    GROUP BY REPORT_ID, PERIOD_START
),
aws AS (
    SELECT RESOURCE_TAG_REPORT_ID AS REPORT_ID, BILLING_PERIOD_START AS PERIOD_START, SUM(UNBLENDED_COST_USD) AS AWS_COST_USD
    FROM USAGE_SIM.AWS_HOSTING_COSTS
    GROUP BY RESOURCE_TAG_REPORT_ID, BILLING_PERIOD_START
),
-- Every (report, month) seen in ANY source, so no source can silently drop cost.
spine AS (
    SELECT REPORT_ID, PERIOD_START FROM credits
    UNION
    SELECT REPORT_ID, PERIOD_START FROM portal
    UNION
    SELECT REPORT_ID, PERIOD_START FROM aws
)
SELECT
    k.REPORT_ID,
    k.PERIOD_START,
    COALESCE(p.VIEWS, 0)                                                         AS VIEWS,
    COALESCE(c.QUERY_COUNT, 0)                                                   AS QUERY_COUNT,
    COALESCE(c.BILLABLE_CREDITS, 0)                                              AS BILLABLE_CREDITS,
    COALESCE(c.EXCLUDED_NEGATIVE_CREDITS, 0)                                     AS EXCLUDED_NEGATIVE_CREDITS,
    COALESCE(c.EXCLUDED_ROWS, 0)                                                 AS EXCLUDED_ROWS,
    COALESCE(c.BILLABLE_CREDITS, 0) * s.CREDIT_PRICE_USD                         AS SNOWFLAKE_COST_USD,
    COALESCE(a.AWS_COST_USD, 0)                                                  AS AWS_COST_USD,
    COALESCE(c.BILLABLE_CREDITS, 0) * s.CREDIT_PRICE_USD + COALESCE(a.AWS_COST_USD, 0) AS TOTAL_COST_USD,
    CAST(COALESCE(c.BILLABLE_CREDITS, 0) * s.CREDIT_PRICE_USD + COALESCE(a.AWS_COST_USD, 0) AS DOUBLE)
        / NULLIF(p.VIEWS, 0)                                                     AS TOTAL_COST_PER_VIEW_USD,
    COALESCE(p.VIEWS, 0) = 0                                                     AS IS_ZERO_USAGE
FROM spine k
LEFT JOIN credits c ON c.REPORT_ID = k.REPORT_ID AND c.PERIOD_START = k.PERIOD_START
LEFT JOIN portal  p ON p.REPORT_ID = k.REPORT_ID AND p.PERIOD_START = k.PERIOD_START
LEFT JOIN aws     a ON a.REPORT_ID = k.REPORT_ID AND a.PERIOD_START = k.PERIOD_START
CROSS JOIN ANALYTICS.SETTINGS s;

-- ---------------------------------------------------------------------
-- 2) Cost allocation per report (all months): the main deliverable
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW ANALYTICS.V_REPORT_COST_ALLOCATION AS
SELECT
    pc.REPORT_ID,
    COUNT(*)                                                                    AS PERIODS,
    SUM(pc.BILLABLE_CREDITS)                                                    AS BILLABLE_CREDITS,
    SUM(pc.EXCLUDED_NEGATIVE_CREDITS)                                           AS EXCLUDED_NEGATIVE_CREDITS,
    SUM(pc.EXCLUDED_ROWS)                                                       AS EXCLUDED_ROWS,
    SUM(pc.VIEWS)                                                               AS TOTAL_VIEWS,
    SUM(pc.QUERY_COUNT)                                                         AS TOTAL_QUERIES,
    SUM(pc.SNOWFLAKE_COST_USD)                                                  AS SNOWFLAKE_COST_USD,
    SUM(pc.AWS_COST_USD)                                                        AS AWS_COST_USD,
    SUM(pc.TOTAL_COST_USD)                                                      AS TOTAL_COST_USD,
    CAST(SUM(pc.BILLABLE_CREDITS) AS DOUBLE)   / NULLIF(SUM(pc.VIEWS), 0)       AS CREDITS_PER_VIEW,
    CAST(SUM(pc.SNOWFLAKE_COST_USD) AS DOUBLE) / NULLIF(SUM(pc.VIEWS), 0)       AS SNOWFLAKE_COST_PER_VIEW_USD,
    CAST(SUM(pc.AWS_COST_USD) AS DOUBLE)       / NULLIF(SUM(pc.VIEWS), 0)       AS AWS_COST_PER_VIEW_USD,
    CAST(SUM(pc.TOTAL_COST_USD) AS DOUBLE)     / NULLIF(SUM(pc.VIEWS), 0)       AS TOTAL_COST_PER_VIEW_USD,
    SUM(CASE WHEN pc.IS_ZERO_USAGE THEN 1 ELSE 0 END)                           AS ZERO_USAGE_PERIODS,
    SUM(CASE WHEN pc.IS_ZERO_USAGE THEN pc.TOTAL_COST_USD ELSE 0 END)           AS ZERO_USAGE_COST_USD
FROM ANALYTICS.V_REPORT_PERIOD_COST pc
GROUP BY pc.REPORT_ID;

-- ---------------------------------------------------------------------
-- 3) Platform totals per month (trend)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW ANALYTICS.V_PLATFORM_COST_BY_PERIOD AS
SELECT
    pc.PERIOD_START,
    SUM(pc.BILLABLE_CREDITS)                                                    AS BILLABLE_CREDITS,
    SUM(pc.SNOWFLAKE_COST_USD)                                                  AS SNOWFLAKE_COST_USD,
    SUM(pc.AWS_COST_USD)                                                        AS AWS_COST_USD,
    SUM(pc.TOTAL_COST_USD)                                                      AS TOTAL_COST_USD,
    SUM(pc.VIEWS)                                                               AS TOTAL_VIEWS,
    CAST(SUM(pc.TOTAL_COST_USD) AS DOUBLE) / NULLIF(SUM(pc.VIEWS), 0)           AS TOTAL_COST_PER_VIEW_USD,
    SUM(pc.EXCLUDED_ROWS)                                                       AS EXCLUDED_ROWS
FROM ANALYTICS.V_REPORT_PERIOD_COST pc
GROUP BY pc.PERIOD_START;

-- ---------------------------------------------------------------------
-- 4) Example questions answered with the views above
-- ---------------------------------------------------------------------

-- Platform totals: what did the portal cost, and what does one view cost?
SELECT
    ROUND(SUM(BILLABLE_CREDITS), 2)                                             AS BILLABLE_CREDITS,
    ROUND(SUM(EXCLUDED_NEGATIVE_CREDITS), 2)                                    AS EXCLUDED_NEGATIVE_CREDITS,
    ROUND(SUM(SNOWFLAKE_COST_USD), 2)                                           AS SNOWFLAKE_COST_USD,
    ROUND(SUM(AWS_COST_USD), 2)                                                 AS AWS_COST_USD,
    ROUND(SUM(TOTAL_COST_USD), 2)                                               AS TOTAL_COST_USD,
    SUM(TOTAL_VIEWS)                                                            AS TOTAL_VIEWS,
    ROUND(CAST(SUM(TOTAL_COST_USD) AS DOUBLE) / NULLIF(SUM(TOTAL_VIEWS), 0), 4) AS COST_PER_VIEW_USD
FROM ANALYTICS.V_REPORT_COST_ALLOCATION;

-- The 10 reports with the highest unit cost per active view.
SELECT
    REPORT_ID,
    ROUND(TOTAL_COST_USD, 2)            AS TOTAL_COST_USD,
    TOTAL_VIEWS,
    ROUND(TOTAL_COST_PER_VIEW_USD, 4)   AS TOTAL_COST_PER_VIEW_USD,
    ROUND(CREDITS_PER_VIEW, 4)          AS CREDITS_PER_VIEW
FROM ANALYTICS.V_REPORT_COST_ALLOCATION
ORDER BY TOTAL_COST_PER_VIEW_USD DESC NULLS LAST
LIMIT 10;

-- =====================================================================
-- Production version (Snowflake only): the same attribution on the REAL
-- account usage views instead of the simulation.
--
-- Prerequisite: the Node backend tags every query it runs for a report:
--     ALTER SESSION SET QUERY_TAG = 'report:RPT_200';
-- QUERY_ATTRIBUTION_HISTORY then gives credits per query, grouped by tag.
-- Notes: that view lags by up to about 8 hours, skips very short queries,
-- and does not include warehouse idle time. The second view spreads idle
-- credits (metered minus attributed) across reports in proportion to
-- their attributed credits, so report totals reconcile to the bill.
-- =====================================================================
-- @snowflake-only begin
CREATE OR REPLACE VIEW ANALYTICS.V_REPORT_CREDITS_ACCOUNT_USAGE AS
SELECT
    REPLACE(QUERY_TAG, 'report:', '')              AS REPORT_ID,
    WAREHOUSE_NAME,
    DATE_TRUNC('MONTH', START_TIME)::DATE          AS PERIOD_START,
    COUNT(*)                                       AS QUERY_COUNT,
    SUM(CREDITS_ATTRIBUTED_COMPUTE)                AS CREDITS_ATTRIBUTED_COMPUTE,
    SUM(COALESCE(CREDITS_USED_QUERY_ACCELERATION, 0)) AS CREDITS_QUERY_ACCELERATION
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY
WHERE QUERY_TAG LIKE 'report:%'
  AND START_TIME >= DATEADD(MONTH, -20, DATE_TRUNC('MONTH', CURRENT_DATE()))
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW ANALYTICS.V_REPORT_CREDITS_WITH_IDLE AS
WITH warehouse_metered AS (
    SELECT WAREHOUSE_NAME,
           DATE_TRUNC('MONTH', START_TIME)::DATE   AS PERIOD_START,
           SUM(CREDITS_USED_COMPUTE)               AS CREDITS_METERED
    FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
    WHERE START_TIME >= DATEADD(MONTH, -20, DATE_TRUNC('MONTH', CURRENT_DATE()))
    GROUP BY 1, 2
),
warehouse_attributed AS (
    SELECT WAREHOUSE_NAME,
           DATE_TRUNC('MONTH', START_TIME)::DATE   AS PERIOD_START,
           SUM(CREDITS_ATTRIBUTED_COMPUTE)         AS CREDITS_ATTRIBUTED_ALL
    FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY
    WHERE START_TIME >= DATEADD(MONTH, -20, DATE_TRUNC('MONTH', CURRENT_DATE()))
    GROUP BY 1, 2
)
SELECT
    r.REPORT_ID,
    r.WAREHOUSE_NAME,
    r.PERIOD_START,
    r.CREDITS_ATTRIBUTED_COMPUTE,
    GREATEST(m.CREDITS_METERED - w.CREDITS_ATTRIBUTED_ALL, 0)
        * r.CREDITS_ATTRIBUTED_COMPUTE / NULLIF(w.CREDITS_ATTRIBUTED_ALL, 0)      AS IDLE_CREDITS_SHARE,
    r.CREDITS_ATTRIBUTED_COMPUTE
        + COALESCE(GREATEST(m.CREDITS_METERED - w.CREDITS_ATTRIBUTED_ALL, 0)
          * r.CREDITS_ATTRIBUTED_COMPUTE / NULLIF(w.CREDITS_ATTRIBUTED_ALL, 0), 0) AS CREDITS_FULLY_LOADED
FROM ANALYTICS.V_REPORT_CREDITS_ACCOUNT_USAGE r
JOIN warehouse_metered    m ON m.WAREHOUSE_NAME = r.WAREHOUSE_NAME AND m.PERIOD_START = r.PERIOD_START
JOIN warehouse_attributed w ON w.WAREHOUSE_NAME = r.WAREHOUSE_NAME AND w.PERIOD_START = r.PERIOD_START;
-- @snowflake-only end
