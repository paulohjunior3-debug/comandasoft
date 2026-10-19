import { useQuery } from '@tanstack/react-query';
import { api, isRetryable } from '../api';
import { offlineDb } from './db';

/**
 * GET que guarda a última resposta no aparelho. Sem conexão, devolve a cópia guardada
 * (cardápio, mapa, mesa, comanda), para o garçom continuar trabalhando (SPEC 5.4 item 1).
 */
export async function cachedGet<T>(path: string): Promise<T> {
  try {
    const data = await api<T>(path);
    void offlineDb.cache.put({ key: path, data, savedAt: Date.now() });
    return data;
  } catch (err) {
    if (isRetryable(err)) {
      const hit = await offlineDb.cache.get(path);
      if (hit) return hit.data as T;
    }
    throw err;
  }
}

export function useCachedQuery<T>(path: string, options: { refetchInterval?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [path],
    queryFn: () => cachedGet<T>(path),
    // Sem rede o cache já respondeu; não precisa martelar com novas tentativas.
    retry: false,
    ...options,
  });
}
