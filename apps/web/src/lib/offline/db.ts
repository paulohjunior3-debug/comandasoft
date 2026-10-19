import Dexie, { type EntityTable } from 'dexie';

/**
 * Banco local do celular (IndexedDB), SPEC 5.4:
 * - `outbox`: o que o garçom fez e ainda não chegou ao servidor (aberturas, pedidos, "atendi a mesa");
 * - `cache`: última resposta das telas de leitura (cardápio, mapa, mesas, comandas), para abrir sem rede.
 */

export type OutboxKind = 'comanda' | 'order' | 'visit';
export type OutboxStatus = 'PENDENTE' | 'CONFLITO';

export interface OutboxEntry {
  /** O próprio clientUuid enviado ao servidor: reenviar nunca duplica. */
  id: string;
  kind: OutboxKind;
  method: 'POST';
  path: string;
  body: unknown;
  status: OutboxStatus;
  /** Ordem de envio (FIFO): a abertura da comanda sempre sai antes dos pedidos dela. */
  createdAt: number;
  attempts: number;
  /** Recusa do servidor que precisa de decisão do garçom (comanda encerrada, esgotado…). */
  error?: { code: string; message: string };
  /** Para as telas: mesa, descrição curta e quem lançou. */
  tableId: string;
  label: string;
  userId: string;
}

export interface CacheEntry {
  key: string;
  data: unknown;
  savedAt: number;
}

export class OfflineDb extends Dexie {
  outbox!: EntityTable<OutboxEntry, 'id'>;
  cache!: EntityTable<CacheEntry, 'key'>;

  constructor(name = 'sistema-bar') {
    super(name);
    this.version(1).stores({
      outbox: 'id, createdAt, status, tableId',
      cache: 'key',
    });
  }
}

export const offlineDb = new OfflineDb();
