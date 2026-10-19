import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError } from './api';

/** GET simples com cache. A chave é o próprio caminho da API. */
export function useApiQuery<T>(path: string, enabled = true) {
  return useQuery({ queryKey: [path], queryFn: () => api<T>(path), enabled });
}

type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Mutação que, ao dar certo, invalida as listas informadas em `invalidates`
 * (ex.: salvar impressora recarrega impressoras e categorias).
 */
export function useApiMutation<TBody = unknown, TResult = unknown>(invalidates: string[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ method, path, body }: { method: Method; path: string; body?: TBody }) =>
      api<TResult>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
    // Não espera o recarregamento: o modal fecha na hora e as listas atualizam em seguida.
    onSuccess: () => {
      for (const key of invalidates) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function errorMessage(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof ApiRequestError) return err.message;
  return 'Sem conexão com o servidor.';
}
