import type { ApiError, AuthResponse } from '@sistema-bar/shared';

export class ApiRequestError extends Error {
  constructor(
    /** 0 = sem resposta do servidor (rede caiu, servidor desligado). */
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Vale a pena tentar de novo mais tarde? Sim para falta de rede, servidor fora do ar (5xx,
 * inclusive o proxy sem a API) e sessão a renovar. Não para recusas do servidor (4xx):
 * essas precisam de decisão de alguém.
 */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof ApiRequestError)) return true;
  return err.status === 0 || err.status >= 500 || err.status === 401;
}

// ---------- Estado da conexão com o servidor (não só do Wi-Fi) ----------

let serverReachable = true;
const listeners = new Set<() => void>();

function setReachable(value: boolean) {
  if (serverReachable === value) return;
  serverReachable = value;
  for (const l of listeners) l();
}

export const connection = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: () => serverReachable,
};

// ---------- Sessão ----------

// O access token fica só em memória; o refresh token fica num cookie httpOnly que o JS não lê.
let accessToken: string | null = null;
let refreshing: Promise<AuthResponse | null> | null = null;
let onSessionLost: () => void = () => {};

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function hasAccessToken() {
  return accessToken !== null;
}

export function onUnauthenticated(handler: () => void) {
  onSessionLost = handler;
}

async function send(input: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch {
    setReachable(false);
    throw new ApiRequestError(0, 'NETWORK', 'Sem conexão com o servidor.');
  }
  // 502/503/504 = proxy ou servidor fora do ar; 500 do proxy do Vite também (API desligada).
  setReachable(res.status < 500 || res.status === 501);
  return res;
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body as ApiError | null;
    throw new ApiRequestError(res.status, err?.error ?? 'ERROR', err?.message ?? 'Erro de comunicação com o servidor.');
  }
  return body as T;
}

/**
 * Troca o cookie de refresh por um novo access token. Chamadas simultâneas compartilham a mesma tentativa.
 * Retorna null se a sessão acabou (401) e lança ApiRequestError(0) se não há conexão.
 */
export function refreshSession(): Promise<AuthResponse | null> {
  refreshing ??= send('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then((res) => (res.ok ? parse<AuthResponse>(res) : res.status === 401 ? null : parse<AuthResponse>(res)))
    .then((session) => {
      setAccessToken(session?.accessToken ?? null);
      return session;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const call = () =>
    send(`/api${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...init.headers,
      },
    });

  let res = await call();
  // Token expirado ou app reaberto sem token em memória: renova pelo cookie e tenta de novo.
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) {
      res = await call();
    } else {
      onSessionLost();
    }
  }
  return parse<T>(res);
}
