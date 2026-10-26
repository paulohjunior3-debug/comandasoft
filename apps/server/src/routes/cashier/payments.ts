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
import { cashSessions, comandas, fiscalRequests, paymentComandas, paymentItems, payments } from '../../db/schema';
import { audit } from '../../lib/audit';
import { authorizeManager } from '../../lib/authorize';
import { loadBill } from '../../lib/billing';
import { enqueueCashierPrint } from '../../lib/cashier-print';
import { OPEN_STATUSES } from '../../lib/comandas';
import { HttpError, notFound, pgError } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import { configRow, settingsOf } from '../../fiscal/config';
import { emitNfce } from '../../fiscal/nfce/emit';
import { idParams } from '../admin/params';
import { getRegister, requireOpenSession } from './session';

export async function cashierPaymentRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, printWorker } = deps;
  async function existingResult(paymentId: string): Promise<CreatePaymentResult> {
    const [p] = await db.select().from(payments).where(eq(payments.id, paymentId));
    const [s] = await db.select().from(cashSessions).where(eq(cashSessions.id, p!.cashSessionId));
    const register = await getRegister(db, s!.registerId);
    return { paymentId, changeCents: p!.changeCents, closedComandaIds: [], duplicate: true, fiscalMode: register.fiscalMode, fiscalRequested: false };
  }

  /**
   * Recebimento (SPEC 5.7): uma ou várias comandas; valor livre, por item, por fração ou por
   * valor de um item ("R$ 15,00 do filé"); qualquer forma de pagamento; troco no dinheiro.
   * Ao zerar o restante a comanda fecha; o cupom (não fiscal ou fiscal) é escolhido depois,
   * na finalização. Idempotente por clientUuid: clique duplo não cobra duas vezes.
   */
  app.post('/', async (request, reply) => {
    const input = createPaymentSchema.parse(request.body);
    const [already] = await db.select({ id: payments.id }).from(payments).where(eq(payments.clientUuid, input.clientUuid));
    if (already) return reply.code(200).send(await existingResult(already.id));

    const register = await getRegister(db, input.registerId);
    const session = await requireOpenSession(db, register.id);
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
          // Por item / fração / valor: a parte do item + a taxa de serviço proporcional daquela comanda.
          const perComanda = new Map<string, number>();
          for (const sel of input.items) {
            const item = bill.items.find((i) => i.orderItemId === sel.orderItemId && i.comandaId === sel.comandaId);
            if (!item || item.amountCents === 0) throw new HttpError(400, 'VALIDATION', 'Item inválido para esta conta.');

            let part: number | null;
            let fraction: { num: number; den: number };
            if (sel.amountCents !== undefined) {
              // Valor de um item (quem vai embora antes paga só a parte dele do filé).
              part = item.paidCents + sel.amountCents <= item.amountCents ? sel.amountCents : null;
              fraction = { num: sel.amountCents, den: item.amountCents };
            } else {
              fraction = { num: sel.num!, den: sel.den! };
              part = fractionAmount(item.amountCents, fraction, { fraction: item.paidFraction, cents: item.paidCents });
            }
            if (part === null) {
              const left = item.amountCents - item.paidCents;
              throw new HttpError(
                409,
                CASHIER_ERRORS.ITEM_OVERPAID,
                `"${item.productName}" passa do valor: falta pagar R$ ${(left / 100).toFixed(2).replace('.', ',')} dele.`,
              );
            }
            const comanda = bill.comandas.find((c) => c.id === sel.comandaId)!;
            const fee = bill.serviceFeeEnabled && !comanda.serviceFeeWaived ? percentOf(part, SERVICE_FEE_BPS) : 0;
            perComanda.set(sel.comandaId, (perComanda.get(sel.comandaId) ?? 0) + part + fee);
            itemRows.push({
              paymentId: '',
              orderItemId: sel.orderItemId,
              comandaId: sel.comandaId,
              fractionNum: fraction.num,
              fractionDen: fraction.den,
              itemAmountCents: part,
            });
            // Para a próxima parte do mesmo item na mesma requisição.
            item.paidCents += part;
            item.paidFraction = addFractions(item.paidFraction, fraction);
          }
          allocations = [...perComanda].map(([id, amountCents]) => ({ id, amountCents: Math.min(amountCents, remainingOf.get(id) ?? 0) }));
          const expected = allocations.reduce((s, a) => s + a.amountCents, 0);
          if (expected !== input.amountCents) {
            throw new HttpError(409, 'AMOUNT_CHANGED', `O valor dos itens selecionados é R$ ${(expected / 100).toFixed(2).replace('.', ',')}; atualize a tela e confira.`);
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

        // Caixa configurado para emitir fiscal em tudo: o pedido do cupom fiscal já sai aqui.
        const fiscalRequested = register.fiscalMode === 'AUTOMATICO' && closedIds.length > 0;
        let fiscalRequestId: string | undefined;
        if (fiscalRequested) {
          const [fr] = await tx
            .insert(fiscalRequests)
            .values({ cashSessionId: session.id, comandaIds: closedIds, automatic: true, requestedBy: request.user!.id })
            .returning({ id: fiscalRequests.id });
          fiscalRequestId = fr!.id;
        }

        await audit(tx, request, {
          action: 'PAGAMENTO',
          entity: 'payment',
          entityId: payment!.id,
          after: {
            register: register.name,
            method: input.method,
            amountCents: input.amountCents,
            changeCents: change,
            payerName: input.payerName,
            allocations,
            items: itemRows.map((r) => ({ orderItemId: r.orderItemId, cents: r.itemAmountCents })),
            closedIds,
            fiscalRequested,
          },
        });

        // Dinheiro: abre a gaveta na hora (o cupom é escolhido na finalização).
        if (input.method === 'DINHEIRO') {
          await enqueueCashierPrint(tx, settings, { kind: 'GAVETA' }, payment!.id, register.printerId);
        }

        return {
          paymentId: payment!.id,
          changeCents: change,
          closedComandaIds: closedIds,
          duplicate: false,
          fiscalMode: register.fiscalMode,
          fiscalRequested,
          fiscalRequestId,
        };
      });
      printWorker.kick();
      const { fiscalRequestId, ...out } = result;
      const body: CreatePaymentResult = out;
      if (fiscalRequestId && settingsOf(await configRow(db)).emissionEnabled) {
        try {
          const r = await emitNfce(deps, { request, comandaIds: result.closedComandaIds, cpfOnNote: true, fiscalRequestId, registerPrinterId: register.printerId });
          body.fiscal = { status: r.status, message: r.message, number: r.number, accessKey: r.accessKey };
        } catch (err) {
          body.fiscal = { status: 'REJEITADA', message: err instanceof Error ? err.message : 'Não foi possível emitir a NFC-e.' };
        }
      }
      return reply.code(201).send(body);
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
    const [session] = await db.select().from(cashSessions).where(eq(cashSessions.id, payment.cashSessionId));
    if (session?.closedAt) {
      throw new HttpError(409, 'OTHER_SESSION', 'Este pagamento é de um caixa já fechado; não pode mais ser estornado aqui.');
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
