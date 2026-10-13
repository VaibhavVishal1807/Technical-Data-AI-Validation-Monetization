/** Number formatting helpers used across pages. */

const nf = new Intl.NumberFormat('en-US');

export function fmtNumber(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function fmtInt(value) {
  if (value === null || value === undefined) return '–';
  return nf.format(value);
}

/** $1,234.56 */
export function fmtUsd(value, digits = 2) {
  if (value === null || value === undefined) return '–';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

/** $4.1M, $587.4K: for KPI cards and chart axes. Tables use fmtUsd ($2,450.00). */
export function fmtUsdCompact(value) {
  if (value === null || value === undefined) return '–';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function fmtPct(value, digits = 1) {
  if (value === null || value === undefined) return '–';
  return `${fmtNumber(value, digits)}%`;
}

export function fmtSec(value) {
  if (value === null || value === undefined) return '–';
  return `${fmtNumber(value, 1)} s`;
}

/** "2026-09" -> "Sep 2026" */
export function fmtPeriod(period) {
  if (!period) return '–';
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function fmtTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Full date and time, e.g. for the tooltip behind a relative time. */
export function fmtDateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** "just now", "45 s ago", "2 min ago", "3 h ago", "2 d ago". */
export function fmtRelative(iso, now = Date.now()) {
  if (!iso) return '–';
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
