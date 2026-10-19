import type { ComandaSummary } from '@sistema-bar/shared';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { comandas, diningTables, orderItems, orderItemShares } from '../db/schema';

export const OPEN_STATUSES = ['ABERTA', 'EM_FECHAMENTO'] as const;

/** Saldo de itens de cada comanda = soma das partes dos itens ativos (SPEC 6, regras-chave). */
export async function comandaTotals(db: Db, ids: string[]): Promise<Map<string, number>> {
  const totals = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return totals;
  const rows = await db
    .select({ comandaId: orderItemShares.comandaId, total: sql<string>`coalesce(sum(${orderItemShares.amountCents}), 0)` })
    .from(orderItemShares)
    .innerJoin(orderItems, eq(orderItems.id, orderItemShares.orderItemId))
    .where(and(inArray(orderItemShares.comandaId, ids), eq(orderItems.status, 'ATIVO')))
    .groupBy(orderItemShares.comandaId);
  for (const r of rows) totals.set(r.comandaId, Number(r.total));
  return totals;
}

export async function loadComandaSummaries(db: Db, where: SQL | undefined): Promise<ComandaSummary[]> {
  const rows = await db
    .select({ comanda: comandas, tableNumber: diningTables.number })
    .from(comandas)
    .innerJoin(diningTables, eq(diningTables.id, comandas.tableId))
    .where(where)
    .orderBy(comandas.openedAt, comandas.number);
  const totals = await comandaTotals(db, rows.map((r) => r.comanda.id));
  return rows.map(({ comanda: c, tableNumber }) => ({
    id: c.id,
    clientUuid: c.clientUuid,
    number: c.number,
    tableId: c.tableId,
    tableNumber,
    customerName: c.customerName,
    peopleCount: c.peopleCount,
    status: c.status,
    openedAt: c.openedAt.toISOString(),
    totalCents: totals.get(c.id) ?? 0,
  }));
}
