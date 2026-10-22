import { cancelComandasSchema, cancelItemSchema, moveItemSchema, splitCents } from '@sistema-bar/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../../app';
import {
  comandas,
  diningTables,
  orderItems,
  orderItemShares,
  orders,
  paymentComandas,
  paymentItems,
  payments,
  printerCategories,
  printers,
  printJobs,
} from '../../db/schema';
import { audit } from '../../lib/audit';
import { authorizeManager } from '../../lib/authorize';
import { OPEN_STATUSES } from '../../lib/comandas';
import { HttpError, notFound } from '../../lib/errors';
import type { CancelTicket, ProductionTicket } from '../../printing/tickets';
import { idParams } from '../admin/params';

/**
 * Cancelamento de item lançado (SPEC 4 e 5.5): todo ou parte da quantidade, com motivo e
 * autorização de gerente/admin (PIN quando quem está no caixa é o perfil Caixa). Avisa o setor
 * com um cupom de cancelamento e fica na auditoria.
 */
export async function cashierItemRoutes(app: FastifyInstance, { db, printWorker }: AppDeps) {
  /**
   * Item lançado na comanda errada vai para a certa (mesma mesa ou outra), inteiro ou parte da
   * quantidade. Item rateado: move a parte desta comanda. Item já pago, nem em parte, não se move.
   */
  app.post('/order-items/:id/move', async (request) => {
    const { id } = idParams.parse(request.params);
    const input = moveItemSchema.parse(request.body);
    if (input.fromComandaId === input.toComandaId) throw new HttpError(400, 'VALIDATION', 'Escolha outra comanda de destino.');

    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, id));
    if (!item) throw notFound('Item');
    if (item.status !== 'ATIVO') throw new HttpError(409, 'ALREADY_CANCELED', 'Item cancelado não pode ser movido.');

    const shares = await db.select().from(orderItemShares).where(eq(orderItemShares.orderItemId, id));
    const mine = shares.find((s) => s.comandaId === input.fromComandaId);
    if (!mine) throw new HttpError(400, 'VALIDATION', 'Este item não está nessa comanda.');

    const involved = await db
      .select({ c: comandas, tableNumber: diningTables.number, isCounter: diningTables.isCounter })
      .from(comandas)
      .innerJoin(diningTables, eq(diningTables.id, comandas.tableId))
      .where(inArray(comandas.id, [input.fromComandaId, input.toComandaId]));
    const from = involved.find((r) => r.c.id === input.fromComandaId);
    const to = involved.find((r) => r.c.id === input.toComandaId);
    if (!from || !to) throw notFound('Comanda');
    for (const r of [from, to]) {
      if (!(OPEN_STATUSES as readonly string[]).includes(r.c.status)) {
        throw new HttpError(409, 'COMANDA_NOT_OPEN', `A comanda de ${r.c.customerName} já foi encerrada.`);
      }
    }
    const [paid] = await db
      .select({ id: paymentItems.paymentId })
      .from(paymentItems)
      .innerJoin(payments, eq(payments.id, paymentItems.paymentId))
      .where(and(eq(paymentItems.orderItemId, id), eq(payments.status, 'OK')))
      .limit(1);
    if (paid) throw new HttpError(409, 'ITEM_PAID', 'Este item já foi pago (no todo ou em parte). Estorne o pagamento antes de mover.');

    const shared = shares.length > 1;
    const qty = shared ? item.qty : (input.qty ?? item.qty);
    if (qty > item.qty) throw new HttpError(400, 'VALIDATION', `O item tem só ${item.qty} unidade(s).`);
    const where = (r: typeof from) => `${r.c.customerName} (${r.isCounter ? 'balcão' : `mesa ${r.tableNumber}`})`;

    await db.transaction(async (tx) => {
      if (shared || qty === item.qty) {
        // A parte desta comanda passa para a outra (somando, se a outra já dividia o mesmo item).
        const theirs = shares.find((s) => s.comandaId === input.toComandaId);
        if (theirs) {
          await tx
            .update(orderItemShares)
            .set({ amountCents: theirs.amountCents + mine.amountCents })
            .where(and(eq(orderItemShares.orderItemId, id), eq(orderItemShares.comandaId, input.toComandaId)));
          await tx.delete(orderItemShares).where(and(eq(orderItemShares.orderItemId, id), eq(orderItemShares.comandaId, input.fromComandaId)));
        } else {
          await tx
            .update(orderItemShares)
            .set({ comandaId: input.toComandaId })
            .where(and(eq(orderItemShares.orderItemId, id), eq(orderItemShares.comandaId, input.fromComandaId)));
        }
      } else {
        // Parte da quantidade: o item fica com o resto e a parte movida vira uma linha na outra comanda.
        await tx.update(orderItems).set({ qty: item.qty - qty }).where(eq(orderItems.id, id));
        await tx
          .update(orderItemShares)
          .set({ amountCents: item.unitPriceCents * (item.qty - qty) })
          .where(and(eq(orderItemShares.orderItemId, id), eq(orderItemShares.comandaId, input.fromComandaId)));
        const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = item;
        const [split] = await tx.insert(orderItems).values({ ...copy, qty }).returning({ id: orderItems.id });
        await tx.insert(orderItemShares).values({ orderItemId: split!.id, comandaId: input.toComandaId, amountCents: item.unitPriceCents * qty });
      }
      await audit(tx, request, {
        action: 'ITEM_TRANSFERIDO',
        entity: 'order_item',
        entityId: id,
        before: { product: item.productNameSnapshot, comanda: where(from) },
        after: { qty: shared ? 'parte rateada' : qty, comanda: where(to) },
      });
    });
    return { moved: qty, to: where(to) };
  });

  app.post('/order-items/:id/cancel', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = cancelItemSchema.parse(request.body);

    const [row] = await db
      .select({ item: orderItems, tableId: orders.tableId, tableNumber: diningTables.number, isCounter: diningTables.isCounter })
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
    const printed = await db.transaction((tx) =>
      cancelItemTx(tx, request, { item, place: row, shares, qty: input.qty, reason: input.reason, authorizer, now: new Date() }),
    );
    if (printed) printWorker.kick();
    return { canceledQty: input.qty, remainingQty: item.qty - input.qty, printed };
  });

  /**
   * Cancelar a mesa (ou as comandas escolhidas): cancela os itens que ainda estão ativos (com
   * autorização de gerente, como o cancelamento de item) e encerra as comandas como CANCELADA.
   * Comanda com pagamento não se cancela (estorne antes). Mesa sem nada lançado: não pede PIN.
   */
  app.post('/comandas/cancel', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const input = cancelComandasSchema.parse(request.body);
    const ids = [...new Set(input.comandaIds)];
    const rows = await db
      .select({ c: comandas, tableNumber: diningTables.number, isCounter: diningTables.isCounter })
      .from(comandas)
      .innerJoin(diningTables, eq(diningTables.id, comandas.tableId))
      .where(inArray(comandas.id, ids));
    if (rows.length !== ids.length) throw notFound('Comanda');
    const closed = rows.filter((r) => !(OPEN_STATUSES as readonly string[]).includes(r.c.status));
    if (closed.length) throw new HttpError(409, 'COMANDA_NOT_OPEN', `A comanda de ${closed[0]!.c.customerName} já foi encerrada.`);

    const [paid] = await db
      .select({ comandaId: paymentComandas.comandaId })
      .from(paymentComandas)
      .innerJoin(payments, eq(payments.id, paymentComandas.paymentId))
      .where(and(inArray(paymentComandas.comandaId, ids), eq(payments.status, 'OK')))
      .limit(1);
    if (paid) {
      const who = rows.find((r) => r.c.id === paid.comandaId)!.c.customerName;
      throw new HttpError(409, 'COMANDA_PAID', `A comanda de ${who} já tem pagamento. Estorne antes de cancelar, ou finalize a conta.`);
    }

    // Itens ativos destas comandas (com todas as partes do rateio).
    const itemRows = await db
      .select({ item: orderItems })
      .from(orderItemShares)
      .innerJoin(orderItems, eq(orderItems.id, orderItemShares.orderItemId))
      .where(and(inArray(orderItemShares.comandaId, ids), eq(orderItems.status, 'ATIVO')));
    const items = [...new Map(itemRows.map((r) => [r.item.id, r.item])).values()];
    const allShares = items.length
      ? await db
          .select({ orderItemId: orderItemShares.orderItemId, comandaId: orderItemShares.comandaId, amountCents: orderItemShares.amountCents, name: comandas.customerName })
          .from(orderItemShares)
          .innerJoin(comandas, eq(comandas.id, orderItemShares.comandaId))
          .where(inArray(orderItemShares.orderItemId, items.map((i) => i.id)))
          .orderBy(desc(orderItemShares.amountCents), comandas.openedAt)
      : [];
    const outside = allShares.find((s) => !ids.includes(s.comandaId));
    if (outside) {
      throw new HttpError(409, 'ITEM_SHARED', `Há item dividido com a comanda de ${outside.name}, que não está entre as escolhidas. Inclua essa comanda ou cancele o item antes.`);
    }

    const authorizer = items.length ? await authorizeManager(db, request, input.authorizerPin) : { id: request.user!.id, name: request.user!.name };
    const now = new Date();
    const place = rows[0]!;
    const printed = await db.transaction(async (tx) => {
      let anyPrinted = false;
      for (const item of items) {
        const shares = allShares.filter((s) => s.orderItemId === item.id);
        anyPrinted = (await cancelItemTx(tx, request, { item, place, shares, qty: item.qty, reason: input.reason, authorizer, now })) || anyPrinted;
      }
      await tx.update(comandas).set({ status: 'CANCELADA', closedAt: now }).where(inArray(comandas.id, ids));
      await audit(tx, request, {
        action: 'COMANDA_CANCELADA',
        entity: 'comanda',
        entityId: ids[0]!,
        after: {
          table: place.tableNumber,
          comandas: rows.map((r) => r.c.customerName),
          canceledItems: items.length,
          reason: input.reason,
          authorizedBy: authorizer.name,
        },
      });
      return anyPrinted;
    });
    if (printed) printWorker.kick();
    return { canceledComandas: ids.length, canceledItems: items.length };
  });
}

type Tx = Parameters<Parameters<AppDeps['db']['transaction']>[0]>[0];

/**
 * Cancela `qty` unidades de um item (todo ou parte), dentro da transação: tira do painel da
 * cozinha se ainda não saiu, ou manda o cupom de cancelamento aos setores, e grava a auditoria.
 * Devolve se algum cupom foi para a fila de impressão.
 */
async function cancelItemTx(
  tx: Tx,
  request: FastifyRequest,
  {
    item,
    place,
    shares,
    qty,
    reason,
    authorizer,
    now,
  }: {
    item: typeof orderItems.$inferSelect;
    place: { tableNumber: number; isCounter: boolean };
    shares: { comandaId: string; amountCents: number; name: string }[];
    qty: number;
    reason: string;
    authorizer: { id: string; name: string };
    now: Date;
  },
): Promise<boolean> {
  const id = item.id;
  const canceled = { status: 'CANCELADO' as const, canceledBy: authorizer.id, cancelReason: reason, canceledAt: now };

  // Setores que receberam o item (mesmo roteamento do pedido) recebem o aviso de cancelamento.
  const routes = await tx
    .select({ printer: printers })
    .from(printerCategories)
    .innerJoin(printers, eq(printers.id, printerCategories.printerId))
    .where(and(eq(printerCategories.categoryId, item.categoryId), eq(printers.active, true)));

  if (qty === item.qty) {
    await tx.update(orderItems).set(canceled).where(and(eq(orderItems.id, id), eq(orderItems.status, 'ATIVO')));
  } else {
    // Parte da quantidade: o item fica com o que sobrou e a parte cancelada vira uma linha própria.
    const remaining = item.qty - qty;
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
      .values({ ...copy, qty, ...canceled })
      .returning({ id: orderItems.id });
    const gone = splitCents(item.unitPriceCents * qty, shares.length);
    await tx
      .insert(orderItemShares)
      .values(shares.map((s, i) => ({ orderItemId: split!.id, comandaId: s.comandaId, amountCents: gone[i]! })));
  }

  // Ainda no painel da cozinha (sem "pronto"): só tira o item do cartão, sem cupom de cancelamento.
  const warned: typeof routes = [];
  for (const route of routes) {
    const [held] = route.printer.usesPanel
      ? await tx
          .select()
          .from(printJobs)
          .where(and(eq(printJobs.printerId, route.printer.id), eq(printJobs.referenceId, item.orderId), eq(printJobs.status, 'PAINEL')))
      : [];
    const ticket = held?.payload as ProductionTicket | undefined;
    if (!held || !ticket?.items.some((i) => i.itemId === id)) {
      warned.push(route);
      continue;
    }
    const items = ticket.items
      .map((i) => (i.itemId === id ? { ...i, qty: i.qty - qty } : i))
      .filter((i) => i.qty > 0);
    if (items.length === 0) await tx.delete(printJobs).where(eq(printJobs.id, held.id));
    else await tx.update(printJobs).set({ payload: { ...ticket, items } }).where(eq(printJobs.id, held.id));
  }

  if (warned.length) {
    const payload = (sector: string): CancelTicket => ({
      kind: 'CANCELAMENTO',
      sector,
      tableNumber: place.tableNumber,
      tableLabel: place.isCounter ? 'Balcão' : undefined,
      customers: shares.map((s) => s.name),
      operator: request.user!.name,
      authorizedBy: authorizer.name,
      createdAt: now.toISOString(),
      reason,
      items: [{ qty, name: item.productNameSnapshot, notes: item.notes }],
    });
    await tx
      .insert(printJobs)
      .values(warned.map(({ printer }) => ({ printerId: printer.id, type: 'CANCELAMENTO' as const, payload: payload(printer.sectorLabel), referenceId: id })));
  }

  await audit(tx, request, {
    action: 'ITEM_CANCELADO',
    entity: 'order_item',
    entityId: id,
    before: { product: item.productNameSnapshot, qty: item.qty, unitPriceCents: item.unitPriceCents },
    after: {
      canceledQty: qty,
      reason,
      authorizedBy: authorizer.name,
      table: place.tableNumber,
      comandas: shares.map((s) => s.comandaId),
    },
  });
  return warned.length > 0;
}
