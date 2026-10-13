-- =====================================================================
-- 01_schema.sql  |  Pure Insights cost attribution: database objects
-- ---------------------------------------------------------------------
-- Target platform: Snowflake.
-- The same files also run on DuckDB in the test suite
-- (backend/tests/sql.test.js), which checks every number against the
-- JavaScript engine. Statements between "@snowflake-only begin/end"
-- markers are skipped there because they need a real Snowflake account.
--
-- Layers
--   RAW        the CSV exactly as received (all text, so loading never fails)
--   ANALYTICS  typed, validated, flagged snapshots plus settings and calendar
--   USAGE_SIM  simulated SNOWFLAKE.ACCOUNT_USAGE-style logs and the two
--              other sources a real attribution pipeline joins:
--              portal telemetry and AWS billing
-- =====================================================================

-- @snowflake-only begin
CREATE DATABASE IF NOT EXISTS PURE_INSIGHTS;
USE DATABASE PURE_INSIGHTS;
CREATE WAREHOUSE IF NOT EXISTS ADMIN_WH
    WAREHOUSE_SIZE = 'XSMALL' AUTO_SUSPEND = 60 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE;
USE WAREHOUSE ADMIN_WH;
-- @snowflake-only end

CREATE SCHEMA IF NOT EXISTS RAW;
CREATE SCHEMA IF NOT EXISTS ANALYTICS;
CREATE SCHEMA IF NOT EXISTS USAGE_SIM;

-- ---------------------------------------------------------------------
-- RAW landing table: one row per CSV line, every value kept as text.
-- FILE_ROW_NUMBER preserves file order, the only ordering signal in the
-- data (there is no timestamp column).
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE RAW.REPORT_MONITORING (
    FILE_ROW_NUMBER             INTEGER NOT NULL,
    REPORT_ID                   VARCHAR,
    REPORT_NAME                 VARCHAR,
    OWNER_EMAIL                 VARCHAR,
    LAST_REFRESH_STATUS         VARCHAR,
    MONTHLY_ACTIVE_VIEWS        VARCHAR,
    SNOWFLAKE_CREDITS_CONSUMED  VARCHAR,
    AVG_LOAD_TIME_SEC           VARCHAR,
    AWS_HOSTING_COST_USD        VARCHAR,
    QUERY_COUNT_LAST_30D        VARCHAR,
    CONCURRENT_USER_PEAK        VARCHAR
);

-- File format and stage for uploading the CSV (PUT), used by 02_load_clean.sql.
-- @snowflake-only begin
CREATE OR REPLACE FILE FORMAT RAW.CSV_WITH_HEADER
    TYPE = CSV
    SKIP_HEADER = 1
    FIELD_OPTIONALLY_ENCLOSED_BY = '"'
    TRIM_SPACE = TRUE;
-- NULL_IF stays at its default ('\N'), so 'nan' arrives as text and the
-- cleaning step in 02 decides what it means.

CREATE OR REPLACE STAGE RAW.MONITORING_STAGE FILE_FORMAT = RAW.CSV_WITH_HEADER;
-- @snowflake-only end

-- ---------------------------------------------------------------------
-- Settings: every assumption in one row, so no query hides a magic number.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE ANALYTICS.SETTINGS (
    CREDIT_PRICE_USD      DECIMAL(10, 2),  -- assumed $ per Snowflake credit
    LATENCY_WARNING_SEC   DECIMAL(6, 1),   -- brief: alert when load time exceeds 15 s
    LATENCY_CRITICAL_SEC  DECIMAL(6, 1),   -- severity split: above 30 s is critical
    QUERY_TAG_PREFIX      VARCHAR          -- portal tags each report's queries 'report:<id>'
);
INSERT INTO ANALYTICS.SETTINGS VALUES (3.00, 15.0, 30.0, 'report:');

-- ---------------------------------------------------------------------
-- Calendar: the k-th snapshot of every report covers month k.
-- The CSV's columns are monthly (monthly_active_views,
-- query_count_last_30d), so one snapshot = one monthly period and
-- periods can be added up without double counting.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE ANALYTICS.REPORTING_PERIODS (
    SNAPSHOT_SEQ  INTEGER,
    PERIOD_START  DATE,
    PERIOD_LABEL  VARCHAR
);
INSERT INTO ANALYTICS.REPORTING_PERIODS VALUES
    ( 1, DATE '2025-02-01', '2025-02'), ( 2, DATE '2025-03-01', '2025-03'),
    ( 3, DATE '2025-04-01', '2025-04'), ( 4, DATE '2025-05-01', '2025-05'),
    ( 5, DATE '2025-06-01', '2025-06'), ( 6, DATE '2025-07-01', '2025-07'),
    ( 7, DATE '2025-08-01', '2025-08'), ( 8, DATE '2025-09-01', '2025-09'),
    ( 9, DATE '2025-10-01', '2025-10'), (10, DATE '2025-11-01', '2025-11'),
    (11, DATE '2025-12-01', '2025-12'), (12, DATE '2026-01-01', '2026-01'),
    (13, DATE '2026-02-01', '2026-02'), (14, DATE '2026-03-01', '2026-03'),
    (15, DATE '2026-04-01', '2026-04'), (16, DATE '2026-05-01', '2026-05'),
    (17, DATE '2026-06-01', '2026-06'), (18, DATE '2026-07-01', '2026-07'),
    (19, DATE '2026-08-01', '2026-08'), (20, DATE '2026-09-01', '2026-09');

-- ---------------------------------------------------------------------
-- Cleaned snapshots: typed values plus one boolean per anomaly.
-- Filled by 02_load_clean.sql. No row is ever dropped.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE ANALYTICS.REPORT_SNAPSHOTS (
    SNAPSHOT_ID               INTEGER,         -- = RAW.FILE_ROW_NUMBER
    SNAPSHOT_SEQ              INTEGER,         -- 1..20 within the report
    PERIOD_START              DATE,
    PERIOD_LABEL              VARCHAR,
    REPORT_ID                 VARCHAR,
    REPORT_NAME               VARCHAR,
    OWNER_EMAIL_RAW           VARCHAR,
    OWNER_EMAIL               VARCHAR,         -- NULL unless a valid email
    OWNER_STATUS              VARCHAR,         -- VALID | MISSING | ORPHANED | INVALID
    LAST_REFRESH_STATUS       VARCHAR,
    MONTHLY_ACTIVE_VIEWS      INTEGER,
    CREDITS_CONSUMED          DECIMAL(12, 2),  -- raw value, may be negative
    BILLABLE_CREDITS          DECIMAL(12, 2),  -- NULL when negative (excluded from cost)
    AVG_LOAD_TIME_SEC         DECIMAL(6, 1),
    LATENCY_BAND              VARCHAR,         -- OK | WARNING | CRITICAL
    AWS_HOSTING_COST_USD      DECIMAL(12, 2),
    QUERY_COUNT_LAST_30D      INTEGER,
    CONCURRENT_USER_PEAK      INTEGER,
    FLAG_MISSING_OWNER        BOOLEAN,
    FLAG_ORPHANED_SENTINEL    BOOLEAN,
    FLAG_NEGATIVE_CREDITS     BOOLEAN,
    FLAG_REFRESH_FAILED       BOOLEAN,         -- FAILED or TIMED_OUT
    FLAG_REFRESH_UNKNOWN      BOOLEAN,
    FLAG_ZERO_VIEWS           BOOLEAN,
    FLAG_USERS_EXCEED_VIEWS   BOOLEAN,         -- concurrent peak > monthly views (impossible)
    FLAG_INVALID_VALUE        BOOLEAN,         -- unparseable or out-of-range number
    ANOMALY_FLAGS             VARCHAR,         -- comma-separated list, for humans
    LOADED_AT                 TIMESTAMP
);

-- =====================================================================
-- Simulated source systems. In production these three views are replaced
-- by the real feeds (see the @snowflake-only section of 03):
--   1. SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY, grouped by QUERY_TAG
--   2. portal telemetry (views, users, load time, refresh status)
--   3. AWS Cost and Usage Report, filtered by a report_id resource tag
-- Credits here are the raw log values, negatives included: the
-- attribution queries must filter them, as they would with real logs.
-- =====================================================================

CREATE OR REPLACE VIEW USAGE_SIM.QUERY_ATTRIBUTION_HISTORY AS
SELECT
    s.QUERY_TAG_PREFIX || r.REPORT_ID  AS QUERY_TAG,
    'PORTAL_WH'                        AS WAREHOUSE_NAME,
    r.PERIOD_START                     AS START_TIME,
    r.QUERY_COUNT_LAST_30D             AS QUERY_COUNT,
    r.CREDITS_CONSUMED                 AS CREDITS_ATTRIBUTED_COMPUTE
FROM ANALYTICS.REPORT_SNAPSHOTS r
CROSS JOIN ANALYTICS.SETTINGS s;

CREATE OR REPLACE VIEW USAGE_SIM.PORTAL_REPORT_USAGE AS
SELECT
    REPORT_ID,
    REPORT_NAME,
    PERIOD_START,
    MONTHLY_ACTIVE_VIEWS,
    CONCURRENT_USER_PEAK,
    AVG_LOAD_TIME_SEC,
    LAST_REFRESH_STATUS,
    OWNER_EMAIL
FROM ANALYTICS.REPORT_SNAPSHOTS;

CREATE OR REPLACE VIEW USAGE_SIM.AWS_HOSTING_COSTS AS
SELECT
    REPORT_ID              AS RESOURCE_TAG_REPORT_ID,
    PERIOD_START           AS BILLING_PERIOD_START,
    AWS_HOSTING_COST_USD   AS UNBLENDED_COST_USD
FROM ANALYTICS.REPORT_SNAPSHOTS;
