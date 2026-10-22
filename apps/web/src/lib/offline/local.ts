import type { ComandaSummary, CreateOrderInput, OpenComandaInput } from '@sistema-bar/shared';
import type { OutboxEntry } from './db';

/**
 * Visão local do que está na fila, para as telas mostrarem o que o garçom já fez
 * mesmo antes de chegar ao servidor.
 */

export interface PendingComanda extends ComandaSummary {
  pending: true;
  conflict: boolean;
}

/** Comandas abertas no aparelho e ainda não confirmadas. O id provisório é o clientUuid. */
export function pendingComandas(entries: OutboxEntry[], tableId: string, tableNumber: number): PendingComanda[] {
  return entries
    .filter((e) => e.kind === 'comanda' && e.tableId === tableId)
    .map((e) => {
      const body = e.body as OpenComandaInput;
      return {
        id: e.id,
        clientUuid: e.id,
        number: 0,
        tableId,
        tableNumber,
        customerName: body.customerName,
        phone: typeof body.phone === 'string' ? body.phone.replace(/\D/g, '') || null : null,
        peopleCount: body.peopleCount ?? 1,
        status: 'ABERTA',
        openedAt: new Date(e.createdAt / 1000).toISOString(),
        totalCents: 0,
        pending: true,
        conflict: e.status === 'CONFLITO',
      };
    });
}

/** Junta as comandas do servidor com as pendentes, sem repetir as que já sincronizaram. */
export function mergeComandas(server: ComandaSummary[], pending: PendingComanda[]): (ComandaSummary | PendingComanda)[] {
  const known = new Set(server.map((c) => c.clientUuid));
  return [...server, ...pending.filter((p) => !known.has(p.clientUuid))];
}

export const isPending = (c: ComandaSummary | PendingComanda): c is PendingComanda => 'pending' in c;

/** Pedidos na fila que incluem esta comanda (pelo id do servidor ou pelo clientUuid). */
export function pendingOrdersFor(entries: OutboxEntry[], comanda: { id: string; clientUuid: string }) {
  return entries.filter((e) => {
    if (e.kind !== 'order') return false;
    const ids = (e.body as CreateOrderInput).comandaIds;
    return ids.includes(comanda.id) || ids.includes(comanda.clientUuid);
  });
}
