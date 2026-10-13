/**
 * api.js
 * Tiny wrapper around fetch() for talking to the backend.
 *  - adds the login token to every request ("Authorization: Bearer ...")
 *  - turns error responses into ApiError objects with the server's message
 *  - tells the app to log out when the server says the token is no longer valid
 * Plus useApi(), a React hook that loads data for a page.
 */
import { useCallback, useEffect, useState } from 'react';

const TOKEN_KEY = 'pi_session';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function readSession() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY)) || null;
  } catch {
    return null;
  }
}

export function writeSession(session) {
  if (session) localStorage.setItem(TOKEN_KEY, JSON.stringify(session));
  else localStorage.removeItem(TOKEN_KEY);
}

let unauthorizedHandler = null;
/** The auth provider registers a callback here to log out on a 401. */
export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const session = readSession();
  if (auth && session?.token) headers.Authorization = `Bearer ${session.token}`;

  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Is the backend running?');
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON response (e.g. proxy error page); handled below.
  }

  if (!res.ok) {
    const err = new ApiError(res.status, data?.error?.code || 'HTTP_ERROR', data?.error?.message || `Request failed (${res.status})`);
    if (res.status === 401 && auth && unauthorizedHandler) unauthorizedHandler(err);
    throw err;
  }
  return data;
}

/**
 * Load JSON for a page. Re-fetches when `path` changes and, if refreshMs is
 * given, every refreshMs milliseconds (keeping the old data on screen).
 */
export function useApi(path, { refreshMs } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false; // ignore answers that arrive after the page moved on
    const load = async () => {
      try {
        const data = await api(path);
        if (!cancelled) setState({ data, error: null, loading: false });
      } catch (error) {
        if (!cancelled) setState((s) => ({ ...s, error, loading: false }));
      }
    };
    load();
    const timer = refreshMs ? setInterval(load, refreshMs) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [path, refreshMs, version]);

  return { ...state, reload };
}
