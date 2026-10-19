import type { AuthResponse, AuthUser, LoginRequest } from '@sistema-bar/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onUnauthenticated, refreshSession, setAccessToken } from './api';

interface AuthState {
  user: AuthUser | null;
  /** true enquanto tenta restaurar a sessão pelo cookie ao abrir o app. */
  loading: boolean;
  login: (data: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    onUnauthenticated(() => {
      setAccessToken(null);
      setUser(null);
    });
    refreshSession()
      .then((session) => setUser(session?.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (data: LoginRequest) => {
    const session = await api<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(data) });
    setAccessToken(session.accessToken);
    setUser(session.user);
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setAccessToken(null);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, loading, login, logout }), [user, loading, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth precisa estar dentro de <AuthProvider>');
  return ctx;
}
