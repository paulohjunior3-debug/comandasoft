import { restoreComandasSchema, restoreItemSchema } from '@sistema-bar/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../../app';
import { comandas, diningTables, orderItems, orderItemShares, orders, printerCategories, printers, printJobs, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { authorizeManager } from '../../lib/authorize';
import { OPEN_STATUSES } from '../../lib/comandas';
import { HttpError, notFound } from '../../lib/errors';
import type { ProductionTicket } from '../../printing/tickets';
import { idParams } from '../admin/params';

type Tx = Parameters<Parameters<AppDeps['db']['transaction']>[0]>[0];
type Item = typeof orderItems.$inferSelect;

/**
 * Descancelar: o item (ou a mesa) cancelado por engano volta a valer, com PIN de gerente e
 * motivo na auditoria. Opcionalmente manda de novo para a cozinha/bar (o cancelamento pode
 * ter tirado o pedido do painel ou avisado o setor para não preparar).
 */
export async function cashierRestoreRoutes(app: FastifyInstance, { db, printWorker }: AppDeps) {
  app.post('/order-items/:id/restore', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = restoreItemSchema.parse(request.body);
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, id));
    if (!item) throw notFound('Item');
    if (item.status !== 'CANCELADO') throw new HttpError(409, 'NOT_CANCELED', 'Este item não está cancelado.');
    const shares = await db
      .select({ comandaId: orderItemShares.comandaId, name: comandas.customerName, status: comandas.status })
      .from(orderItemShares)
      .innerJoin(comandas, eq(comandas.id, orderItemShares.comandaId))
      .where(eq(orderItemShares.orderItemId, id));
    if (shares.some((s) => s.status === 'CANCELADA')) {
      throw new HttpError(409, 'COMANDA_CANCELED', 'A comanda deste item foi cancelada. Descancele a mesa em Contas fechadas › Mesas canceladas.');
    }
    if (shares.some((s) => !(OPEN_STATUSES as readonly string[]).includes(s.status))) {
      throw new HttpError(409, 'COMANDA_NOT_OPEN', 'A comanda deste item já foi encerrada.');
    }
    const authorizer = await authorizeManager(db, request, input.authorizerPin);
    const sent = await db.transaction(async (tx) => {
      const sent = await restoreItemsTx(tx, request, [item], shares.map((s) => s.name), input.resend);
      await audit(tx, request, {
        action: 'ITEM_DESCANCELADO',
        entity: 'order_item',
        entityId: id,
        before: { product: item.productNameSnapshot, qty: item.qty, cancelReason: item.cancelReason },
        after: { reason: input.reason, authorizedBy: authorizer.name, comandas: shares.map((s) => s.name), resend: input.resend },
      });
      return sent;
    });
    if (sent) printWorker.kick();
    return { restoredQty: item.qty, sent };
  });

  /**
   * Descancelar a mesa (comandas encerradas como CANCELADA): as comandas voltam a ficar abertas e
   * os itens cancelados junto com elas (no mesmo cancelamento) voltam a valer. Itens cancelados
   * antes, um a um, continuam cancelados.
   */
  app.post('/comandas/restore', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const input = restoreComandasSchema.parse(request.body);
    const ids = [...new Set(input.comandaIds)];
    const rows = await db
      .select({ c: comandas, tableNumber: diningTables.number })
      .from(comandas)
      .innerJoin(diningTables, eq(diningTables.id, comandas.tableId))
      .where(inArray(comandas.id, ids));
    if (rows.length !== ids.length) throw notFound('Comanda');
    const notCanceled = rows.find((r) => r.c.status !== 'CANCELADA');
    if (notCanceled) throw new HttpError(409, 'NOT_CANCELED', `A comanda de ${notCanceled.c.customerName} não está cancelada.`);

    // Itens cancelados no mesmo instante em que a comanda foi encerrada.
    const itemRows = await db
      .select({ item: orderItems, comandaId: orderItemShares.comandaId })
      .from(orderItemShares)
      .innerJoin(orderItems, eq(orderItems.id, orderItemShares.orderItemId))
      .where(and(inArray(orderItemShares.comandaId, ids), eq(orderItems.status, 'CANCELADO')));
    const closedAt = new Map(rows.map((r) => [r.c.id, r.c.closedAt?.getTime()]));
    const items = [
      ...new Map(
        itemRows.filter((r) => r.item.canceledAt && r.item.canceledAt.getTime() === closedAt.get(r.comandaId)).map((r) => [r.item.id, r.item]),
      ).values(),
    ];

    const authorizer = await authorizeManager(db, request, input.authorizerPin);
    const sent = await db.transaction(async (tx) => {
      await tx.update(comandas).set({ status: 'ABERTA', closedAt: null }).where(inArray(comandas.id, ids));
      const sent = await restoreItemsTx(tx, request, items, rows.map((r) => r.c.customerName), input.resend);
      await audit(tx, request, {
        action: 'COMANDA_DESCANCELADA',
        entity: 'comanda',
        entityId: ids[0]!,
        after: {
          table: rows[0]!.tableNumber,
          comandas: rows.map((r) => r.c.customerName),
          restoredItems: items.length,
          reason: input.reason,
          authorizedBy: authorizer.name,
          resend: input.resend,
        },
      });
      return sent;
    });
    if (sent) printWorker.kick();
    return { restoredComandas: ids.length, restoredItems: items.length, tableId: rows[0]!.c.tableId };
  });
}

/** Volta os itens para ATIVO e, se pedido, manda um cupom de produção por setor. Devolve se mandou. */
async function restoreItemsTx(tx: Tx, request: FastifyRequest, items: Item[], customers: string[], resend: boolean): Promise<boolean> {
  if (!items.length) return false;
  await tx
    .update(orderItems)
    .set({ status: 'ATIVO', canceledBy: null, cancelReason: null, canceledAt: null })
    .where(and(inArray(orderItems.id, items.map((i) => i.id)), eq(orderItems.status, 'CANCELADO')));
  if (!resend) return false;

  const orderRows = await tx
    .select({ o: orders, tableNumber: diningTables.number, isCounter: diningTables.isCounter, waiter: users.name })
    .from(orders)
    .innerJoin(diningTables, eq(diningTables.id, orders.tableId))
    .innerJoin(users, eq(users.id, orders.userId))
    .where(inArray(orders.id, [...new Set(items.map((i) => i.orderId))]));
  const routes = await tx
    .select({ printer: printers, categoryId: printerCategories.categoryId })
    .from(printerCategories)
    .innerJoin(printers, eq(printers.id, printerCategories.printerId))
    .where(and(inArray(printerCategories.categoryId, [...new Set(items.map((i) => i.categoryId))]), eq(printers.active, true)));

  // Um cupom por pedido e setor, como no lançamento (o painel da cozinha agrupa pelo pedido).
  const jobs: (typeof printJobs.$inferInsert)[] = [];
  for (const o of orderRows) {
    const tickets = new Map<string, ProductionTicket>();
    for (const item of items.filter((i) => i.orderId === o.o.id)) {
      for (const { printer } of routes.filter((r) => r.categoryId === item.categoryId)) {
        let t = tickets.get(printer.id);
        if (!t) {
          t = {
            kind: 'PRODUCAO',
            sector: printer.sectorLabel,
            tableNumber: o.tableNumber,
            tableLabel: o.isCounter ? 'Balcão' : undefined,
            customers,
            waiter: `${o.waiter} (descancelado por ${request.user!.name})`,
            createdAt: new Date().toISOString(),
            orderRef: o.o.id.slice(-6).toUpperCase(),
            takeaway: o.o.takeaway || undefined,
            items: [],
          };
          tickets.set(printer.id, t);
          jobs.push({
            printerId: printer.id,
            type: 'PRODUCAO',
            payload: t,
            referenceId: o.o.id,
            status: printer.usesPanel ? 'PAINEL' : 'PENDENTE',
          });
        }
        t.items.push({ qty: item.qty, name: item.productNameSnapshot, notes: item.notes, itemId: item.id });
      }
    }
  }
  if (jobs.length) await tx.insert(printJobs).values(jobs);
  return jobs.length > 0;
}
