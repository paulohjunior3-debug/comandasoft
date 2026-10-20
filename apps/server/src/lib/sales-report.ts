import {
  PAYMENT_METHODS,
  type ComandaTotals,
  type MethodTotals,
  type ReceivedTotals,
  type SalesReport,
  type SalesReportQuery,
} from '@sistema-bar/shared';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  cashMovements,
  cashRegisters,
  cashSessions,
  comandas,
  fiscalRequests,
  orderItems,
  orderItemShares,
  paymentComandas,
  payments,
  users,
} from '../db/schema';
import type { Queryable } from './billing';

const zeroMethods = (): MethodTotals => Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as MethodTotals;
const zeroReceived = (): ReceivedTotals => ({ byMethod: zeroMethods(), cardCents: 0, totalCents: 0, payments: 0, fiscalCents: 0 });

function addPayment(t: ReceivedTotals, method: keyof MethodTotals, cents: number) {
  t.byMethod[method] += cents;
  if (method === 'CREDITO' || method === 'DEBITO') t.cardCents += cents;
  t.totalCents += cents;
  t.payments += 1;
}

/**
 * Relatório de vendas e entradas (SPEC 5.9). O "dia" é o dia do movimento informado na abertura
 * do caixa: um turno que abre às 16h e fecha à 01h conta inteiro nele. Filtro opcional por
 * período da semana do bar (Ter = 1 … Dom = 6).
 */
export async function buildSalesReport(db: Queryable, query: SalesReportQuery): Promise<SalesReport> {
  const closer = alias(users, 'closer');

  const sessionRows = await db
    .select({ s: cashSessions, registerName: cashRegisters.name, openedBy: users.name, closedBy: closer.name })
    .from(cashSessions)
    .innerJoin(cashRegisters, eq(cashRegisters.id, cashSessions.registerId))
    .innerJoin(users, eq(users.id, cashSessions.openedBy))
    .leftJoin(closer, eq(closer.id, cashSessions.closedBy))
    .where(
      and(
        gte(cashSessions.businessDate, query.from),
        lte(cashSessions.businessDate, query.to),
        query.registerId ? eq(cashSessions.registerId, query.registerId) : undefined,
        query.period ? eq(cashSessions.period, query.period) : undefined,
      ),
    )
    .orderBy(cashSessions.openedAt);

  const sessionIds = sessionRows.map((r) => r.s.id);
  const sessionById = new Map(sessionRows.map((r) => [r.s.id, r]));
  const dayOf = (sessionId: string) => sessionById.get(sessionId)!.s.businessDate;

  const [paymentRows, movementRows, fiscalRows] = sessionIds.length
    ? await Promise.all([
        db.select().from(payments).where(inArray(payments.cashSessionId, sessionIds)),
        db.select().from(cashMovements).where(inArray(cashMovements.cashSessionId, sessionIds)),
        db.select().from(fiscalRequests).where(inArray(fiscalRequests.cashSessionId, sessionIds)),
      ])
    : [[], [], []];

  // ---- Entradas por dia, por caixa e no total ----
  const received = zeroReceived();
  const days = new Map<string, SalesReport['days'][number]>();
  const registers = new Map<string, SalesReport['registers'][number]>();
  const dayEntry = (date: string, period: number | null = null) => {
    let d = days.get(date);
    if (!d) days.set(date, (d = { date, period, comandas: 0, salesCents: 0, ...zeroReceived() }));
    if (d.period === null && period !== null) d.period = period;
    return d;
  };
  const registerEntry = (sessionId: string) => {
    const r = sessionById.get(sessionId)!;
    let e = registers.get(r.s.registerId);
    if (!e) registers.set(r.s.registerId, (e = { registerId: r.s.registerId, name: r.registerName, sessions: 0, ...zeroReceived() }));
    return e;
  };
  for (const r of sessionRows) {
    dayEntry(r.s.businessDate, r.s.period);
    registerEntry(r.s.id).sessions += 1;
  }

  const refunds = { count: 0, totalCents: 0 };
  const receivedBySession = new Map<string, number>();
  for (const p of paymentRows) {
    if (p.status !== 'OK') {
      refunds.count += 1;
      refunds.totalCents += p.amountCents;
      continue;
    }
    addPayment(received, p.method, p.amountCents);
    addPayment(dayEntry(dayOf(p.cashSessionId)), p.method, p.amountCents);
    addPayment(registerEntry(p.cashSessionId), p.method, p.amountCents);
    receivedBySession.set(p.cashSessionId, (receivedBySession.get(p.cashSessionId) ?? 0) + p.amountCents);
  }

  // ---- Comandas: valores pagos e fechamento ----
  const okPaymentIds = paymentRows.filter((p) => p.status === 'OK').map((p) => p.id);
  const fiscalComandaIds = [...new Set(fiscalRows.flatMap((f) => f.comandaIds))];
  const paidComandaIds = okPaymentIds.length
    ? [...new Set((await db.select({ id: paymentComandas.comandaId }).from(paymentComandas).where(inArray(paymentComandas.paymentId, okPaymentIds))).map((r) => r.id))]
    : [];
  const comandaIds = [...new Set([...paidComandaIds, ...fiscalComandaIds])];

  const [comandaRows, allocationRows] = comandaIds.length
    ? await Promise.all([
        db.select().from(comandas).where(inArray(comandas.id, comandaIds)),
        // Todas as alocações válidas dessas comandas (inclusive de outros dias), para achar o último pagamento.
        db
          .select({ comandaId: paymentComandas.comandaId, amountCents: paymentComandas.amountCents, sessionId: payments.cashSessionId, at: payments.createdAt })
          .from(paymentComandas)
          .innerJoin(payments, eq(payments.id, paymentComandas.paymentId))
          .where(and(inArray(paymentComandas.comandaId, comandaIds), eq(payments.status, 'OK'))),
      ])
    : [[], []];

  const paidOf = (comandaId: string) => allocationRows.filter((a) => a.comandaId === comandaId).reduce((s, a) => s + a.amountCents, 0);

  // ---- Vendas: comandas fechadas cujo último pagamento caiu num caixa do período ----
  const sales = { comandas: 0, people: 0, itemsCents: 0, serviceFeeCents: 0, couvertCents: 0, discountCents: 0, totalCents: 0, averageTicketCents: 0 };
  const soldComandaIds: string[] = [];
  const soldDay = new Map<string, string>();
  for (const c of comandaRows) {
    if (c.status !== 'FECHADA' || !c.finalTotals) continue;
    const last = allocationRows.filter((a) => a.comandaId === c.id).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    if (!last || !sessionById.has(last.sessionId)) continue;
    const t = c.finalTotals as ComandaTotals;
    sales.comandas += 1;
    sales.people += c.peopleCount;
    sales.itemsCents += t.itemsCents;
    sales.serviceFeeCents += t.serviceFeeCents;
    sales.couvertCents += t.couvertCents;
    sales.discountCents += t.discountCents;
    sales.totalCents += t.totalCents;
    const day = dayEntry(dayOf(last.sessionId));
    day.comandas += 1;
    day.salesCents += t.totalCents;
    soldComandaIds.push(c.id);
    soldDay.set(c.id, day.date);
  }
  sales.averageTicketCents = sales.comandas ? Math.round(sales.totalCents / sales.comandas) : 0;

  // ---- Cupom fiscal: valor das comandas pedidas (cada comanda conta uma vez) ----
  const fiscal = { requests: fiscalRows.length, automatic: 0, comandas: 0, requestedCents: 0, withoutNoteCents: 0, pending: 0 };
  const counted = new Set<string>();
  for (const f of [...fiscalRows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (f.automatic) fiscal.automatic += 1;
    if (f.status === 'AGUARDANDO_MODULO_FISCAL') fiscal.pending += 1;
    for (const id of f.comandaIds) {
      if (counted.has(id)) continue;
      counted.add(id);
      const c = comandaRows.find((x) => x.id === id);
      const cents = c?.status === 'FECHADA' && c.finalTotals ? (c.finalTotals as ComandaTotals).totalCents : paidOf(id);
      fiscal.comandas += 1;
      fiscal.requestedCents += cents;
      dayEntry(dayOf(f.cashSessionId)).fiscalCents += cents;
      registerEntry(f.cashSessionId).fiscalCents += cents;
      received.fiscalCents += cents;
    }
  }
  fiscal.withoutNoteCents = Math.max(0, received.totalCents - fiscal.requestedCents);

  // ---- Caixa: fundo, suprimentos, sangrias e diferenças de fechamento ----
  const movementSum = (sessionId: string | null, type: 'SANGRIA' | 'SUPRIMENTO') =>
    movementRows.filter((m) => m.type === type && (sessionId === null || m.cashSessionId === sessionId)).reduce((s, m) => s + m.amountCents, 0);
  const cash = {
    sessions: sessionRows.length,
    openSessions: sessionRows.filter((r) => !r.s.closedAt).length,
    openingFloatCents: sessionRows.reduce((s, r) => s + r.s.openingFloatCents, 0),
    suprimentoCents: movementSum(null, 'SUPRIMENTO'),
    sangriaCents: movementSum(null, 'SANGRIA'),
    differenceCents: sessionRows.reduce((s, r) => s + (r.s.differenceCents ?? 0), 0),
  };

  // ---- Produtos vendidos (comandas fechadas) ----
  const productRows = soldComandaIds.length
    ? await db
        .select({
          orderItemId: orderItems.id,
          comandaId: orderItemShares.comandaId,
          name: orderItems.productNameSnapshot,
          qty: orderItems.qty,
          amountCents: orderItemShares.amountCents,
        })
        .from(orderItemShares)
        .innerJoin(orderItems, eq(orderItems.id, orderItemShares.orderItemId))
        .where(and(inArray(orderItemShares.comandaId, soldComandaIds), eq(orderItems.status, 'ATIVO')))
    : [];
  type Tally = { qty: number; totalCents: number; items: Set<string> };
  const tally = (t: Tally, r: (typeof productRows)[number]) => {
    // Item rateado entre comandas: a quantidade conta uma vez, o valor soma as partes.
    if (!t.items.has(r.orderItemId)) {
      t.items.add(r.orderItemId);
      t.qty += r.qty;
    }
    t.totalCents += r.amountCents;
  };
  const products = new Map<string, Tally & { name: string; days: Map<string, Tally> }>();
  for (const r of productRows) {
    let p = products.get(r.name);
    if (!p) products.set(r.name, (p = { name: r.name, qty: 0, totalCents: 0, items: new Set(), days: new Map() }));
    tally(p, r);
    const date = soldDay.get(r.comandaId)!;
    let d = p.days.get(date);
    if (!d) p.days.set(date, (d = { qty: 0, totalCents: 0, items: new Set() }));
    tally(d, r);
  }

  return {
    from: query.from,
    to: query.to,
    registerId: query.registerId ?? null,
    period: query.period ?? null,
    generatedAt: new Date().toISOString(),
    received,
    refunds,
    sales,
    fiscal,
    cash,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    registers: [...registers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    sessions: sessionRows.map((r) => ({
      id: r.s.id,
      registerName: r.registerName,
      date: r.s.businessDate,
      period: r.s.period,
      openedAt: r.s.openedAt.toISOString(),
      closedAt: r.s.closedAt?.toISOString() ?? null,
      openedBy: r.openedBy,
      closedBy: r.closedBy,
      openingFloatCents: r.s.openingFloatCents,
      receivedCents: receivedBySession.get(r.s.id) ?? 0,
      suprimentoCents: movementSum(r.s.id, 'SUPRIMENTO'),
      sangriaCents: movementSum(r.s.id, 'SANGRIA'),
      differenceCents: r.s.closedAt ? r.s.differenceCents : null,
    })),
    products: [...products.values()]
      .map(({ name, qty, totalCents, days }) => ({
        name,
        qty,
        totalCents,
        days: [...days].map(([date, d]) => ({ date, qty: d.qty, totalCents: d.totalCents })).sort((a, b) => a.date.localeCompare(b.date)),
      }))
      .sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name)),
  };
}
