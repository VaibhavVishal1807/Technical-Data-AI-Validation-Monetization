/**
 * The app frame after login: a vertical floating dock for navigation (a
 * bottom tab bar on phones), a 56px top bar (page title, live replay status,
 * alert counts, user menu) and the pop-up alerts (Sonner toasts, bottom-right).
 * The dock only lists pages the user's role may open; the backend still
 * refuses the API calls behind the hidden pages.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import {
  BellRing, ChartColumn, ChevronDown, CircleDollarSign, LayoutDashboard, LogOut, ShieldCheck, UserX, Users, X,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useAuth } from '../auth';
import { useAlertStream } from '../alertStream';
import { fmtInt, fmtPeriod } from '../format';
import { SeverityBadge, StatusBadge, TagBadge } from './Badges';
import { PageTitleContext } from './Common';
import { FloatingDock, MobileDock } from './FloatingDock';

// title: dock label; short: label under the icon in the phone tab bar.
export const NAV = [
  { to: '/', title: 'Overview', short: 'Home', icon: LayoutDashboard, permission: 'health:read', end: true },
  { to: '/alerts', title: 'Live Alerts', short: 'Alerts', icon: BellRing, permission: 'alerts:read' },
  { to: '/reports', title: 'Reports', short: 'Reports', icon: ChartColumn, permission: 'reports:read' },
  { to: '/orphaned', title: 'Orphaned', short: 'Orphans', icon: UserX, permission: 'reports:read' },
  { to: '/costs', title: 'Costs', short: 'Costs', icon: CircleDollarSign, permission: 'costs:read' },
  { to: '/data-quality', title: 'Data Quality', short: 'Quality', icon: ShieldCheck, permission: 'dataquality:read' },
  { to: '/users', title: 'Users', short: 'Users', icon: Users, permission: 'users:read' },
];

function isActive(item, pathname) {
  return item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/** Title shown until (or unless) the page sets its own through PageHead. */
function routeTitle(pathname) {
  if (pathname.startsWith('/reports/')) return 'Report';
  return NAV.find((item) => isActive(item, pathname))?.title || '';
}

function initials(name) {
  return name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

/* ---------- Top bar ---------- */

function ReplayStatus() {
  const { status, replay } = useAlertStream();
  const label = { open: 'Live', connecting: 'Connecting…', closed: 'Disconnected, retrying' }[status];
  const dot = { open: 'bg-ok', connecting: 'bg-warning', closed: 'bg-critical' }[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div tabIndex={0} className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">
          <span className={cn('size-2 rounded-full', dot)} aria-hidden="true" />
          <span className="font-medium text-foreground">{label}</span>
          {replay && (
            <span className="hidden items-center gap-2 lg:inline-flex">
              <span className="hidden 2xl:inline">
                Replay {replay.state}
                {replay.current_period && ` · ${fmtPeriod(replay.current_period)}`}
              </span>
              <span className="h-1 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <span className="block h-full bg-muted-foreground" style={{ width: `${replay.progress_pct}%` }} />
              </span>
              <span>{fmtInt(replay.position)}/{fmtInt(replay.total)}</span>
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        Alert stream over WebSocket (/ws/alerts).
        {replay && ` Replay ${replay.state}: row ${fmtInt(replay.position)} of ${fmtInt(replay.total)}`}
        {replay?.current_period && `, data month ${fmtPeriod(replay.current_period)}.`}
      </TooltipContent>
    </Tooltip>
  );
}

function AlertCounts() {
  const { activeSummary } = useAlertStream();
  if (!activeSummary) return null;
  return (
    <Link to="/alerts" className="hidden items-center gap-2 rounded-md sm:flex focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none" aria-label="Active alerts, open Live Alerts">
      <span className="hidden text-xs whitespace-nowrap text-muted-foreground 2xl:inline">Active alerts</span>
      <StatusBadge tone="critical">{fmtInt(activeSummary.by_severity.CRITICAL || 0)} critical</StatusBadge>
      <StatusBadge tone="warning">{fmtInt(activeSummary.by_severity.WARNING || 0)} warning</StatusBadge>
    </Link>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const { muted, toggleMute } = useAlertStream();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 gap-2 px-2" aria-label={`Signed in as ${user.name}, role ${user.role}. Open user menu`}>
          <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-medium" aria-hidden="true">
            {initials(user.name)}
          </span>
          <span className="hidden text-sm font-medium whitespace-nowrap xl:inline">{user.name}</span>
          <TagBadge className="hidden sm:inline-flex">{user.role}</TagBadge>
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="text-sm font-medium text-foreground">{user.name}</div>
          <div className="text-xs text-muted-foreground">Role: {user.role}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={!muted} onCheckedChange={toggleMute}>
          Pop-ups for critical alerts
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => logout()}>
          <LogOut aria-hidden="true" /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TopBar({ title }) {
  return (
    // Sticky, and painted with the same fixed background as the page so the glow runs through it.
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border px-4 [background:var(--app-glow)_fixed,var(--background)] md:gap-4 md:px-6">
      <h1 className="min-w-0 truncate text-2xl leading-[1.2] font-semibold">{title}</h1>
      <div className="ml-auto flex items-center gap-2 md:shrink-0 md:gap-4">
        <ReplayStatus />
        <AlertCounts />
        <UserMenu />
      </div>
    </header>
  );
}

/* ---------- Pop-up alerts ---------- */

function AlertToast({ alert, onDismiss }) {
  const line = `${alert.report_name}: ${alert.message}`;
  return (
    <div role="alert" className="flex w-[356px] max-w-[calc(100vw-32px)] items-start gap-2 rounded-lg border border-border bg-card p-4 shadow-lg">
      <div className="grid min-w-0 flex-1 gap-2">
        <div className="flex items-center gap-2">
          <SeverityBadge severity={alert.severity} />
          <span className="font-mono text-xs font-medium">{alert.report_id}</span>
        </div>
        <p className="truncate text-sm" title={line}>{line}</p>
        {alert.more > 0 && (
          <p className="text-xs text-muted-foreground">
            +{alert.more} more critical alert{alert.more === 1 ? '' : 's'}. See Live Alerts.
          </p>
        )}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The alert stream decides which pop-ups exist (critical only, coalesced,
 * 6 s each, at most 3); this mirrors that list into Sonner.
 */
function AlertToasts() {
  const { toasts, dismissToast } = useAlertStream();
  const shown = useRef(new Set());

  useEffect(() => {
    const ids = new Set(toasts.map((t) => t.id));
    shown.current.forEach((id) => {
      if (!ids.has(id)) {
        toast.dismiss(id);
        shown.current.delete(id);
      }
    });
    toasts.forEach((t) => {
      toast.custom(() => <AlertToast alert={t} onDismiss={() => dismissToast(t.id)} />, {
        id: t.id,
        duration: Infinity, // the alert stream's own 6 s timer removes it
        onDismiss: () => dismissToast(t.id), // swiped away
      });
      shown.current.add(t.id);
    });
  }, [toasts, dismissToast]);

  // Clear pop-ups on logout.
  useEffect(() => {
    const ids = shown.current;
    return () => ids.forEach((id) => toast.dismiss(id));
  }, []);

  return null;
}

/* ---------- Frame ---------- */

export default function Layout() {
  const { can } = useAuth();
  const { pathname } = useLocation();
  const items = NAV.filter((item) => can(item.permission));
  const [pageTitle, setPageTitle] = useState(null);
  const setTitle = useCallback((t) => setPageTitle(t), []);
  const title = pageTitle ?? routeTitle(pathname);

  useLayoutEffect(() => {
    document.title = title ? `${title} · Pure Insights Command Center` : 'Pure Insights Command Center';
  }, [title]);

  return (
    // Desktop: a 96px rail (logo + floating dock) beside the page. Under 900px
    // the rail is hidden and MobileDock is a tab bar at the bottom instead.
    <div className="grid min-h-svh grid-cols-1 min-[900px]:grid-cols-[96px_minmax(0,1fr)]">
      <aside className="rail">
        <Link to="/" className="rail-brand" aria-label="Pure Insights Command Center, home">
          <img src="/favicon.svg" alt="" />
        </Link>
        <FloatingDock items={items} />
      </aside>
      <div className="flex min-w-0 flex-col">
        <TopBar title={title} />
        <main className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 pt-6 pb-[104px] md:px-8 md:pt-8 min-[900px]:pb-8">
          <PageTitleContext.Provider value={setTitle}>
            <Outlet />
          </PageTitleContext.Provider>
        </main>
      </div>
      <MobileDock items={items} />
      <Toaster position="bottom-right" visibleToasts={3} />
      <AlertToasts />
    </div>
  );
}
