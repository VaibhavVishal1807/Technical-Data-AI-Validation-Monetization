-- =====================================================================
-- 04_waste_and_anomalies.sql  |  Waste, discrepancies, ownership, alerts
-- ---------------------------------------------------------------------
-- Builds on 03. Every view here has a twin in the backend
-- (costs.js, loadData.js, dataQuality.js, alerts/engine.js), and
-- backend/tests/sql.test.js checks that both give the same answers.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Waste: reports whose total cost per active view is in the top
--    quartile (>= 75th percentile). A report with spend but zero views in
--    every month has no cost per view and is waste by definition.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW ANALYTICS.V_COST_WASTE AS
WITH threshold AS (
    SELECT PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY TOTAL_COST_PER_VIEW_USD) AS WASTE_THRESHOLD_USD_PER_VIEW
    FROM ANALYTICS.V_REPORT_COST_ALLOCATION
    WHERE TOTAL_COST_PER_VIEW_USD IS NOT NULL
)
SELECT
    a.REPORT_ID,
    a.TOTAL_COST_USD,
    a.TOTAL_VIEWS,
    a.TOTAL_COST_PER_VIEW_USD,
    t.WASTE_THRESHOLD_USD_PER_VIEW,
    CASE
        WHEN a.TOTAL_COST_PER_VIEW_USD IS NULL THEN a.TOTAL_COST_USD > 0
        ELSE a.TOTAL_COST_PER_VIEW_USD >= t.WASTE_THRESHOLD_USD_PER_VIEW
    END                                                                         AS WASTE_FLAG,
    RANK() OVER (ORDER BY a.TOTAL_COST_PER_VIEW_USD DESC NULLS LAST)            AS COST_PER_VIEW_RANK
FROM ANALYTICS.V_REPORT_COST_ALLOCATION a
CROSS JOIN threshold t;

-- ---------------------------------------------------------------------
-- 2) "Active users vs AWS cost" discrepancy, per snapshot.
--    Tukey's rule: AWS cost per view above Q3 + 1.5 x IQR is an outlier.
--    Zero-view rows have no ratio; they are covered by FLAG_ZERO_VIEWS.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW ANALYTICS.V_AWS_COST_USAGE_OUTLIERS AS
WITH ratios AS (
    SELECT
        SNAPSHOT_ID,
        REPORT_ID,
        PERIOD_LABEL,
        MONTHLY_ACTIVE_VIEWS,
        AWS_HOSTING_COST_USD,
        CAST(AWS_HOSTING_COST_USD AS DOUBLE) / NULLIF(MONTHLY_ACTIVE_VIEWS, 0) AS AWS_COST_PER_VIEW_USD
    FROM ANALYTICS.REPORT_SNAPSHOTS
),
fence AS (
    SELECT
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY AWS_COST_PER_VIEW_USD)     AS Q1,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY AWS_COST_PER_VIEW_USD)     AS Q3
    FROM ratios
    WHERE AWS_COST_PER_VIEW_USD IS NOT NULL
)
SELECT
    r.*,
    f.Q3 + 1.5 * (f.Q3 - f.Q1)                                                  AS UPPER_FENCE_USD_PER_VIEW
FROM ratios r
CROSS JOIN fence f
WHERE r.AWS_COST_PER_VIEW_USD > f.Q3 + 1.5 * (f.Q3 - f.Q1);

-- ---------------------------------------------------------------------
-- 3) Orphaned reports: the LATEST snapshot has no valid owner.
--    Suggested contact = most recent valid owner in the history.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW ANALYTICS.V_ORPHANED_REPORTS AS
WITH latest AS (
    SELECT *
    FROM ANALYTICS.REPORT_SNAPSHOTS
    QUALIFY ROW_NUMBER() OVER (PARTITION BY REPORT_ID ORDER BY SNAPSHOT_SEQ DESC) = 1
),
last_valid_owner AS (
    SELECT REPORT_ID, OWNER_EMAIL, PERIOD_LABEL, SNAPSHOT_SEQ
    FROM ANALYTICS.REPORT_SNAPSHOTS
    WHERE OWNER_STATUS = 'VALID'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY REPORT_ID ORDER BY SNAPSHOT_SEQ DESC) = 1
)
SELECT
    l.REPORT_ID,
    l.REPORT_NAME,
    l.OWNER_STATUS                      AS ORPHAN_REASON,     -- MISSING ('nan') or ORPHANED (sentinel)
    l.OWNER_EMAIL_RAW,
    o.OWNER_EMAIL                       AS SUGGESTED_CONTACT,
    o.PERIOD_LABEL                      AS SUGGESTED_CONTACT_PERIOD,
    l.SNAPSHOT_SEQ - o.SNAPSHOT_SEQ     AS PERIODS_SINCE_VALID_OWNER,
    l.LAST_REFRESH_STATUS,
    l.AVG_LOAD_TIME_SEC,
    w.TOTAL_COST_USD,
    w.WASTE_FLAG
FROM latest l
LEFT JOIN last_valid_owner o ON o.REPORT_ID = l.REPORT_ID
LEFT JOIN ANALYTICS.V_COST_WASTE w ON w.REPORT_ID = l.REPORT_ID
WHERE l.OWNER_EMAIL IS NULL;

-- ---------------------------------------------------------------------
-- 4) Ownership instability: how many different owners each report had.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW ANALYTICS.V_OWNERSHIP_INSTABILITY AS
SELECT
    REPORT_ID,
    COUNT(*)                                                    AS SNAPSHOTS,
    COUNT(DISTINCT OWNER_EMAIL)                                 AS DISTINCT_VALID_OWNERS,
    SUM(CASE WHEN OWNER_EMAIL IS NULL THEN 1 ELSE 0 END)        AS OWNERLESS_SNAPSHOTS
FROM ANALYTICS.REPORT_SNAPSHOTS
GROUP BY REPORT_ID;

-- ---------------------------------------------------------------------
-- 5) Alert triggers, the SQL way: latency state changes per report.
--    A breach alert opens when the band leaves OK and clears when it
--    returns to OK (rows that stay in breach raise nothing new).
--    Refresh alerts need more state (UNKNOWN after FAILED is not a
--    recovery) and the cooldown must remember past notifications, so
--    those live in the real-time engine: backend/src/alerts/engine.js.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW ANALYTICS.V_LATENCY_STATE_CHANGES AS
WITH ordered AS (
    SELECT
        REPORT_ID,
        SNAPSHOT_SEQ,
        PERIOD_LABEL,
        AVG_LOAD_TIME_SEC,
        LATENCY_BAND,
        LAG(LATENCY_BAND) OVER (PARTITION BY REPORT_ID ORDER BY SNAPSHOT_SEQ) AS PREVIOUS_BAND
    FROM ANALYTICS.REPORT_SNAPSHOTS
)
SELECT
    REPORT_ID,
    SNAPSHOT_SEQ,
    PERIOD_LABEL,
    AVG_LOAD_TIME_SEC,
    COALESCE(PREVIOUS_BAND, 'OK')                               AS PREVIOUS_BAND,
    LATENCY_BAND,
    CASE WHEN LATENCY_BAND = 'OK' THEN 'RECOVERED' ELSE 'LATENCY_BREACH' END AS ALERT_TYPE,
    CASE WHEN LATENCY_BAND = 'OK' THEN 'INFO' ELSE LATENCY_BAND END          AS SEVERITY
FROM ordered
WHERE (LATENCY_BAND <> 'OK' AND COALESCE(PREVIOUS_BAND, 'OK') = 'OK')
   OR (LATENCY_BAND = 'OK' AND COALESCE(PREVIOUS_BAND, 'OK') <> 'OK');

-- ---------------------------------------------------------------------
-- 6) Data-quality summary: one row per check, the SQL twin of the
--    Data Quality page. Rows are counted, never deleted.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW ANALYTICS.V_DATA_QUALITY_SUMMARY AS
WITH f AS (
    SELECT
        COUNT(*)                                                             AS N,
        SUM(CASE WHEN FLAG_MISSING_OWNER THEN 1 ELSE 0 END)                  AS MISSING_OWNER,
        SUM(CASE WHEN FLAG_ORPHANED_SENTINEL THEN 1 ELSE 0 END)              AS ORPHANED_SENTINEL,
        SUM(CASE WHEN OWNER_STATUS = 'INVALID' THEN 1 ELSE 0 END)            AS INVALID_OWNER_EMAIL,
        SUM(CASE WHEN FLAG_NEGATIVE_CREDITS THEN 1 ELSE 0 END)               AS NEGATIVE_CREDITS,
        SUM(CASE WHEN FLAG_ZERO_VIEWS THEN 1 ELSE 0 END)                     AS ZERO_VIEWS,
        SUM(CASE WHEN FLAG_USERS_EXCEED_VIEWS THEN 1 ELSE 0 END)             AS USERS_EXCEED_VIEWS,
        SUM(CASE WHEN LATENCY_BAND IN ('WARNING', 'CRITICAL') THEN 1 ELSE 0 END) AS LATENCY_BREACH,
        SUM(CASE WHEN FLAG_REFRESH_FAILED THEN 1 ELSE 0 END)                 AS REFRESH_FAILURE,
        SUM(CASE WHEN LAST_REFRESH_STATUS = 'UNKNOWN' THEN 1 ELSE 0 END)     AS REFRESH_UNKNOWN,
        SUM(CASE WHEN FLAG_INVALID_VALUE THEN 1 ELSE 0 END)                  AS INVALID_VALUE,
        COUNT(DISTINCT REPORT_ID)                                            AS REPORTS
    FROM ANALYTICS.REPORT_SNAPSHOTS
),
dup AS (
    SELECT COALESCE(SUM(COPIES - 1), 0) AS DUPLICATE_ROWS
    FROM (
        SELECT COUNT(*) AS COPIES
        FROM RAW.REPORT_MONITORING
        GROUP BY REPORT_ID, REPORT_NAME, OWNER_EMAIL, LAST_REFRESH_STATUS, MONTHLY_ACTIVE_VIEWS,
                 SNOWFLAKE_CREDITS_CONSUMED, AVG_LOAD_TIME_SEC, AWS_HOSTING_COST_USD,
                 QUERY_COUNT_LAST_30D, CONCURRENT_USER_PEAK
        HAVING COUNT(*) > 1
    ) d
),
outliers AS (SELECT COUNT(*) AS N FROM ANALYTICS.V_AWS_COST_USAGE_OUTLIERS),
orphans  AS (SELECT COUNT(*) AS N FROM ANALYTICS.V_ORPHANED_REPORTS),
unstable AS (SELECT COUNT(*) AS N FROM ANALYTICS.V_OWNERSHIP_INSTABILITY WHERE DISTINCT_VALID_OWNERS > 1)
SELECT 'MISSING_OWNER' AS CHECK_ID, 'row' AS CHECK_LEVEL, f.MISSING_OWNER AS AFFECTED, f.N AS TOTAL FROM f
UNION ALL SELECT 'ORPHANED_OWNER_SENTINEL', 'row', f.ORPHANED_SENTINEL, f.N FROM f
UNION ALL SELECT 'INVALID_OWNER_EMAIL', 'row', f.INVALID_OWNER_EMAIL, f.N FROM f
UNION ALL SELECT 'NEGATIVE_CREDITS', 'row', f.NEGATIVE_CREDITS, f.N FROM f
UNION ALL SELECT 'ZERO_VIEWS', 'row', f.ZERO_VIEWS, f.N FROM f
UNION ALL SELECT 'CONCURRENT_USERS_EXCEED_VIEWS', 'row', f.USERS_EXCEED_VIEWS, f.N FROM f
UNION ALL SELECT 'AWS_COST_USAGE_OUTLIER', 'row', outliers.N, f.N FROM f CROSS JOIN outliers
UNION ALL SELECT 'LATENCY_BREACH', 'row', f.LATENCY_BREACH, f.N FROM f
UNION ALL SELECT 'REFRESH_FAILURE', 'row', f.REFRESH_FAILURE, f.N FROM f
UNION ALL SELECT 'REFRESH_STATUS_UNKNOWN', 'row', f.REFRESH_UNKNOWN, f.N FROM f
UNION ALL SELECT 'INVALID_VALUE', 'row', f.INVALID_VALUE, f.N FROM f
UNION ALL SELECT 'DUPLICATE_ROW', 'row', dup.DUPLICATE_ROWS, f.N FROM f CROSS JOIN dup
UNION ALL SELECT 'ORPHANED_REPORTS', 'report', orphans.N, f.REPORTS FROM f CROSS JOIN orphans
UNION ALL SELECT 'OWNERSHIP_UNSTABLE', 'report', unstable.N, f.REPORTS FROM f CROSS JOIN unstable;

-- ---------------------------------------------------------------------
-- 7) Example questions
-- ---------------------------------------------------------------------

-- Every data-quality check, with the share of rows affected.
SELECT CHECK_ID, CHECK_LEVEL, AFFECTED, TOTAL, ROUND(100.0 * AFFECTED / NULLIF(TOTAL, 0), 2) AS PCT
FROM ANALYTICS.V_DATA_QUALITY_SUMMARY
ORDER BY CHECK_LEVEL, AFFECTED DESC;

-- Waste shortlist: the top-quartile reports, most expensive per view first.
SELECT REPORT_ID, ROUND(TOTAL_COST_USD, 2) AS TOTAL_COST_USD, TOTAL_VIEWS,
       ROUND(TOTAL_COST_PER_VIEW_USD, 4) AS COST_PER_VIEW_USD, COST_PER_VIEW_RANK
FROM ANALYTICS.V_COST_WASTE
WHERE WASTE_FLAG
ORDER BY COST_PER_VIEW_RANK;

-- Orphaned spend: how much money has no accountable owner?
SELECT COUNT(*) AS ORPHANED_REPORTS, ROUND(SUM(TOTAL_COST_USD), 2) AS ORPHANED_COST_USD
FROM ANALYTICS.V_ORPHANED_REPORTS;
