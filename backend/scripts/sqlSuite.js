/**
 * sqlSuite.js
 * Runs the Snowflake SQL suite (sql/01..04) on DuckDB, an embedded SQL
 * engine, so the SQL deliverable is actually executed and tested instead of
 * only written. Statements between "-- @snowflake-only begin/end" markers
 * need a real Snowflake account (stages, COPY INTO, SNOWFLAKE.ACCOUNT_USAGE)
 * and are skipped. The CSV is loaded into RAW.REPORT_MONITORING with plain
 * INSERTs, which is what COPY INTO does in Snowflake.
 *
 * DuckDB is an optional dependency: if it is not installed, isDuckDbAvailable()
 * returns false and the SQL tests are skipped (the app itself never needs it).
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const SQL_DIR = path.join(__dirname, '..', '..', 'sql');
const SQL_FILES = ['01_schema.sql', '02_load_clean.sql', '03_cost_allocation.sql', '04_waste_and_anomalies.sql'];

function isDuckDbAvailable() {
  try {
    require('@duckdb/node-api');
    return true;
  } catch {
    return false;
  }
}

/** Remove the Snowflake-only blocks. */
function stripSnowflakeOnly(sql) {
  return sql.replace(/--\s*@snowflake-only begin[\s\S]*?--\s*@snowflake-only end/g, '');
}

/** Split a script into statements (each ends with ";" at the end of a line). */
function splitStatements(sql) {
  const withoutComments = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return withoutComments
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Load the CSV into RAW.REPORT_MONITORING, keeping file order. */
async function loadRaw(connection, csvPath) {
  const rows = parse(fs.readFileSync(csvPath, 'utf8'), { bom: true, skip_empty_lines: true, relax_column_count: true });
  const data = rows.slice(1); // drop the header line
  const BATCH = 500;
  for (let start = 0; start < data.length; start += BATCH) {
    const values = data.slice(start, start + BATCH).map((cells, i) => {
      const padded = Array.from({ length: 10 }, (_, c) => (cells[c] === undefined ? 'NULL' : quote(cells[c])));
      return `(${start + i + 1}, ${padded.join(', ')})`;
    });
    await connection.run(`INSERT INTO RAW.REPORT_MONITORING VALUES ${values.join(',\n')}`);
  }
  return data.length;
}

/**
 * Create an in-memory database, run all four scripts and return a helper to
 * query the resulting views. Values come back as plain JSON (DECIMAL and
 * BIGINT as strings, so callers convert with Number()).
 */
async function runSqlSuite(csvPath) {
  const { DuckDBInstance } = require('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const log = [];

  for (const file of SQL_FILES) {
    if (file === '02_load_clean.sql') {
      const loaded = await loadRaw(connection, csvPath);
      log.push(`loaded ${loaded} CSV rows into RAW.REPORT_MONITORING`);
    }
    const statements = splitStatements(stripSnowflakeOnly(fs.readFileSync(path.join(SQL_DIR, file), 'utf8')));
    for (const statement of statements) {
      try {
        await connection.run(statement);
      } catch (err) {
        throw new Error(`${file} failed: ${err.message}\n--- statement ---\n${statement.slice(0, 600)}`);
      }
    }
    log.push(`${file}: ${statements.length} statements OK`);
  }

  async function query(sql) {
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjectsJson();
  }

  function close() {
    connection.closeSync?.();
    instance.closeSync?.();
  }

  return { query, close, log };
}

module.exports = { isDuckDbAvailable, runSqlSuite, splitStatements, stripSnowflakeOnly, SQL_FILES };
