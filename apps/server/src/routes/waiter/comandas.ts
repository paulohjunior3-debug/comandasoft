import { openComandaSchema, WAITER_ERRORS, type ComandaDetail, type ComandaItem, type ComandaTotals } from '@sistema-bar/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { comandas, diningTables, orderItems, orderItemShares, orders, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { loadBill } from '../../lib/billing';
import { loadComandaSummaries, OPEN_STATUSES } from '../../lib/comandas';
import { HttpError, notFound, pgError } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import { idParams } from '../admin/params';

export async function waiterComandaRoutes(app: FastifyInstance, { db, cpf }: AppDeps) {
  const summaryOf = async (id: string) => {
    const [summary] = await loadComandaSummaries(db, eq(comandas.id, id));
    if (!summary) throw notFound('Comanda');
    return summary;
  };

  async function cpfConflict(hmac: string) {
    const [other] = await db
      .select({ name: comandas.customerName, tableNumber: diningTables.number })
      .from(comandas)
      .innerJoin(diningTables, eq(diningTables.id, comandas.tableId))
      .where(and(eq(comandas.cpfHmac, hmac), inArray(comandas.status, [...OPEN_STATUSES])));
    return other
      ? new HttpError(
          409,
          WAITER_ERRORS.CPF_HAS_OPEN_COMANDA,
          `Este CPF já tem comanda aberta na mesa ${other.tableNumber} (${other.name}).`,
        )
      : null;
  }

  const duplicateName = (name: string, tableNumber: number) =>
    new HttpError(
      409,
      WAITER_ERRORS.DUPLICATE_NAME,
      `Já existe "${name}" na mesa ${tableNumber}. Acrescente o sobrenome ou uma inicial.`,
    );

  /** Abertura de comanda: nome + CPF + mesa (SPEC 5.2). Idempotente por clientUuid. */
  app.post('/', async (request, reply) => {
    const input = openComandaSchema.parse(request.body);

    const [existing] = await db.select({ id: comandas.id }).from(comandas).where(eq(comandas.clientUuid, input.clientUuid));
    if (existing) return reply.code(200).send(await summaryOf(existing.id));

    const [table] = await db.select().from(diningTables).where(eq(diningTables.id, input.tableId));
    if (!table || !table.active) throw new HttpError(400, 'VALIDATION', 'Mesa inválida ou inativa.');

    const protectedCpf = cpf.protect(input.cpf);
    const conflict = await cpfConflict(protectedCpf.hmac);
    if (conflict) throw conflict;

    const [sameName] = await db
      .select({ id: comandas.id })
      .from(comandas)
      .where(
        and(
          eq(comandas.tableId, table.id),
          inArray(comandas.status, [...OPEN_STATUSES]),
          sql`lower(${comandas.customerName}) = lower(${input.customerName})`,
        ),
      );
    if (sameName) throw duplicateName(input.customerName, table.number);

    try {
      const id = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(comandas)
          .values({
            clientUuid: input.clientUuid,
            tableId: table.id,
            customerName: input.customerName,
            cpfHmac: protectedCpf.hmac,
            cpfEncrypted: protectedCpf.encrypted,
            cpfLast3: protectedCpf.last3,
            phone: input.phone,
            peopleCount: input.peopleCount,
            openedBy: request.user!.id,
          })
          .returning({ id: comandas.id, number: comandas.number });
        // CPF fora da auditoria de propósito (LGPD).
        await audit(tx, request, {
          action: 'COMANDA_ABERTA',
          entity: 'comanda',
          entityId: row!.id,
          after: { number: row!.number, tableNumber: table.number, customerName: input.customerName, peopleCount: input.peopleCount },
        });
        return row!.id;
      });
      return reply.code(201).send(await summaryOf(id));
    } catch (err) {
      // Corrida entre dois aparelhos: as mesmas regras, garantidas pelos índices únicos.
      const pg = pgError(err);
      if (pg?.code === '23505') {
        if (pg.constraint === 'comandas_client_uuid_unique') {
          const [again] = await db.select({ id: comandas.id }).from(comandas).where(eq(comandas.clientUuid, input.clientUuid));
          if (again) return reply.code(200).send(await summaryOf(again.id));
        }
        if (pg.constraint === 'comandas_open_cpf_unique') throw (await cpfConflict(protectedCpf.hmac)) ?? err;
        if (pg.constraint === 'comandas_open_name_per_table_unique') throw duplicateName(input.customerName, table.number);
      }
      throw err;
    }
  });

  /** Detalhe da comanda: itens (com a parte desta comanda nos rateados), subtotal e taxa prevista. */
  app.get('/:id', async (request): Promise<ComandaDetail> => {
    const { id: ref } = idParams.parse(request.params);
    // Aceita o clientUuid: o app pode ter aberto a comanda offline e ainda só conhecer esse id.
    const [found] = await db
      .select({ id: comandas.id })
      .from(comandas)
      .where(or(eq(comandas.id, ref), eq(comandas.clientUuid, ref)));
    if (!found) throw notFound('Comanda');
    const id = found.id;
    const summary = await summaryOf(id);
    const [extra] = await db
      .select({ phone: comandas.phone, cpfLast3: comandas.cpfLast3 })
      .from(comandas)
      .where(eq(comandas.id, id));

    const shareCount = db
      .select({ orderItemId: orderItemShares.orderItemId, n: sql<number>`count(*)::int`.as('n') })
      .from(orderItemShares)
      .groupBy(orderItemShares.orderItemId)
      .as('share_count');

    const rows = await db
      .select({
        orderItemId: orderItems.id,
        productName: orderItems.productNameSnapshot,
        qty: orderItems.qty,
        unitPriceCents: orderItems.unitPriceCents,
        notes: orderItems.notes,
        status: orderItems.status,
        amountCents: orderItemShares.amountCents,
        sharedWith: shareCount.n,
        createdAt: orders.receivedAt,
        waiterName: users.name,
      })
      .from(orderItemShares)
      .innerJoin(orderItems, eq(orderItems.id, orderItemShares.orderItemId))
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(users, eq(users.id, orders.userId))
      .innerJoin(shareCount, eq(shareCount.orderItemId, orderItems.id))
      .where(eq(orderItemShares.comandaId, id))
      .orderBy(orders.receivedAt, orderItems.createdAt);

    const items: ComandaItem[] = rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    // Mesma conta que o caixa vê: taxa, couvert do dia × pessoas e descontos já aplicados.
    const totals: ComandaTotals = (await loadBill(db, [id], await getSettings(db))).comandas[0]!.totals;

    return {
      ...summary,
      phone: extra!.phone,
      cpfLast3: extra!.cpfLast3,
      items,
      subtotalCents: totals.itemsCents,
      serviceFeeCents: totals.serviceFeeCents,
      couvertCents: totals.couvertCents,
      totalWithFeeCents: totals.totalCents,
    };
  });

  /** Garçom pede o fechamento: comanda fica EM_FECHAMENTO e avisa o caixa (SPEC 5.3). */
  app.post('/:id/request-close', async (request) => {
    const { id } = idParams.parse(request.params);
    const [row] = await db.select().from(comandas).where(eq(comandas.id, id));
    if (!row) throw notFound('Comanda');
    if (row.status === 'FECHADA' || row.status === 'CANCELADA') {
      throw new HttpError(409, WAITER_ERRORS.COMANDA_NOT_OPEN, 'Esta comanda já foi encerrada.');
    }
    if (row.status === 'ABERTA') {
      await db.transaction(async (tx) => {
        await tx
          .update(comandas)
          .set({ status: 'EM_FECHAMENTO', closingRequestedAt: new Date() })
          .where(and(eq(comandas.id, id), eq(comandas.status, 'ABERTA')));
        await audit(tx, request, { action: 'COMANDA_FECHAMENTO_SOLICITADO', entity: 'comanda', entityId: id });
      });
    }
    return summaryOf(id);
  });
}
