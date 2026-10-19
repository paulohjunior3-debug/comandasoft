import type { ApiError, AuthResponse } from '@sistema-bar/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// O access token fica só em memória; o refresh token fica num cookie httpOnly que o JS não lê.
let accessToken: string | null = null;
let refreshing: Promise<AuthResponse | null> | null = null;
let onSessionLost: () => void = () => {};

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function onUnauthenticated(handler: () => void) {
  onSessionLost = handler;
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

/** Troca o cookie de refresh por um novo access token. Chamadas simultâneas compartilham a mesma tentativa. */
export function refreshSession(): Promise<AuthResponse | null> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then((res) => (res.ok ? parse<AuthResponse>(res) : null))
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
  const send = () =>
    fetch(`/api${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...init.headers,
      },
    });

  let res = await send();
  if (res.status === 401 && accessToken && !path.startsWith('/auth/')) {
    if (await refreshSession()) {
      res = await send();
    } else {
      onSessionLost();
    }
  }
  return parse<T>(res);
}
