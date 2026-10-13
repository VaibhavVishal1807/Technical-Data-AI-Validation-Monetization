/**
 * stats.js
 * Tiny statistics helpers. Kept dependency-free and written to match the SQL
 * functions used in sql/ so JavaScript and Snowflake give the same numbers.
 */

/** Round to a fixed number of decimals (default 2), leaving null as null. */
function round(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Percentile with linear interpolation between the two nearest values.
 * Same definition as SQL PERCENTILE_CONT(p) WITHIN GROUP (ORDER BY x).
 */
function percentileCont(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = p * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

/** Pearson correlation coefficient between two equal-length number arrays. */
function pearson(xs, ys) {
  const n = xs.length;
  if (n === 0 || n !== ys.length) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let sumSqX = 0;
  let sumSqY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    sumSqX += dx * dx;
    sumSqY += dy * dy;
  }
  if (sumSqX === 0 || sumSqY === 0) return null;
  return num / Math.sqrt(sumSqX * sumSqY);
}

function sum(values) {
  return values.reduce((total, v) => total + (Number.isFinite(v) ? v : 0), 0);
}

module.exports = { round, percentileCont, pearson, sum };
