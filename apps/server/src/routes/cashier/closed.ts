import {
  changePaymentMethodSchema,
  closedBillsQuerySchema,
  closedBillsPrintSchema,
  suggestedBusinessDate,
  type ClosedBillsResponse,
  type ClosedTableBill,
  type ComandaTotals,
} from '@sistema-bar/shared';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { cashRegisters, cashSessions, comandas, diningTables, paymentComandas, payments, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { authorizeManager } from '../../lib/authorize';
import { loadBill } from '../../lib/billing';
import { billTicket, enqueueCashierPrint } from '../../lib/cashier-print';
import { HttpError, notFound } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import { idParams } from '../admin/params';
import { getRegister } from './session';

/**
 * Contas fechadas do dia (do movimento): para reimprimir o descritivo quando o cliente volta
 * pedindo, e para corrigir a forma de pagamento lançada errada (ex.: era dinheiro, foi cartão).
 */
export async function cashierClosedRoutes(app: FastifyInstance, { db, printWorker }: AppDeps) {
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
    if (sessions.length === 0) return { date, sessions: sessionInfo, bills: [] };
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
    if (rows.length === 0) return { date, sessions: sessionInfo, bills: [] };

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
    return { date, sessions: sessionInfo, bills };
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
