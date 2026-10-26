import {
  changePaymentMethodSchema,
  formatBRL,
  splitPaymentSchema,
  closedBillsQuerySchema,
  closedBillsPrintSchema,
  suggestedBusinessDate,
  type CanceledTableBill,
  type ClosedBillsResponse,
  type ClosedTableBill,
  type ComandaTotals,
} from '@sistema-bar/shared';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { cashRegisters, cashSessions, comandas, diningTables, orderItems, orderItemShares, paymentComandas, payments, printers, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { authorizeManager } from '../../lib/authorize';
import { loadBill } from '../../lib/billing';
import { billTicket, enqueueCashierPrint } from '../../lib/cashier-print';
import { HttpError, notFound } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import { renderJob } from '../../printing/worker';
import { idParams } from '../admin/params';
import { getRegister } from './session';

/**
 * Contas fechadas do dia (do movimento): para reimprimir o descritivo quando o cliente volta
 * pedindo, e para corrigir a forma de pagamento lançada errada (ex.: era dinheiro, foi cartão).
 */
export async function cashierClosedRoutes(app: FastifyInstance, { db, printWorker }: AppDeps) {
  /** Mesas canceladas no período: as comandas encerradas juntas (mesmo instante) formam uma. */
  async function canceledTables(from: Date, to: Date, ranges: (readonly [number, number])[]): Promise<CanceledTableBill[]> {
    const rows = (
      await db
        .select({ c: comandas, tableNumber: diningTables.number, isCounter: diningTables.isCounter })
        .from(comandas)
        .innerJoin(diningTables, eq(diningTables.id, comandas.tableId))
        .where(and(eq(comandas.status, 'CANCELADA'), gte(comandas.closedAt, from), lte(comandas.closedAt, to)))
    ).filter((r) => ranges.some(([a, b]) => r.c.closedAt!.getTime() >= a && r.c.closedAt!.getTime() <= b));
    if (!rows.length) return [];
    const items = await db
      .select({ comandaId: orderItemShares.comandaId, amountCents: orderItemShares.amountCents, canceledAt: orderItems.canceledAt, reason: orderItems.cancelReason })
      .from(orderItemShares)
      .innerJoin(orderItems, eq(orderItems.id, orderItemShares.orderItemId))
      .where(and(inArray(orderItemShares.comandaId, rows.map((r) => r.c.id)), eq(orderItems.status, 'CANCELADO')));
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.c.tableId}|${r.c.closedAt!.getTime()}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups.values()]
      .map((g) => {
        const at = g[0]!.c.closedAt!;
        const mine = items.filter((i) => g.some((r) => r.c.id === i.comandaId) && i.canceledAt?.getTime() === at.getTime());
        return {
          comandaIds: g.map((r) => r.c.id),
          tableNumber: g[0]!.tableNumber,
          tableLabel: g[0]!.isCounter ? 'Balcão' : null,
          customers: g.map((r) => r.c.customerName),
          canceledAt: at.toISOString(),
          reason: mine[0]?.reason ?? null,
          itemsCents: mine.reduce((s, i) => s + i.amountCents, 0),
        };
      })
      .sort((a, b) => b.canceledAt.localeCompare(a.canceledAt));
  }

  app.get('/closed-comandas', async (request): Promise<ClosedBillsResponse> => {
    const query = closedBillsQuerySchema.parse(request.query);
    // Sem data: o dia do caixa aberto (ou do último que abriu).
    let date = query.date;
    if (!date) {
      const [last] = await db.select({ d: cashSessions.businessDate }).from(cashSessions).orderBy(desc(cashSessions.openedAt)).limit(1);
      date = last?.d ?? suggestedBusinessDate();
    }
    const sessionRows = await db
      .select({ s: cashSessions, registerName: cashRegisters.name })
      .from(cashSessions)
      .innerJoin(cashRegisters, eq(cashRegisters.id, cashSessions.registerId))
      .where(eq(cashSessions.businessDate, date))
      .orderBy(cashSessions.openedAt);
    const sessions = sessionRows.map((r) => r.s);
    const sessionInfo = sessionRows.map((r) => ({
      registerName: r.registerName,
      openedAt: r.s.openedAt.toISOString(),
      closedAt: r.s.closedAt?.toISOString() ?? null,
    }));
    if (sessions.length === 0) return { date, sessions: sessionInfo, bills: [], canceled: [] };
    const ranges = sessions.map((s) => [s.openedAt.getTime(), (s.closedAt ?? new Date()).getTime()] as const);
    const from = new Date(Math.min(...ranges.map((r) => r[0])));
    const to = new Date(Math.max(...ranges.map((r) => r[1])));

    const rows = (
      await db
        .select({ c: comandas, tableNumber: diningTables.number, isCounter: diningTables.isCounter })
        .from(comandas)
        .innerJoin(diningTables, eq(diningTables.id, comandas.tableId))
        .where(and(eq(comandas.status, 'FECHADA'), gte(comandas.closedAt, from), lte(comandas.closedAt, to)))
    ).filter((r) => ranges.some(([a, b]) => r.c.closedAt!.getTime() >= a && r.c.closedAt!.getTime() <= b));
    const canceled = await canceledTables(from, to, ranges);
    if (rows.length === 0) return { date, sessions: sessionInfo, bills: [], canceled };

    const pays = await db
      .select({ p: payments, comandaId: paymentComandas.comandaId, userName: users.name, sessionClosedAt: cashSessions.closedAt })
      .from(paymentComandas)
      .innerJoin(payments, eq(payments.id, paymentComandas.paymentId))
      .innerJoin(users, eq(users.id, payments.userId))
      .innerJoin(cashSessions, eq(cashSessions.id, payments.cashSessionId))
      .where(inArray(paymentComandas.comandaId, rows.map((r) => r.c.id)));

    // Uma conta = as comandas da mesma ocupação da mesa (uma nova começa depois que a anterior fechou).
    const bills: ClosedTableBill[] = [];
    const byTable = new Map<string, typeof rows>();
    for (const r of rows) byTable.set(r.c.tableId, [...(byTable.get(r.c.tableId) ?? []), r]);
    for (const list of byTable.values()) {
      list.sort((a, b) => a.c.openedAt.getTime() - b.c.openedAt.getTime());
      let group: typeof rows = [];
      const flush = () => {
        if (!group.length) return;
        const ids = group.map((g) => g.c.id);
        const seen = new Set<string>();
        const groupPays = pays.filter((p) => ids.includes(p.comandaId) && !seen.has(p.p.id) && seen.add(p.p.id));
        bills.push({
          key: ids.join(','),
          tableNumber: group[0]!.tableNumber,
          tableLabel: group[0]!.isCounter ? 'Balcão' : null,
          openedAt: new Date(Math.min(...group.map((g) => g.c.openedAt.getTime()))).toISOString(),
          closedAt: new Date(Math.max(...group.map((g) => g.c.closedAt!.getTime()))).toISOString(),
          comandas: group.map((g) => ({
            id: g.c.id,
            customerName: g.c.customerName,
            phone: g.c.phone,
            totalCents: (g.c.finalTotals as ComandaTotals | null)?.totalCents ?? 0,
            closedAt: g.c.closedAt!.toISOString(),
          })),
          totalCents: group.reduce((s, g) => s + ((g.c.finalTotals as ComandaTotals | null)?.totalCents ?? 0), 0),
          payments: groupPays
            .sort((a, b) => a.p.createdAt.getTime() - b.p.createdAt.getTime())
            .map(({ p, userName, sessionClosedAt }) => ({
              id: p.id,
              method: p.method,
              amountCents: p.amountCents,
              changeCents: p.changeCents,
              payerName: p.payerName,
              status: p.status,
              createdAt: p.createdAt.toISOString(),
              userName,
              editable: p.status === 'OK' && sessionClosedAt === null,
            })),
        });
        group = [];
      };
      for (const r of list) {
        const lastClose = Math.max(0, ...group.map((g) => g.c.closedAt!.getTime()));
        if (group.length && r.c.openedAt.getTime() > lastClose) flush();
        group.push(r);
      }
      flush();
    }
    bills.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
    return { date, sessions: sessionInfo, bills, canceled };
  });

  /** Reimprime o descritivo (cupom de consumo) de uma conta fechada, marcado como reimpressão. */
  app.post('/closed-comandas/print', async (request) => {
    const { comandaIds, registerId } = closedBillsPrintSchema.parse(request.body);
    const settings = await getSettings(db);
    const register = registerId ? await getRegister(db, registerId) : null;
    const bill = await loadBill(db, [...new Set(comandaIds)], settings);
    if (bill.comandas.length === 0) throw notFound('Comanda');
    const ticket = { ...billTicket(bill, 'CUPOM', settings, register ? `${request.user!.name} · ${register.name}` : request.user!.name), reprint: true };
    const printed = await enqueueCashierPrint(db, settings, ticket, undefined, register?.printerId);
    if (!printed) throw new HttpError(409, 'NO_CASHIER_PRINTER', 'Escolha a impressora do caixa em Administração > Configurações.');
    printWorker.kick();
    return { printed };
  });

  /** O mesmo descritivo, na tela (como sai no papel da impressora do caixa), sem imprimir. */
  app.post('/closed-comandas/preview', async (request) => {
    const { comandaIds, registerId } = closedBillsPrintSchema.parse(request.body);
    const settings = await getSettings(db);
    const register = registerId ? await getRegister(db, registerId) : null;
    const bill = await loadBill(db, [...new Set(comandaIds)], settings);
    if (bill.comandas.length === 0) throw notFound('Comanda');
    const ticket = billTicket(bill, 'CUPOM', settings, register ? `${request.user!.name} · ${register.name}` : request.user!.name);
    const printerId = register?.printerId ?? settings.cashierPrinterId;
    const [printer] = printerId ? await db.select().from(printers).where(eq(printers.id, printerId)) : [];
    const layout = printer ?? { widthMm: 80, codepage: 'CP860', cut: true };
    return { text: renderJob(ticket, layout).preview, widthMm: layout.widthMm === 58 ? 58 : 80 };
  });

  /**
   * Corrige como o pagamento foi feito, dividindo em várias formas (ex.: R$ 30 dinheiro, R$ 40
   * débito e o resto crédito). A primeira parte fica no pagamento original; as outras viram
   * pagamentos novos do mesmo caixa, com a parte de cada comanda dividida na proporção.
   * Gerente (ou PIN), com motivo, e só com o caixa desse pagamento aberto.
   */
  app.post('/payments/:id/split', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { parts, reason, authorizerPin } = splitPaymentSchema.parse(request.body);
    const [row] = await db
      .select({ p: payments, sessionClosedAt: cashSessions.closedAt })
      .from(payments)
      .innerJoin(cashSessions, eq(cashSessions.id, payments.cashSessionId))
      .where(eq(payments.id, id));
    if (!row) throw notFound('Pagamento');
    const p = row.p;
    if (p.status !== 'OK') throw new HttpError(409, 'ALREADY_REFUNDED', 'Este pagamento foi estornado.');
    if (row.sessionClosedAt) {
      throw new HttpError(409, 'OTHER_SESSION', 'O caixa deste pagamento já foi fechado; a forma de pagamento não pode mais ser alterada.');
    }
    const total = parts.reduce((s, x) => s + x.amountCents, 0);
    if (total !== p.amountCents) {
      throw new HttpError(400, 'VALIDATION', `A soma das formas (${formatBRL(total)}) tem de ser o valor do pagamento (${formatBRL(p.amountCents)}).`);
    }
    if (parts.length === 1 && parts[0]!.method === p.method) throw new HttpError(409, 'SAME_METHOD', 'O pagamento já está nessa forma.');
    const authorizer = await authorizeManager(db, request, authorizerPin);
    const allocations = await db.select().from(paymentComandas).where(eq(paymentComandas.paymentId, id));

    const created = await db.transaction(async (tx) => {
      const cash = (m: string, cents: number) => ({ tenderedCents: m === 'DINHEIRO' ? cents : null, changeCents: 0 });
      const [first, ...others] = parts;
      await tx
        .update(payments)
        .set({ method: first!.method, amountCents: first!.amountCents, ...cash(first!.method, first!.amountCents) })
        .where(eq(payments.id, id));
      // A parte de cada comanda em cada forma, na proporção (centavos que sobram vão para a 1ª comanda).
      const shareOf = (cents: number) => {
        const out = allocations.map((a) => Math.floor((a.amountCents * cents) / p.amountCents));
        out[0]! += cents - out.reduce((s, v) => s + v, 0);
        return out;
      };
      const firstShares = shareOf(first!.amountCents);
      for (const [i, a] of allocations.entries()) {
        await tx
          .update(paymentComandas)
          .set({ amountCents: firstShares[i]! })
          .where(and(eq(paymentComandas.paymentId, id), eq(paymentComandas.comandaId, a.comandaId)));
      }
      const ids: string[] = [];
      for (const part of others) {
        const [n] = await tx
          .insert(payments)
          .values({
            clientUuid: randomUUID(),
            cashSessionId: p.cashSessionId,
            method: part.method,
            amountCents: part.amountCents,
            ...cash(part.method, part.amountCents),
            payerName: p.payerName,
            userId: p.userId,
            createdAt: p.createdAt,
          })
          .returning({ id: payments.id });
        const shares = shareOf(part.amountCents);
        const rows = allocations.map((a, i) => ({ paymentId: n!.id, comandaId: a.comandaId, amountCents: shares[i]! })).filter((r) => r.amountCents > 0);
        if (rows.length) await tx.insert(paymentComandas).values(rows);
        ids.push(n!.id);
      }
      await audit(tx, request, {
        action: 'PAGAMENTO_FORMA_ALTERADA',
        entity: 'payment',
        entityId: id,
        before: { method: p.method, amountCents: p.amountCents, changeCents: p.changeCents },
        after: { parts, reason, authorizedBy: authorizer.name, newPayments: ids },
      });
      return ids;
    });
    return { ok: true, payments: [id, ...created] };
  });

  /**
   * Corrige a forma de pagamento (ex.: era dinheiro e foi lançado como cartão). Gerente (ou PIN),
   * com motivo, e só enquanto o caixa desse pagamento está aberto: o fechamento confere por forma.
   */
  app.post('/payments/:id/method', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { method, reason, authorizerPin } = changePaymentMethodSchema.parse(request.body);
    const [row] = await db
      .select({ p: payments, sessionClosedAt: cashSessions.closedAt })
      .from(payments)
      .innerJoin(cashSessions, eq(cashSessions.id, payments.cashSessionId))
      .where(eq(payments.id, id));
    if (!row) throw notFound('Pagamento');
    if (row.p.status !== 'OK') throw new HttpError(409, 'ALREADY_REFUNDED', 'Este pagamento foi estornado.');
    if (row.sessionClosedAt) {
      throw new HttpError(409, 'OTHER_SESSION', 'O caixa deste pagamento já foi fechado; a forma de pagamento não pode mais ser alterada.');
    }
    if (row.p.method === method) throw new HttpError(409, 'SAME_METHOD', 'O pagamento já está nessa forma.');
    const authorizer = await authorizeManager(db, request, authorizerPin);
    await db.transaction(async (tx) => {
      await tx
        .update(payments)
        // Dinheiro: considera entregue o valor exato (sem troco); outras formas não têm troco.
        .set({ method, tenderedCents: method === 'DINHEIRO' ? row.p.amountCents : null, changeCents: 0 })
        .where(eq(payments.id, id));
      await audit(tx, request, {
        action: 'PAGAMENTO_FORMA_ALTERADA',
        entity: 'payment',
        entityId: id,
        before: { method: row.p.method, amountCents: row.p.amountCents, changeCents: row.p.changeCents },
        after: { method, reason, authorizedBy: authorizer.name },
      });
    });
    return { ok: true };
  });
}
