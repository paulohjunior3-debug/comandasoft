import { useLiveQuery } from 'dexie-react-hooks';
import { useSyncExternalStore } from 'react';
import { connection } from '../api';
import { offlineDb, type OutboxEntry } from './db';

const EMPTY: OutboxEntry[] = [];

/** Itens da fila, em ordem de envio. Atualiza sozinho quando a fila muda. */
export function useOutboxEntries(tableId?: string): OutboxEntry[] {
  return (
    useLiveQuery(
      () =>
        tableId
          ? offlineDb.outbox.where('tableId').equals(tableId).sortBy('createdAt')
          : offlineDb.outbox.orderBy('createdAt').toArray(),
      [tableId],
    ) ?? EMPTY
  );
}

function subscribeNetwork(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  const off = connection.subscribe(cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
    off();
  };
}

/** Online = Wi-Fi ligado E servidor respondendo (a internet pode cair sem afetar a rede local). */
export function useConnectionStatus() {
  const online = useSyncExternalStore(subscribeNetwork, () => navigator.onLine && connection.get());
  const entries = useOutboxEntries();
  return {
    online,
    pending: entries.filter((e) => e.status === 'PENDENTE').length,
    conflicts: entries.filter((e) => e.status === 'CONFLITO').length,
  };
}
