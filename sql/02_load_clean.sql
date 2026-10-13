-- =====================================================================
-- 02_load_clean.sql  |  Load the CSV, then type, validate and flag it
-- ---------------------------------------------------------------------
-- Same rules as backend/src/loadData.js (a test checks they agree):
--   * rows are never dropped; every problem becomes a FLAG_* column
--   * 'nan' / empty / 'ORPHANED_REPORT' owners -> OWNER_EMAIL = NULL
--   * negative credits are kept in CREDITS_CONSUMED but BILLABLE_CREDITS
--     is NULL, so they are excluded from every cost total
--   * load time > 15 s = WARNING, > 30 s = CRITICAL (strictly greater)
--   * file order is chronological: the k-th row of a report is snapshot k
-- =====================================================================

-- ---------------------------------------------------------------------
-- Step 1: land the file in RAW (Snowflake).
-- Before running this script, upload the CSV to the stage created in 01:
--   PUT file://data/Case_Study_3_Pure_Insights_Monitoring.csv @RAW.MONITORING_STAGE AUTO_COMPRESS=TRUE
-- The local test harness loads the same rows with plain INSERTs instead.
-- ---------------------------------------------------------------------
-- @snowflake-only begin
TRUNCATE TABLE RAW.REPORT_MONITORING;

COPY INTO RAW.REPORT_MONITORING
FROM (
    SELECT METADATA$FILE_ROW_NUMBER, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
    FROM @RAW.MONITORING_STAGE
)
ON_ERROR = ABORT_STATEMENT;
-- @snowflake-only end

-- ---------------------------------------------------------------------
-- Step 2: RAW -> ANALYTICS.REPORT_SNAPSHOTS (typed + flagged).
-- The inner query types the values; the outer query derives flags.
-- ---------------------------------------------------------------------
DELETE FROM ANALYTICS.REPORT_SNAPSHOTS;

INSERT INTO ANALYTICS.REPORT_SNAPSHOTS
SELECT
    t.SNAPSHOT_ID,
    t.SNAPSHOT_SEQ,
    p.PERIOD_START,
    p.PERIOD_LABEL,
    t.REPORT_ID,
    t.REPORT_NAME,
    t.OWNER_EMAIL_RAW,
    CASE WHEN t.OWNER_STATUS = 'VALID' THEN LOWER(t.OWNER_EMAIL_RAW) END            AS OWNER_EMAIL,
    t.OWNER_STATUS,
    t.LAST_REFRESH_STATUS,
    t.MONTHLY_ACTIVE_VIEWS,
    t.CREDITS_CONSUMED,
    CASE WHEN t.CREDITS_CONSUMED >= 0 THEN t.CREDITS_CONSUMED END                   AS BILLABLE_CREDITS,
    t.AVG_LOAD_TIME_SEC,
    CASE
        WHEN t.AVG_LOAD_TIME_SEC IS NULL                  THEN NULL
        WHEN t.AVG_LOAD_TIME_SEC > s.LATENCY_CRITICAL_SEC THEN 'CRITICAL'
        WHEN t.AVG_LOAD_TIME_SEC > s.LATENCY_WARNING_SEC  THEN 'WARNING'
        ELSE 'OK'
    END                                                                               AS LATENCY_BAND,
    t.AWS_HOSTING_COST_USD,
    t.QUERY_COUNT_LAST_30D,
    t.CONCURRENT_USER_PEAK,
    t.OWNER_STATUS = 'MISSING'                                                        AS FLAG_MISSING_OWNER,
    t.OWNER_STATUS = 'ORPHANED'                                                       AS FLAG_ORPHANED_SENTINEL,
    COALESCE(t.CREDITS_CONSUMED < 0, FALSE)                                           AS FLAG_NEGATIVE_CREDITS,
    t.LAST_REFRESH_STATUS IN ('FAILED', 'TIMED_OUT')                                  AS FLAG_REFRESH_FAILED,
    t.LAST_REFRESH_STATUS NOT IN ('SUCCESS', 'FAILED', 'TIMED_OUT')                   AS FLAG_REFRESH_UNKNOWN,
    COALESCE(t.MONTHLY_ACTIVE_VIEWS = 0, FALSE)                                       AS FLAG_ZERO_VIEWS,
    COALESCE(t.CONCURRENT_USER_PEAK > t.MONTHLY_ACTIVE_VIEWS, FALSE)                  AS FLAG_USERS_EXCEED_VIEWS,
    (t.MONTHLY_ACTIVE_VIEWS IS NULL OR t.MONTHLY_ACTIVE_VIEWS < 0
        OR t.CREDITS_CONSUMED IS NULL
        OR t.AVG_LOAD_TIME_SEC IS NULL OR t.AVG_LOAD_TIME_SEC < 0
        OR t.AWS_HOSTING_COST_USD IS NULL OR t.AWS_HOSTING_COST_USD < 0
        OR t.QUERY_COUNT_LAST_30D IS NULL OR t.QUERY_COUNT_LAST_30D < 0
        OR t.CONCURRENT_USER_PEAK IS NULL OR t.CONCURRENT_USER_PEAK < 0)               AS FLAG_INVALID_VALUE,
    -- Human-readable list of flags (portable: no array functions needed).
    RTRIM(
           CASE WHEN t.OWNER_STATUS = 'MISSING' THEN 'MISSING_OWNER,' ELSE '' END
        || CASE WHEN t.OWNER_STATUS = 'ORPHANED' THEN 'ORPHANED_OWNER_SENTINEL,' ELSE '' END
        || CASE WHEN t.OWNER_STATUS = 'INVALID' THEN 'INVALID_OWNER_EMAIL,' ELSE '' END
        || CASE WHEN t.CREDITS_CONSUMED < 0 THEN 'NEGATIVE_CREDITS,' ELSE '' END
        || CASE WHEN t.AVG_LOAD_TIME_SEC > s.LATENCY_CRITICAL_SEC THEN 'LATENCY_BREACH_CRITICAL,'
                WHEN t.AVG_LOAD_TIME_SEC > s.LATENCY_WARNING_SEC THEN 'LATENCY_BREACH_WARNING,' ELSE '' END
        || CASE WHEN t.LAST_REFRESH_STATUS = 'FAILED' THEN 'REFRESH_FAILED,'
                WHEN t.LAST_REFRESH_STATUS = 'TIMED_OUT' THEN 'REFRESH_TIMED_OUT,'
                WHEN t.LAST_REFRESH_STATUS = 'UNKNOWN' THEN 'REFRESH_STATUS_UNKNOWN,'
                WHEN t.LAST_REFRESH_STATUS <> 'SUCCESS' THEN 'UNRECOGNIZED_REFRESH_STATUS,' ELSE '' END
        || CASE WHEN t.MONTHLY_ACTIVE_VIEWS = 0 THEN 'ZERO_VIEWS,' ELSE '' END
        || CASE WHEN t.CONCURRENT_USER_PEAK > t.MONTHLY_ACTIVE_VIEWS THEN 'CONCURRENT_USERS_EXCEED_VIEWS,' ELSE '' END,
        ',')                                                                          AS ANOMALY_FLAGS,
    CURRENT_TIMESTAMP                                                                 AS LOADED_AT
FROM (
    SELECT
        FILE_ROW_NUMBER                                                   AS SNAPSHOT_ID,
        UPPER(TRIM(REPORT_ID))                                            AS REPORT_ID,
        TRIM(REPORT_NAME)                                                 AS REPORT_NAME,
        TRIM(OWNER_EMAIL)                                                 AS OWNER_EMAIL_RAW,
        CASE
            WHEN OWNER_EMAIL IS NULL
              OR LOWER(TRIM(OWNER_EMAIL)) IN ('', 'nan', 'null', 'none', 'n/a', 'na') THEN 'MISSING'
            WHEN UPPER(TRIM(OWNER_EMAIL)) = 'ORPHANED_REPORT'                       THEN 'ORPHANED'
            WHEN TRIM(OWNER_EMAIL) LIKE '%_@_%._%'                                  THEN 'VALID'
            ELSE 'INVALID'
        END                                                               AS OWNER_STATUS,
        UPPER(TRIM(LAST_REFRESH_STATUS))                                  AS LAST_REFRESH_STATUS,
        TRY_CAST(MONTHLY_ACTIVE_VIEWS AS INTEGER)                         AS MONTHLY_ACTIVE_VIEWS,
        TRY_CAST(SNOWFLAKE_CREDITS_CONSUMED AS DECIMAL(12, 2))            AS CREDITS_CONSUMED,
        TRY_CAST(AVG_LOAD_TIME_SEC AS DECIMAL(6, 1))                      AS AVG_LOAD_TIME_SEC,
        TRY_CAST(AWS_HOSTING_COST_USD AS DECIMAL(12, 2))                  AS AWS_HOSTING_COST_USD,
        TRY_CAST(QUERY_COUNT_LAST_30D AS INTEGER)                         AS QUERY_COUNT_LAST_30D,
        TRY_CAST(CONCURRENT_USER_PEAK AS INTEGER)                         AS CONCURRENT_USER_PEAK,
        -- No timestamp in the data: order of appearance in the file = time order.
        ROW_NUMBER() OVER (PARTITION BY UPPER(TRIM(REPORT_ID)) ORDER BY FILE_ROW_NUMBER) AS SNAPSHOT_SEQ
    FROM RAW.REPORT_MONITORING
) t
CROSS JOIN ANALYTICS.SETTINGS s
LEFT JOIN ANALYTICS.REPORTING_PERIODS p
    ON p.SNAPSHOT_SEQ = t.SNAPSHOT_SEQ;

-- ---------------------------------------------------------------------
-- Step 3: load reconciliation. Every RAW row must reach the clean table.
-- Expected: RAW_ROWS = CLEAN_ROWS = 2000, ROWS_WITHOUT_PERIOD = 0.
-- ---------------------------------------------------------------------
SELECT
    (SELECT COUNT(*) FROM RAW.REPORT_MONITORING)                                AS RAW_ROWS,
    (SELECT COUNT(*) FROM ANALYTICS.REPORT_SNAPSHOTS)                           AS CLEAN_ROWS,
    (SELECT COUNT(*) FROM ANALYTICS.REPORT_SNAPSHOTS WHERE PERIOD_START IS NULL) AS ROWS_WITHOUT_PERIOD;
