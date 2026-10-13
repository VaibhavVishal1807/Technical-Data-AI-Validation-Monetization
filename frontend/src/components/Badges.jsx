/**
 * Status badges. "Soft" style: a 12% tint of the status colour behind text in
 * that colour. Every badge also carries a text label, so the meaning never
 * depends on colour alone.
 */
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const TONE = {
  critical: 'bg-critical/12 text-critical',
  warning: 'bg-warning/12 text-warning',
  ok: 'bg-ok/12 text-ok',
  unknown: 'bg-unknown/12 text-unknown',
};

/** A soft status badge. tone: critical | warning | ok | unknown. */
export function StatusBadge({ tone = 'unknown', className, children, ...props }) {
  return (
    <Badge variant="soft" className={cn('rounded-md', TONE[tone], className)} {...props}>
      {children}
    </Badge>
  );
}

/** A neutral outline badge for tags such as anomaly flags or permissions. */
export function TagBadge({ className, children, ...props }) {
  return (
    <Badge variant="outline" className={cn('rounded-md text-muted-foreground', className)} {...props}>
      {children}
    </Badge>
  );
}

const SEVERITY = {
  CRITICAL: { tone: 'critical', label: 'Critical' },
  WARNING: { tone: 'warning', label: 'Warning' },
  INFO: { tone: 'ok', label: 'Info' }, // INFO alerts are recoveries: good news
};

const REFRESH = {
  SUCCESS: { tone: 'ok', label: 'Success' },
  FAILED: { tone: 'critical', label: 'Failed' },
  TIMED_OUT: { tone: 'critical', label: 'Timed out' },
  UNKNOWN: { tone: 'unknown', label: 'Unknown' },
};

const BAND = {
  OK: { tone: 'ok', label: 'OK (15 s or less)' },
  WARNING: { tone: 'warning', label: 'warning (over 15 s)' },
  CRITICAL: { tone: 'critical', label: 'critical (over 30 s)' },
};

/** The band's short label as a badge, for use next to a big number. */
export function BandLabelBadge({ band }) {
  const label = { OK: 'OK', WARNING: 'Over 15 s', CRITICAL: 'Over 30 s' }[band];
  return <StatusBadge tone={BAND[band]?.tone}>{label || band}</StatusBadge>;
}

/** A coloured dot for a refresh status, next to its text label. */
export function RefreshDot({ status }) {
  const tone = REFRESH[status]?.tone || 'unknown';
  const bg = { critical: 'bg-critical', warning: 'bg-warning', ok: 'bg-ok', unknown: 'bg-unknown' }[tone];
  return <span className={cn('inline-block size-2.5 shrink-0 rounded-full', bg)} aria-hidden="true" />;
}

export function SeverityBadge({ severity }) {
  const spec = SEVERITY[severity];
  return <StatusBadge tone={spec?.tone}>{spec?.label || severity}</StatusBadge>;
}

export function RefreshBadge({ status }) {
  const spec = REFRESH[status];
  return <StatusBadge tone={spec?.tone}>{spec?.label || status || '–'}</StatusBadge>;
}

/** Load time as a badge coloured by its alert band (OK / over 15 s / over 30 s). */
export function BandBadge({ band, seconds }) {
  const spec = BAND[band];
  return (
    <StatusBadge tone={spec?.tone}>
      {seconds !== undefined && seconds !== null ? `${seconds.toFixed(1)} s` : spec?.label}
      {spec && <span className="sr-only">, {spec.label}</span>}
    </StatusBadge>
  );
}

export function OrphanBadge() {
  return <StatusBadge tone="warning">Orphaned</StatusBadge>;
}

export function WasteBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <StatusBadge tone="warning" tabIndex={0} className="cursor-help">Waste</StatusBadge>
      </TooltipTrigger>
      <TooltipContent>Total cost per view is in the top quartile of all reports</TooltipContent>
    </Tooltip>
  );
}

export const ALERT_TYPE_LABEL = {
  LATENCY_BREACH: 'Latency breach',
  REFRESH_FAILURE: 'Refresh failure',
  MONITORING_GAP: 'Monitoring gap',
  RECOVERED: 'Recovered',
};

/** Solid status colours for chart bars (CSS variables from index.css). */
export const STATUS_COLORS = {
  SUCCESS: 'var(--status-ok)',
  FAILED: 'var(--status-critical)',
  TIMED_OUT: 'var(--status-critical)',
  UNKNOWN: 'var(--status-unknown)',
  OK: 'var(--status-ok)',
  WARNING: 'var(--status-warning)',
  CRITICAL: 'var(--status-critical)',
};
export const REFRESH_LABELS = { SUCCESS: 'Success', FAILED: 'Failed', TIMED_OUT: 'Timed out', UNKNOWN: 'Unknown' };
