/**
 * Small building blocks shared by every page: the page header, KPI cards,
 * section cards, tooltips for jargon, and the loading / empty / error states.
 */
import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from 'react';
import { CircleAlert, Inbox, Info, Lock, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { fmtDateTime, fmtRelative } from '../format';

/**
 * The page title lives in the top bar (Layout). PageHead hands its title up
 * through this context and renders the subtitle and page actions in the content.
 */
export const PageTitleContext = createContext(() => {});

export function PageHead({ title, subtitle, children }) {
  const setTitle = useContext(PageTitleContext);
  // useLayoutEffect so the top bar never shows the previous page's title.
  useLayoutEffect(() => {
    setTitle(title);
    return () => setTitle(null);
  }, [title, setTitle]);

  if (!subtitle && !children) return null;
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      {subtitle && <p className="max-w-3xl text-sm text-muted-foreground">{subtitle}</p>}
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** Dotted-underlined text that explains itself in a tooltip (abbreviations, metrics). */
export function Hint({ tip, children, className, underline = true }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn('cursor-help', underline && 'underline decoration-subtle decoration-dotted underline-offset-4', className)}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** A grey info icon with a tooltip, for labels that need a sentence of explanation. */
export function InfoTip({ tip, label = 'More information' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex rounded-sm text-subtle hover:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none" aria-label={label}>
          <Info className="size-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** Responsive grid of KPI cards. */
export function KpiGrid({ children }) {
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(176px,1fr))] gap-4">{children}</div>;
}

/** KPI card: label (12px uppercase), number (30px), caption (12px). */
export function KpiCard({ label, value, caption, hint }) {
  return (
    <Card size="sm" className="gap-2 px-4">
      <div className="flex items-center gap-2">
        <span className="text-label">{label}</span>
        {hint && <InfoTip tip={hint} label={`About ${label}`} />}
      </div>
      <div className="text-[30px] leading-tight font-semibold">{value}</div>
      {caption && <div className="text-xs text-muted-foreground">{caption}</div>}
    </Card>
  );
}

/** Shown in place of a KPI the user's role may not see. */
export function LockedKpi({ label, reason }) {
  return (
    <Card size="sm" className="gap-2 px-4">
      <div className="flex items-center gap-2">
        <span className="text-label">{label}</span>
        <Lock className="size-4 text-subtle" aria-hidden="true" />
      </div>
      <div className="flex min-h-[36px] items-center text-base font-semibold text-muted-foreground">Hidden for your role</div>
      <div className="text-xs text-muted-foreground">{reason}</div>
    </Card>
  );
}

/**
 * A titled card. flush = the body has no side padding (tables run edge to edge).
 */
export function Section({ title, description, action, flush, className, children }) {
  const hasHeader = title || description || action;
  return (
    <Card className={cn(flush && 'gap-0 py-0', className)}>
      {hasHeader && (
        <CardHeader className={cn(flush && 'py-6')}>
          {title && <CardTitle>{title}</CardTitle>}
          {description && <CardDescription>{description}</CardDescription>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      {flush ? <div className={cn(hasHeader && 'border-t border-border')}>{children}</div> : <CardContent>{children}</CardContent>}
    </Card>
  );
}

/** A note box. tone: neutral | warning | critical. */
export function Callout({ tone = 'neutral', icon: IconCmp = Info, children }) {
  const iconColour = { neutral: 'text-muted-foreground', warning: 'text-warning', critical: 'text-critical' }[tone];
  return (
    <div role={tone === 'critical' ? 'alert' : undefined} className="flex gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
      <IconCmp className={cn('mt-0.5 size-4 shrink-0', iconColour)} aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function EmptyState({ children, icon: IconCmp = Inbox }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
      <IconCmp className="size-4 text-subtle" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  if (!error) return null;
  const denied = error.status === 403;
  return (
    <Card role="alert" className="items-center px-6 text-center">
      <CircleAlert className="size-4 text-critical" aria-hidden="true" />
      <div className="grid gap-2">
        <div className="text-base font-semibold">{denied ? 'Access denied' : 'Something went wrong'}</div>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
      {onRetry && !denied && (
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw aria-hidden="true" /> Try again
        </Button>
      )}
    </Card>
  );
}

/* ---------- Loading skeletons ---------- */

export function KpiSkeleton({ count = 4 }) {
  return (
    <KpiGrid>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} size="sm" className="gap-2 px-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-40" />
        </Card>
      ))}
    </KpiGrid>
  );
}

export function BlockSkeleton({ height = 240 }) {
  return (
    <Card className="px-6">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="w-full" style={{ height }} />
    </Card>
  );
}

/** Placeholder rows, for use inside a card that is already on screen. */
export function RowsSkeleton({ rows = 4 }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-4 border-b border-border px-4 last:border-0">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 8 }) {
  return (
    <Card className="gap-0 py-0">
      <div className="flex h-10 items-center border-b border-border px-4"><Skeleton className="h-4 w-1/3" /></div>
      <RowsSkeleton rows={rows} />
    </Card>
  );
}

/** A screen-reader label so a skeleton is not silent. */
function LoadingLabel() {
  return <span className="sr-only" role="status">Loading…</span>;
}

/**
 * Wraps page content: shows a skeleton while loading, an error with a retry
 * button if the request failed, and the content once data is there.
 */
export function PageState({ loading, error, data, reload, skeleton, children }) {
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) {
    return (
      <div className="grid gap-6">
        <LoadingLabel />
        {skeleton || <><KpiSkeleton /><TableSkeleton /></>}
      </div>
    );
  }
  return children;
}

/* ---------- Relative time ("2 min ago") ---------- */

// One shared 15-second clock for every relative time on screen.
let now = Date.now();
let clock = null;
const listeners = new Set();
function subscribe(listener) {
  listeners.add(listener);
  if (!clock) {
    now = Date.now();
    clock = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 15000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(clock);
      clock = null;
    }
  };
}

/** "2 min ago", with the exact date and time in a tooltip. */
export function RelativeTime({ iso, className }) {
  const current = useSyncExternalStore(subscribe, () => now);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={iso} tabIndex={0} className={cn('cursor-default whitespace-nowrap text-xs text-muted-foreground', className)}>
          {fmtRelative(iso, Math.max(current, Date.parse(iso) || 0))}
        </time>
      </TooltipTrigger>
      <TooltipContent>{fmtDateTime(iso)}</TooltipContent>
    </Tooltip>
  );
}
