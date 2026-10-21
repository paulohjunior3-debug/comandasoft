import { and, eq, gte, inArray, isNull, max } from 'drizzle-orm';
import type { Db } from '../db/client';
import { comandas, orders, paymentComandas, payments, printJobs, tableVisits } from '../db/schema';

export interface TableAttention {
  /** Último pedido, "atendi a mesa" ou abertura de comanda, desde que a ocupação começou. */
  lastAttendedAt: string;
  /** Pré-conta impressa nesta ocupação e ainda não tirada do vermelho. */
  billAlert: boolean;
  /** Já houve pagamento nesta ocupação (comanda paga e fechada, ou pagamento parcial). */
  partialPaid: boolean;
}

/**
 * Situação de atendimento das mesas ocupadas, para as cores do caixa e do garçom. A ocupação
 * começa na comanda aberta mais antiga: o que aconteceu antes (cliente anterior) não conta.
 * O alerta da conta usa os cupons de pré-conta (print_jobs com referenceId = mesa); "tirar do
 * vermelho" marca esses cupons com readyAt.
 */
export async function tableAttention(db: Db, open: { id: string; tableId: string; openedAt: Date }[]): Promise<Map<string, TableAttention>> {
  const result = new Map<string, TableAttention>();
  if (open.length === 0) return result;
  const tableIds = [...new Set(open.map((c) => c.tableId))];
  const since = new Map<string, number>();
  for (const c of open) since.set(c.tableId, Math.min(since.get(c.tableId) ?? Infinity, c.openedAt.getTime()));
  const oldest = new Date(Math.min(...since.values()));

  const [lastOrders, lastVisits, alerts, paidOpen, closed] = await Promise.all([
    db.select({ tableId: orders.tableId, at: max(orders.receivedAt) }).from(orders).where(inArray(orders.tableId, tableIds)).groupBy(orders.tableId),
    db
      .select({ tableId: tableVisits.tableId, at: max(tableVisits.visitedAt) })
      .from(tableVisits)
      .where(inArray(tableVisits.tableId, tableIds))
      .groupBy(tableVisits.tableId),
    db
      .select({ tableId: printJobs.referenceId, at: max(printJobs.createdAt) })
      .from(printJobs)
      .where(and(eq(printJobs.type, 'PRE_CONTA'), inArray(printJobs.referenceId, tableIds), isNull(printJobs.readyAt), gte(printJobs.createdAt, oldest)))
      .groupBy(printJobs.referenceId),
    db
      .selectDistinct({ comandaId: paymentComandas.comandaId })
      .from(paymentComandas)
      .innerJoin(payments, eq(payments.id, paymentComandas.paymentId))
      .where(and(inArray(paymentComandas.comandaId, open.map((c) => c.id)), eq(payments.status, 'OK'))),
    db
      .select({ tableId: comandas.tableId, closedAt: comandas.closedAt })
      .from(comandas)
      .where(and(inArray(comandas.tableId, tableIds), eq(comandas.status, 'FECHADA'), gte(comandas.closedAt, oldest))),
  ]);

  for (const tableId of tableIds) {
    const start = since.get(tableId)!;
    const mine = open.filter((c) => c.tableId === tableId);
    const after = (d: Date | null | undefined) => (d && d.getTime() >= start ? d.getTime() : 0);
    const last = Math.max(
      ...mine.map((c) => c.openedAt.getTime()),
      after(lastOrders.find((o) => o.tableId === tableId)?.at),
      after(lastVisits.find((v) => v.tableId === tableId)?.at),
    );
    result.set(tableId, {
      lastAttendedAt: new Date(last).toISOString(),
      billAlert: alerts.some((a) => a.tableId === tableId && a.at && a.at.getTime() >= start),
      partialPaid:
        paidOpen.some((p) => mine.some((c) => c.id === p.comandaId)) ||
        closed.some((c) => c.tableId === tableId && c.closedAt && c.closedAt.getTime() >= start),
    });
  }
  return result;
}

/** Tirar do vermelho: os cupons de pré-conta desta ocupação deixam de acender o alerta. */
export async function clearBillAlert(db: Db, tableId: string) {
  return db
    .update(printJobs)
    .set({ readyAt: new Date() })
    .where(and(eq(printJobs.type, 'PRE_CONTA'), eq(printJobs.referenceId, tableId), isNull(printJobs.readyAt)))
    .returning({ id: printJobs.id });
}
