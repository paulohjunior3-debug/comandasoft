import { authUserSchema, type AuthResponse, type AuthUser, type LoginRequest } from '@sistema-bar/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, isRetryable, onUnauthenticated, refreshSession, setAccessToken } from './api';
import { outbox } from './offline/outbox';

interface AuthState {
  user: AuthUser | null;
  /** true enquanto tenta restaurar a sessão pelo cookie ao abrir o app. */
  loading: boolean;
  login: (data: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

// Último usuário logado neste aparelho: permite abrir o app sem rede (SPEC 5.4).
// Não é segredo (nome e perfil); a autorização de verdade continua no servidor.
const USER_KEY = 'sb_user';

function rememberUser(user: AuthUser | null) {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* modo privado: segue sem lembrar */
  }
}

function rememberedUser(): AuthUser | null {
  try {
    const parsed = authUserSchema.safeParse(JSON.parse(localStorage.getItem(USER_KEY) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    onUnauthenticated(() => {
      setAccessToken(null);
      rememberUser(null);
      setUser(null);
    });
    refreshSession()
      .then((session) => {
        rememberUser(session?.user ?? null);
        setUser(session?.user ?? null);
      })
      .catch((err) => {
        // Sem conexão ao abrir: entra com o último usuário; a sessão é renovada quando a rede voltar.
        setUser(isRetryable(err) ? rememberedUser() : null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (data: LoginRequest) => {
    const session = await api<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(data) });
    setAccessToken(session.accessToken);
    rememberUser(session.user);
    setUser(session.user);
  }, []);

  const logout = useCallback(async () => {
    const pending = await outbox.pendingCount();
    if (pending > 0 && !confirm(`Há ${pending} envio(s) pendente(s) neste aparelho. Sair mesmo assim? Eles continuarão na fila.`)) {
      return;
    }
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setAccessToken(null);
    rememberUser(null);
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
