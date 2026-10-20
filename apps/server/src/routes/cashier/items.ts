import { cancelItemSchema, splitCents } from '@sistema-bar/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { comandas, diningTables, orderItems, orderItemShares, orders, paymentItems, payments, printerCategories, printers, printJobs } from '../../db/schema';
import { audit } from '../../lib/audit';
import { authorizeManager } from '../../lib/authorize';
import { OPEN_STATUSES } from '../../lib/comandas';
import { HttpError, notFound } from '../../lib/errors';
import type { CancelTicket } from '../../printing/tickets';
import { idParams } from '../admin/params';

/**
 * Cancelamento de item lançado (SPEC 4 e 5.5): todo ou parte da quantidade, com motivo e
 * autorização de gerente/admin (PIN quando quem está no caixa é o perfil Caixa). Avisa o setor
 * com um cupom de cancelamento e fica na auditoria.
 */
export async function cashierItemRoutes(app: FastifyInstance, { db, printWorker }: AppDeps) {
  app.post('/order-items/:id/cancel', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = cancelItemSchema.parse(request.body);

    const [row] = await db
      .select({ item: orderItems, tableId: orders.tableId, tableNumber: diningTables.number })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(diningTables, eq(diningTables.id, orders.tableId))
      .where(eq(orderItems.id, id));
    if (!row) throw notFound('Item');
    const item = row.item;
    if (item.status !== 'ATIVO') throw new HttpError(409, 'ALREADY_CANCELED', 'Este item já foi cancelado.');
    if (input.qty > item.qty) throw new HttpError(400, 'VALIDATION', `O item tem só ${item.qty} unidade(s).`);

    // Rateio: o item pode estar dividido entre comandas; todas precisam estar abertas.
    const shares = await db
      .select({ comandaId: orderItemShares.comandaId, amountCents: orderItemShares.amountCents, name: comandas.customerName, status: comandas.status })
      .from(orderItemShares)
      .innerJoin(comandas, eq(comandas.id, orderItemShares.comandaId))
      .where(eq(orderItemShares.orderItemId, id))
      // O primeiro do rateio ficou com os centavos que sobraram: mantém essa ordem ao refazer.
      .orderBy(desc(orderItemShares.amountCents), comandas.openedAt);
    if (shares.some((s) => !(OPEN_STATUSES as readonly string[]).includes(s.status))) {
      throw new HttpError(409, 'COMANDA_NOT_OPEN', 'A comanda deste item já foi encerrada.');
    }
    const [paid] = await db
      .select({ id: paymentItems.paymentId })
      .from(paymentItems)
      .innerJoin(payments, eq(payments.id, paymentItems.paymentId))
      .where(and(eq(paymentItems.orderItemId, id), eq(payments.status, 'OK')))
      .limit(1);
    if (paid) {
      throw new HttpError(409, 'ITEM_PAID', 'Este item já foi pago (no todo ou em parte). Estorne o pagamento antes de cancelar.');
    }

    const authorizer = await authorizeManager(db, request, input.authorizerPin);
    const whole = input.qty === item.qty;
    const now = new Date();
    const canceled = { status: 'CANCELADO' as const, canceledBy: authorizer.id, cancelReason: input.reason, canceledAt: now };

    // Setores que receberam o item (mesmo roteamento do pedido) recebem o aviso de cancelamento.
    const routes = await db
      .select({ printer: printers })
      .from(printerCategories)
      .innerJoin(printers, eq(printers.id, printerCategories.printerId))
      .where(and(eq(printerCategories.categoryId, item.categoryId), eq(printers.active, true)));

    await db.transaction(async (tx) => {
      if (whole) {
        await tx.update(orderItems).set(canceled).where(and(eq(orderItems.id, id), eq(orderItems.status, 'ATIVO')));
      } else {
        // Parte da quantidade: o item fica com o que sobrou e a parte cancelada vira uma linha própria.
        const remaining = item.qty - input.qty;
        await tx.update(orderItems).set({ qty: remaining }).where(eq(orderItems.id, id));
        const kept = splitCents(item.unitPriceCents * remaining, shares.length);
        for (const [i, s] of shares.entries()) {
          await tx
            .update(orderItemShares)
            .set({ amountCents: kept[i]! })
            .where(and(eq(orderItemShares.orderItemId, id), eq(orderItemShares.comandaId, s.comandaId)));
        }
        const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = item;
        const [split] = await tx
          .insert(orderItems)
          .values({ ...copy, qty: input.qty, ...canceled })
          .returning({ id: orderItems.id });
        const gone = splitCents(item.unitPriceCents * input.qty, shares.length);
        await tx
          .insert(orderItemShares)
          .values(shares.map((s, i) => ({ orderItemId: split!.id, comandaId: s.comandaId, amountCents: gone[i]! })));
      }

      if (routes.length) {
        const payload = (sector: string): CancelTicket => ({
          kind: 'CANCELAMENTO',
          sector,
          tableNumber: row.tableNumber,
          customers: shares.map((s) => s.name),
          operator: request.user!.name,
          authorizedBy: authorizer.name,
          createdAt: now.toISOString(),
          reason: input.reason,
          items: [{ qty: input.qty, name: item.productNameSnapshot, notes: item.notes }],
        });
        await tx
          .insert(printJobs)
          .values(routes.map(({ printer }) => ({ printerId: printer.id, type: 'CANCELAMENTO' as const, payload: payload(printer.sectorLabel), referenceId: id })));
      }

      await audit(tx, request, {
        action: 'ITEM_CANCELADO',
        entity: 'order_item',
        entityId: id,
        before: { product: item.productNameSnapshot, qty: item.qty, unitPriceCents: item.unitPriceCents },
        after: {
          canceledQty: input.qty,
          reason: input.reason,
          authorizedBy: authorizer.name,
          table: row.tableNumber,
          comandas: shares.map((s) => s.comandaId),
        },
      });
    });

    if (routes.length) printWorker.kick();
    return { canceledQty: input.qty, remainingQty: item.qty - input.qty, printed: routes.length > 0 };
  });
}
