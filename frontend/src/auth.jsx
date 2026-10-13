/**
 * auth.jsx
 * Keeps track of who is logged in and shares it with every page through React
 * "context" (a way to pass data to any component without threading props).
 *
 * The permission list comes from the server at login, so the UI hides exactly
 * the pages the API would refuse. The API still enforces access itself.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, onUnauthorized, readSession, writeSession } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => readSession());
  const [notice, setNotice] = useState(null); // e.g. "session expired"

  const logout = useCallback((message = null) => {
    writeSession(null);
    setSession(null);
    setNotice(message);
  }, []);

  const login = useCallback(async (username, password) => {
    const data = await api('/auth/login', { method: 'POST', body: { username, password }, auth: false });
    const next = { token: data.token, user: data.user };
    writeSession(next);
    setSession(next);
    setNotice(null);
    return data.user;
  }, []);

  // Any 401 from the API (expired token, server restarted with a new secret)
  // logs the user out with an explanation.
  useEffect(() => {
    onUnauthorized((err) => logout(err.message));
  }, [logout]);

  // On page load, check the stored token is still accepted.
  useEffect(() => {
    if (session?.token) api('/auth/me').catch(() => {});
    // Only once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(() => ({
    user: session?.user || null,
    token: session?.token || null,
    login,
    logout,
    notice,
    can: (permission) => Boolean(session?.user?.permissions?.includes(permission)),
  }), [session, login, logout, notice]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
