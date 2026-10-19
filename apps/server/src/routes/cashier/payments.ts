import {
  addFractions,
  allocateSequential,
  CASHIER_ERRORS,
  createPaymentSchema,
  fractionAmount,
  percentOf,
  refundPaymentSchema,
  SERVICE_FEE_BPS,
  type ComandaTotals,
  type CreatePaymentResult,
} from '@sistema-bar/shared';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { comandas, paymentComandas, paymentItems, payments } from '../../db/schema';
import { audit } from '../../lib/audit';
import { authorizeManager } from '../../lib/authorize';
import { loadBill } from '../../lib/billing';
import { billTicket, enqueueCashierPrint } from '../../lib/cashier-print';
import { OPEN_STATUSES } from '../../lib/comandas';
import { HttpError, notFound, pgError } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import { idParams } from '../admin/params';
import { requireOpenSession } from './session';

export async function cashierPaymentRoutes(app: FastifyInstance, { db, printWorker }: AppDeps) {
  async function existingResult(paymentId: string): Promise<CreatePaymentResult> {
    const [p] = await db.select().from(payments).where(eq(payments.id, paymentId));
    return { paymentId, changeCents: p!.changeCents, closedComandaIds: [], duplicate: true };
  }

  /**
   * Recebimento (SPEC 5.7): uma ou várias comandas, valor livre ou por item/fração, qualquer
   * forma de pagamento, troco no dinheiro. Ao zerar o restante a comanda fecha e o cupom sai.
   * Idempotente por clientUuid: clique duplo não cobra duas vezes.
   */
  app.post('/', async (request, reply) => {
    const input = createPaymentSchema.parse(request.body);
    const [already] = await db.select({ id: payments.id }).from(payments).where(eq(payments.clientUuid, input.clientUuid));
    if (already) return reply.code(200).send(await existingResult(already.id));

    const session = await requireOpenSession(db);
    const settings = await getSettings(db);
    const comandaIds = [...new Set(input.comandaIds)];

    try {
      const result = await db.transaction(async (tx) => {
        // Trava as comandas: dois caixas não recebem a mesma conta ao mesmo tempo.
        const locked = await tx.select().from(comandas).where(inArray(comandas.id, comandaIds)).for('update');
        if (locked.length !== comandaIds.length) throw notFound('Comanda');
        const closed = locked.filter((c) => !(OPEN_STATUSES as readonly string[]).includes(c.status));
        if (closed.length) {
          throw new HttpError(409, 'COMANDA_NOT_OPEN', `Comanda já encerrada: ${closed.map((c) => c.customerName).join(', ')}.`);
        }

        const bill = await loadBill(tx, comandaIds, settings);
        const remainingOf = new Map(bill.comandas.map((c) => [c.id, c.totals.remainingCents]));

        // ---- Quanto vai para cada comanda ----
        let allocations: { id: string; amountCents: number }[];
        const itemRows: (typeof paymentItems.$inferInsert)[] = [];

        if (input.items?.length) {
          // Por item / fração: valor do item + a taxa de serviço proporcional daquela comanda.
          const perComanda = new Map<string, number>();
          for (const sel of input.items) {
            const item = bill.items.find((i) => i.orderItemId === sel.orderItemId && i.comandaId === sel.comandaId);
            if (!item || item.amountCents === 0) throw new HttpError(400, 'VALIDATION', 'Item inválido para esta conta.');
            const part = fractionAmount(item.amountCents, { num: sel.num, den: sel.den }, { fraction: item.paidFraction, cents: item.paidCents });
            if (part === null) {
              throw new HttpError(409, CASHIER_ERRORS.ITEM_OVERPAID, `"${item.productName}" já foi pago (ou a fração passa do item).`);
            }
            const comanda = bill.comandas.find((c) => c.id === sel.comandaId)!;
            const fee = bill.serviceFeeEnabled && !comanda.serviceFeeWaived ? percentOf(part, SERVICE_FEE_BPS) : 0;
            perComanda.set(sel.comandaId, (perComanda.get(sel.comandaId) ?? 0) + part + fee);
            itemRows.push({
              paymentId: '',
              orderItemId: sel.orderItemId,
              comandaId: sel.comandaId,
              fractionNum: sel.num,
              fractionDen: sel.den,
              itemAmountCents: part,
            });
            // Para a próxima fração do mesmo item na mesma requisição.
            item.paidCents += part;
            item.paidFraction = addFractions(item.paidFraction, { num: sel.num, den: sel.den });
          }
          allocations = [...perComanda].map(([id, amountCents]) => ({ id, amountCents: Math.min(amountCents, remainingOf.get(id) ?? 0) }));
          const expected = allocations.reduce((s, a) => s + a.amountCents, 0);
          if (expected !== input.amountCents) {
            throw new HttpError(409, 'AMOUNT_CHANGED', `O valor dos itens selecionados é ${expected / 100} — atualize a tela e confira.`);
          }
        } else {
          const r = allocateSequential(
            input.amountCents,
            comandaIds.map((id) => ({ id, remainingCents: remainingOf.get(id) ?? 0 })),
          );
          if (r.unallocated > 0) {
            throw new HttpError(409, CASHIER_ERRORS.OVERPAYMENT, 'O valor é maior que o restante da conta. Para dinheiro, informe o valor entregue para calcular o troco.');
          }
          allocations = r.allocations;
        }

        // ---- Troco ----
        let tendered: number | null = null;
        let change = 0;
        if (input.method === 'DINHEIRO') {
          tendered = input.tenderedCents ?? input.amountCents;
          if (tendered < input.amountCents) {
            throw new HttpError(400, CASHIER_ERRORS.INSUFFICIENT_CASH, 'O valor entregue é menor que o valor a pagar.');
          }
          change = tendered - input.amountCents;
        }

        const [payment] = await tx
          .insert(payments)
          .values({
            clientUuid: input.clientUuid,
            cashSessionId: session.id,
            method: input.method,
            amountCents: input.amountCents,
            tenderedCents: tendered,
            changeCents: change,
            payerName: input.payerName,
            userId: request.user!.id,
          })
          .returning();
        await tx.insert(paymentComandas).values(allocations.map((a) => ({ paymentId: payment!.id, comandaId: a.id, amountCents: a.amountCents })));
        if (itemRows.length) await tx.insert(paymentItems).values(itemRows.map((r) => ({ ...r, paymentId: payment!.id })));

        // ---- Fecha as comandas quitadas, congelando os totais ----
        const closedIds: string[] = [];
        for (const c of bill.comandas) {
          const paidNow = allocations.find((a) => a.id === c.id)?.amountCents ?? 0;
          if (paidNow === 0 || c.totals.remainingCents - paidNow > 0) continue;
          const finalTotals: ComandaTotals = { ...c.totals, paidCents: c.totals.paidCents + paidNow, remainingCents: 0 };
          await tx.update(comandas).set({ status: 'FECHADA', closedAt: new Date(), finalTotals }).where(eq(comandas.id, c.id));
          closedIds.push(c.id);
        }

        await audit(tx, request, {
          action: 'PAGAMENTO',
          entity: 'payment',
          entityId: payment!.id,
          after: { method: input.method, amountCents: input.amountCents, changeCents: change, payerName: input.payerName, allocations, closedIds },
        });

        // ---- Cupom final e gaveta ----
        if (closedIds.length) {
          const closedBill = await loadBill(tx, closedIds, settings);
          await enqueueCashierPrint(tx, settings, billTicket(closedBill, 'CUPOM', settings, request.user!.name, input.method === 'DINHEIRO'), payment!.id);
        } else if (input.method === 'DINHEIRO') {
          await enqueueCashierPrint(tx, settings, { kind: 'GAVETA' }, payment!.id);
        }

        return { paymentId: payment!.id, changeCents: change, closedComandaIds: closedIds, duplicate: false } satisfies CreatePaymentResult;
      });
      printWorker.kick();
      return reply.code(201).send(result);
    } catch (err) {
      const pg = pgError(err);
      if (pg?.code === '23505' && pg.constraint === 'payments_client_uuid_unique') {
        const [again] = await db.select({ id: payments.id }).from(payments).where(eq(payments.clientUuid, input.clientUuid));
        if (again) return reply.code(200).send(await existingResult(again.id));
      }
      throw err;
    }
  });

  /** Estorno (SPEC 5.7): gerente, com motivo. Comandas que ele tinha fechado voltam a ficar abertas. */
  app.post('/:id/refund', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { reason, authorizerPin } = refundPaymentSchema.parse(request.body);
    const [payment] = await db.select().from(payments).where(eq(payments.id, id));
    if (!payment) throw notFound('Pagamento');
    if (payment.status !== 'OK') throw new HttpError(409, 'ALREADY_REFUNDED', 'Este pagamento já foi estornado.');
    const session = await requireOpenSession(db);
    if (payment.cashSessionId !== session.id) {
      throw new HttpError(409, 'OTHER_SESSION', 'Só é possível estornar pagamentos do caixa aberto agora.');
    }
    const authorizer = await authorizeManager(db, request, authorizerPin);

    const reopened = await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({ status: 'ESTORNADO', refundedBy: authorizer.id, refundReason: reason, refundedAt: new Date() })
        .where(eq(payments.id, id));
      const affected = await tx.select({ comandaId: paymentComandas.comandaId }).from(paymentComandas).where(eq(paymentComandas.paymentId, id));
      const toReopen = (
        await tx
          .select({ id: comandas.id, status: comandas.status })
          .from(comandas)
          .where(inArray(comandas.id, affected.map((a) => a.comandaId)))
      ).filter((c) => c.status === 'FECHADA');
      if (toReopen.length) {
        await tx
          .update(comandas)
          .set({ status: 'ABERTA', closedAt: null, finalTotals: null })
          .where(inArray(comandas.id, toReopen.map((c) => c.id)));
      }
      await audit(tx, request, {
        action: 'ESTORNO',
        entity: 'payment',
        entityId: id,
        before: { status: 'OK', amountCents: payment.amountCents, method: payment.method },
        after: { reason, authorizedBy: authorizer.name, reopened: toReopen.map((c) => c.id) },
      });
      return toReopen.map((c) => c.id);
    });
    return { ok: true, reopenedComandaIds: reopened };
  });
}

