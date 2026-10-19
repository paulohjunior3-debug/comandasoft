import { api, ApiRequestError, connection, isRetryable } from '../api';
import { offlineDb, type OfflineDb, type OutboxEntry } from './db';

/**
 * Fila de saída do celular (SPEC 5.4, "outbox local + idempotência no servidor").
 *
 * - Online e sem nada na fila: envia na hora (o garçom vê na tela os erros como nome repetido).
 * - Sem conexão, ou com algo já na fila: guarda e envia depois, na ordem em que foi feito.
 * - Tenta de novo ao abrir o app, ao voltar para o app, quando a rede volta e a cada 10 s.
 * - Recusas do servidor (4xx) viram CONFLITO e esperam o garçom decidir; o resto da fila segue.
 *
 * No iPhone não existe sincronização em segundo plano: só envia com o app aberto.
 */

export type NewEntry = Omit<OutboxEntry, 'status' | 'createdAt' | 'attempts' | 'error'>;

export type SubmitResult<T> = { sent: true; result: T } | { sent: false };

type Sender = (entry: OutboxEntry) => Promise<unknown>;

export function createOutbox({
  db = offlineDb,
  sender = (entry: OutboxEntry) => api(entry.path, { method: entry.method, body: JSON.stringify(entry.body) }),
  isOnline = () => connection.get() && (typeof navigator === 'undefined' || navigator.onLine),
}: { db?: OfflineDb; sender?: Sender; isOnline?: () => boolean } = {}) {
  let syncing: Promise<void> | null = null;
  let rerun = false;
  const syncedListeners = new Set<(entry: OutboxEntry, result: unknown) => void>();
  let seq = 0;

  const pendingCount = () => db.outbox.where('status').equals('PENDENTE').count();

  async function put(entry: NewEntry) {
    // createdAt crescente mesmo para duas entradas no mesmo milissegundo.
    const createdAt = Date.now() * 1000 + (seq++ % 1000);
    const full: OutboxEntry = { ...entry, status: 'PENDENTE', createdAt, attempts: 0 };
    await db.outbox.put(full);
    return full;
  }

  async function runSync() {
    for (;;) {
      const next = await db.outbox.where('status').equals('PENDENTE').sortBy('createdAt');
      const entry = next[0];
      if (!entry) return;
      try {
        const result = await sender(entry);
        await db.outbox.delete(entry.id);
        for (const l of syncedListeners) l(entry, result);
      } catch (err) {
        if (isRetryable(err)) {
          // Sem conexão (ou sessão a renovar): para aqui e tenta de novo depois, mantendo a ordem.
          await db.outbox.update(entry.id, { attempts: entry.attempts + 1 });
          return;
        }
        const e = err as ApiRequestError;
        await db.outbox.update(entry.id, {
          status: 'CONFLITO',
          attempts: entry.attempts + 1,
          error: { code: e.code, message: e.message },
        });
      }
    }
  }

  const outbox = {
    /** Envia já se der; senão guarda na fila. Recusa do servidor (4xx) é lançada para a tela mostrar. */
    async submit<T>(entry: NewEntry): Promise<SubmitResult<T>> {
      if (isOnline() && (await pendingCount()) === 0) {
        try {
          const result = (await sender({ ...entry, status: 'PENDENTE', createdAt: Date.now(), attempts: 0 })) as T;
          for (const l of syncedListeners) l({ ...entry, status: 'PENDENTE', createdAt: Date.now(), attempts: 0 }, result);
          return { sent: true, result };
        } catch (err) {
          if (!isRetryable(err)) throw err;
        }
      }
      await put(entry);
      void outbox.sync();
      return { sent: false };
    },

    /**
     * Processa a fila. Chamadas simultâneas compartilham a mesma rodada; se alguém pedir durante
     * uma rodada (ex.: a rede acabou de voltar), roda mais uma ao final, para não perder o pedido.
     */
    sync(): Promise<void> {
      if (syncing) {
        rerun = true;
        return syncing;
      }
      syncing = (async () => {
        do {
          rerun = false;
          await runSync();
        } while (rerun);
      })().finally(() => {
        syncing = null;
      });
      return syncing;
    },

    /** Conflito resolvido pelo garçom: tenta enviar de novo (opcionalmente com outro corpo). */
    async retry(id: string, body?: unknown) {
      await db.outbox.update(id, { status: 'PENDENTE', error: undefined, ...(body === undefined ? {} : { body }) });
      return outbox.sync();
    },

    discard: (id: string) => db.outbox.delete(id),

    pendingCount,

    onSynced(listener: (entry: OutboxEntry, result: unknown) => void) {
      syncedListeners.add(listener);
      return () => syncedListeners.delete(listener);
    },

    /** Liga os gatilhos de reenvio. Devolve a função que desliga. */
    start() {
      const kick = () => void outbox.sync();
      const onVisible = () => document.visibilityState === 'visible' && kick();
      window.addEventListener('online', kick);
      document.addEventListener('visibilitychange', onVisible);
      const timer = setInterval(async () => {
        if ((await pendingCount()) > 0) kick();
      }, 10_000);
      kick();
      return () => {
        window.removeEventListener('online', kick);
        document.removeEventListener('visibilitychange', onVisible);
        clearInterval(timer);
      };
    },
  };
  return outbox;
}

export type Outbox = ReturnType<typeof createOutbox>;

export const outbox = createOutbox();
