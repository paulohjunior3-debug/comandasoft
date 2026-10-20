import { createOrderSchema, splitCents, WAITER_ERRORS, type CreateOrderResponse } from '@sistema-bar/shared';
import { and, count, eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import {
  comandas,
  diningTables,
  orderItems,
  orderItemShares,
  orders,
  printerCategories,
  printers,
  printJobs,
  products,
} from '../../db/schema';
import { audit } from '../../lib/audit';
import { OPEN_STATUSES } from '../../lib/comandas';
import { HttpError } from '../../lib/errors';
import type { ProductionTicket } from '../../printing/tickets';

export async function waiterOrderRoutes(app: FastifyInstance, { db, printWorker }: AppDeps) {
  async function duplicateResponse(orderId: string): Promise<CreateOrderResponse> {
    const [{ n }] = (await db.select({ n: count() }).from(printJobs).where(eq(printJobs.referenceId, orderId))) as [{ n: number }];
    return { orderId, duplicate: true, printJobs: n, unroutedItems: 0 };
  }

  /**
   * Lançamento de pedido (SPEC 5.3/5.4). Idempotente por clientUuid: o app pode reenviar
   * quantas vezes precisar (queda de rede) sem duplicar. Pedido e cupons de produção
   * (print_jobs) são gravados na mesma transação.
   */
  app.post('/', async (request, reply) => {
    const input = createOrderSchema.parse(request.body);

    // Reenvio de um pedido já aceito: responde igual, mesmo que a comanda já tenha fechado.
    const [already] = await db.select({ id: orders.id }).from(orders).where(eq(orders.clientUuid, input.clientUuid));
    if (already) return reply.code(200).send(await duplicateResponse(already.id));

    const comandaIds = [...new Set(input.comandaIds)];
    let [requested] = await db.select().from(diningTables).where(eq(diningTables.id, input.tableId));
    if (!requested) throw new HttpError(400, 'VALIDATION', 'Mesa inválida.');

    const targets = await db
      .select()
      .from(comandas)
      .where(or(inArray(comandas.id, comandaIds), inArray(comandas.clientUuid, comandaIds)));
    const resolve = (ref: string) => targets.find((c) => c.id === ref || c.clientUuid === ref);
    if (comandaIds.some((ref) => !resolve(ref))) {
      throw new HttpError(409, WAITER_ERRORS.COMANDA_NOT_FOUND, 'Comanda não encontrada. Lance em outra comanda ou descarte o pedido.');
    }
    if (targets.some((c) => c.tableId !== requested!.id)) {
      // Pedido feito antes de o caixa transferir a comanda (ex.: na fila do celular sem rede):
      // se todas estão juntas na mesa nova, o pedido vai para lá (e o cupom sai com a mesa certa).
      const moved = [...new Set(targets.map((c) => c.tableId))];
      if (moved.length !== 1) throw new HttpError(400, 'VALIDATION', 'Comanda inválida para esta mesa.');
      [requested] = await db.select().from(diningTables).where(eq(diningTables.id, moved[0]!));
      if (!requested) throw new HttpError(400, 'VALIDATION', 'Mesa inválida.');
    }
    const table = requested;
    const closed = targets.filter((c) => !(OPEN_STATUSES as readonly string[]).includes(c.status));
    if (closed.length) {
      throw new HttpError(
        409,
        WAITER_ERRORS.COMANDA_NOT_OPEN,
        `Comanda já encerrada: ${closed.map((c) => c.customerName).join(', ')}. Lance em outra comanda ou descarte o pedido.`,
      );
    }
    // Mantém a ordem escolhida pelo garçom (o 1º recebe os centavos que sobram no rateio).
    const ordered = [...new Map(comandaIds.map((ref) => resolve(ref)!).map((c) => [c.id, c])).values()];

    const productIds = [...new Set(input.items.map((i) => i.productId))];
    const found = await db.select().from(products).where(inArray(products.id, productIds));
    const unavailable = productIds.filter((id) => !found.find((p) => p.id === id && p.active));
    if (unavailable.length) {
      throw new HttpError(409, WAITER_ERRORS.PRODUCT_UNAVAILABLE, 'Há produtos que não estão mais no cardápio. Atualize e tente de novo.');
    }
    const soldOut = found.filter((p) => p.soldOut);
    if (soldOut.length) {
      throw new HttpError(409, WAITER_ERRORS.SOLD_OUT, `Esgotado: ${soldOut.map((p) => p.name).join(', ')}.`);
    }

    // Roteamento: impressoras ativas vinculadas a cada categoria (SPEC 5.5).
    const categoryIds = [...new Set(found.map((p) => p.categoryId))];
    const routes = await db
      .select({ categoryId: printerCategories.categoryId, printer: printers })
      .from(printerCategories)
      .innerJoin(printers, eq(printers.id, printerCategories.printerId))
      .where(and(inArray(printerCategories.categoryId, categoryIds), eq(printers.active, true)));

    const result = await db.transaction(async (tx) => {
      const [order] = await tx
        .insert(orders)
        .values({
          clientUuid: input.clientUuid,
          tableId: table.id,
          userId: request.user!.id,
          createdAtDevice: new Date(input.createdAtDevice),
        })
        .onConflictDoNothing({ target: orders.clientUuid })
        .returning({ id: orders.id });
      if (!order) return null; // outro envio do mesmo pedido chegou primeiro

      const tickets = new Map<string, ProductionTicket>();
      let unroutedItems = 0;

      for (const item of input.items) {
        const product = found.find((p) => p.id === item.productId)!;
        // Preço vigente no servidor na hora do recebimento (SPEC 5.4 item 10).
        const [row] = await tx
          .insert(orderItems)
          .values({
            orderId: order.id,
            productId: product.id,
            productNameSnapshot: product.name,
            categoryId: product.categoryId,
            qty: item.qty,
            unitPriceCents: product.priceCents,
            notes: item.notes,
          })
          .returning({ id: orderItems.id });
        const shares = splitCents(product.priceCents * item.qty, ordered.length);
        await tx
          .insert(orderItemShares)
          .values(ordered.map((c, i) => ({ orderItemId: row!.id, comandaId: c.id, amountCents: shares[i]! })));

        const itemRoutes = routes.filter((r) => r.categoryId === product.categoryId);
        if (itemRoutes.length === 0) unroutedItems++;
        for (const { printer } of itemRoutes) {
          let ticket = tickets.get(printer.id);
          if (!ticket) {
            ticket = {
              kind: 'PRODUCAO',
              sector: printer.sectorLabel,
              tableNumber: table.number,
              tableLabel: table.isCounter ? 'Balcão' : undefined,
              customers: ordered.map((c) => c.customerName),
              waiter: request.user!.name,
              createdAt: input.createdAtDevice,
              orderRef: order.id.slice(-6).toUpperCase(),
              items: [],
            };
            tickets.set(printer.id, ticket);
          }
          ticket.items.push({ qty: item.qty, name: product.name, notes: item.notes });
        }
      }

      // Pedido feito com cardápio desatualizado no celular: vale o preço do servidor, mas registra (SPEC 5.4 item 10).
      const divergent = input.items
        .map((i) => ({ item: i, product: found.find((p) => p.id === i.productId)! }))
        .filter(({ item, product }) => item.expectedUnitPriceCents !== undefined && item.expectedUnitPriceCents !== product.priceCents);
      if (divergent.length) {
        await audit(tx, request, {
          action: 'PEDIDO_PRECO_DIVERGENTE',
          entity: 'order',
          entityId: order.id,
          after: divergent.map(({ item, product }) => ({
            product: product.name,
            deviceCents: item.expectedUnitPriceCents,
            serverCents: product.priceCents,
          })),
        });
      }

      if (tickets.size) {
        await tx.insert(printJobs).values(
          [...tickets].map(([printerId, payload]) => ({ printerId, type: 'PRODUCAO' as const, payload, referenceId: order.id })),
        );
      }
      return { orderId: order.id, duplicate: false, printJobs: tickets.size, unroutedItems } satisfies CreateOrderResponse;
    });

    if (!result) {
      const [winner] = await db.select({ id: orders.id }).from(orders).where(eq(orders.clientUuid, input.clientUuid));
      return reply.code(200).send(await duplicateResponse(winner!.id));
    }
    if (result.printJobs > 0) printWorker.kick(); // imprime já, sem esperar o próximo ciclo
    return reply.code(201).send(result);
  });
}
