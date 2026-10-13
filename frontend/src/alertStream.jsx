/**
 * alertStream.jsx
 * One WebSocket connection to /ws/alerts for the whole app, shared through
 * React context. Every page can read the live alert feed, the latest
 * telemetry reading and the replay status from here.
 *
 * Reconnects automatically with exponential backoff (1 s, 2 s, 4 s ... max
 * 10 s) if the connection drops, e.g. when the backend restarts.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './auth';

const AlertStreamContext = createContext(null);
const MAX_FEED = 300;
const MAX_TOASTS = 3;
const TOAST_MS = 6000;
// Critical alerts arriving within this window are folded into the newest
// pop-up ("+3 more") instead of stacking a new one, so pop-ups stay readable.
const COALESCE_MS = 4000;
const MUTE_KEY = 'pi_mute_toasts';

export function AlertStreamProvider({ children }) {
  const { token } = useAuth();
  const [status, setStatus] = useState('connecting'); // connecting | open | closed
  const [feed, setFeed] = useState([]); // newest first
  const [replay, setReplay] = useState(null);
  const [telemetry, setTelemetry] = useState(null);
  const [activeSummary, setActiveSummary] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTE_KEY) === '1');
  const [resetCount, setResetCount] = useState(0); // bumps when the replay resets or loops
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const lastToastAt = useRef(0);
  const toastTimers = useRef({});

  const dismissToast = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  /** (Re)start the auto-dismiss timer for a pop-up. */
  const scheduleDismiss = useCallback((id) => {
    clearTimeout(toastTimers.current[id]);
    toastTimers.current[id] = setTimeout(() => {
      delete toastTimers.current[id];
      dismissToast(id);
    }, TOAST_MS);
  }, [dismissToast]);

  const handleMessage = useCallback((msg) => {
    if (msg.type === 'WELCOME') {
      setFeed(msg.recent_alerts || []);
      setReplay(msg.replay);
      return;
    }
    if (msg.type === 'TELEMETRY') {
      setTelemetry(msg);
      if (msg.active_summary) setActiveSummary(msg.active_summary);
      setReplay((r) => (r ? {
        ...r,
        position: msg.position,
        total: msg.total,
        current_period: msg.period,
        progress_pct: Math.round((msg.position / msg.total) * 1000) / 10,
      } : r));
      return;
    }
    if (msg.type === 'REPLAY_STATE') {
      setReplay(msg.replay);
      if (msg.reason === 'reset') {
        setFeed([]);
        setActiveSummary(null);
      }
      if (msg.reason === 'reset' || msg.reason === 'looped') setResetCount((n) => n + 1);
      return;
    }
    if (msg.kind === 'alert') {
      setFeed((list) => [{ ...msg, _new: true }, ...list].slice(0, MAX_FEED));
      // Pop-up notification for CRITICAL alerts only, so pop-ups stay meaningful.
      if (msg.severity === 'CRITICAL' && !mutedRef.current) {
        const now = Date.now();
        const coalesce = now - lastToastAt.current < COALESCE_MS;
        lastToastAt.current = now;
        setToasts((list) => {
          if (coalesce && list.length > 0) {
            const latest = list[list.length - 1];
            scheduleDismiss(latest.id);
            return [...list.slice(0, -1), { ...latest, more: (latest.more || 0) + 1 }];
          }
          scheduleDismiss(msg.id);
          return [...list, msg].slice(-MAX_TOASTS);
        });
      }
    }
  }, [scheduleDismiss]);

  useEffect(() => {
    if (!token) return undefined;
    let socket;
    let retryTimer;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      setStatus('connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${window.location.host}/ws/alerts?token=${encodeURIComponent(token)}`);
      socket.onopen = () => {
        attempt = 0;
        setStatus('open');
      };
      socket.onmessage = (event) => {
        try {
          handleMessage(JSON.parse(event.data));
        } catch {
          // ignore malformed messages
        }
      };
      socket.onclose = () => {
        setStatus('closed');
        if (stopped) return;
        const delay = Math.min(10000, 1000 * 2 ** attempt);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      if (socket) {
        // Detach handlers first: the old socket's close event arrives later
        // and must not overwrite the status of the connection that replaces it.
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.close();
      }
    };
  }, [token, handleMessage]);

  // Clear pending pop-up timers when the provider goes away (e.g. logout).
  useEffect(() => () => Object.values(toastTimers.current).forEach(clearTimeout), []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      localStorage.setItem(MUTE_KEY, m ? '0' : '1');
      return !m;
    });
  }, []);

  const value = useMemo(() => ({
    status, feed, replay, telemetry, activeSummary, toasts, muted, resetCount, toggleMute, dismissToast, setReplay,
  }), [status, feed, replay, telemetry, activeSummary, toasts, muted, resetCount, toggleMute, dismissToast]);

  return <AlertStreamContext.Provider value={value}>{children}</AlertStreamContext.Provider>;
}

export function useAlertStream() {
  return useContext(AlertStreamContext);
}
