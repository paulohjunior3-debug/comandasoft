import {
  addFractions,
  computeTotals,
  couvertFor,
  tableLabel,
  sumTotals,
  type Bill,
  type BillAdjustment,
  type BillComanda,
  type BillItem,
  type BillPayment,
  type ComandaTotals,
  type Fraction,
  type Settings,
} from '@sistema-bar/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  adjustments,
  comandas,
  diningTables,
  orderItems,
  orderItemShares,
  orders,
  paymentComandas,
  paymentItems,
  payments,
  users,
} from '../db/schema';
import { getDayRules } from './day-rules';

/** Conexão normal ou transação: as consultas são as mesmas. */
export type Queryable = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Monta a conta (SPEC 5.7) de um conjunto de comandas: itens com a parte de cada comanda,
 * ajustes, pagamentos e os totais calculados pela regra única de `computeTotals`.
 * Comandas fechadas usam os totais congelados no fechamento.
 */
export async function loadBill(db: Queryable, comandaIds: string[], settings: Settings): Promise<Bill> {
  const rows = await db
    .select({ comanda: comandas, tableNumber: diningTables.number, isCounter: diningTables.isCounter })
    .from(comandas)
    .innerJoin(diningTables, eq(diningTables.id, comandas.tableId))
    .where(inArray(comandas.id, comandaIds));
  // Mantém a ordem pedida (é a ordem de quitação dos pagamentos).
  const ordered = comandaIds.map((id) => rows.find((r) => r.comanda.id === id)).filter((r) => r !== undefined);

  const shareCount = db
    .select({ orderItemId: orderItemShares.orderItemId, n: sql<number>`count(*)::int`.as('n') })
    .from(orderItemShares)
    .groupBy(orderItemShares.orderItemId)
    .as('share_count');

  const [itemRows, paidItemRows, adjustmentRows, paymentRows] = await Promise.all([
    db
      .select({
        orderItemId: orderItems.id,
        comandaId: orderItemShares.comandaId,
        productName: orderItems.productNameSnapshot,
        qty: orderItems.qty,
        unitPriceCents: orderItems.unitPriceCents,
        notes: orderItems.notes,
        status: orderItems.status,
        amountCents: orderItemShares.amountCents,
        sharedWith: shareCount.n,
        receivedAt: orders.receivedAt,
        waiterName: users.name,
      })
      .from(orderItemShares)
      .innerJoin(orderItems, eq(orderItems.id, orderItemShares.orderItemId))
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(users, eq(users.id, orders.userId))
      .innerJoin(shareCount, eq(shareCount.orderItemId, orderItems.id))
      .where(inArray(orderItemShares.comandaId, comandaIds))
      .orderBy(orders.receivedAt, orderItems.createdAt),
    db
      .select({
        paymentId: paymentItems.paymentId,
        paymentStatus: payments.status,
        orderItemId: paymentItems.orderItemId,
        comandaId: paymentItems.comandaId,
        num: paymentItems.fractionNum,
        den: paymentItems.fractionDen,
        cents: paymentItems.itemAmountCents,
        productName: orderItems.productNameSnapshot,
      })
      .from(paymentItems)
      .innerJoin(payments, eq(payments.id, paymentItems.paymentId))
      .innerJoin(orderItems, eq(orderItems.id, paymentItems.orderItemId))
      .where(inArray(paymentItems.comandaId, comandaIds)),
    db
      .select({ adj: adjustments, userName: users.name })
      .from(adjustments)
      .innerJoin(users, eq(users.id, adjustments.userId))
      .where(and(inArray(adjustments.comandaId, comandaIds), eq(adjustments.active, true)))
      .orderBy(adjustments.createdAt),
    db
      .select({ payment: payments, comandaId: paymentComandas.comandaId, allocated: paymentComandas.amountCents, userName: users.name })
      .from(paymentComandas)
      .innerJoin(payments, eq(payments.id, paymentComandas.paymentId))
      .innerJoin(users, eq(users.id, payments.userId))
      .where(inArray(paymentComandas.comandaId, comandaIds))
      .orderBy(payments.createdAt),
  ]);

  const rules = await getDayRules(db);
  const authorizerIds = [...new Set(adjustmentRows.map((a) => a.adj.authorizedBy).filter((x): x is string => x !== null))];
  const authorizerNames = new Map(
    authorizerIds.length
      ? (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, authorizerIds))).map((u) => [u.id, u.name])
      : [],
  );

  const items: BillItem[] = itemRows.map((r) => {
    const paid = paidItemRows.filter(
      (p) => p.paymentStatus === 'OK' && p.orderItemId === r.orderItemId && p.comandaId === r.comandaId,
    );
    const paidFraction = paid.reduce<Fraction>((acc, p) => addFractions(acc, { num: p.num, den: p.den }), { num: 0, den: 1 });
    return {
      orderItemId: r.orderItemId,
      comandaId: r.comandaId,
      productName: r.productName,
      qty: r.qty,
      unitPriceCents: r.unitPriceCents,
      notes: r.notes,
      amountCents: r.status === 'ATIVO' ? r.amountCents : 0,
      sharedWith: r.sharedWith,
      paidCents: paid.reduce((s, p) => s + p.cents, 0),
      paidFraction,
      canceled: r.status === 'CANCELADO',
      orderedAt: r.receivedAt.toISOString(),
      waiterName: r.waiterName,
    };
  });

  const adjustmentList: BillAdjustment[] = adjustmentRows.map(({ adj: a, userName }) => ({
    id: a.id,
    comandaId: a.comandaId,
    type: a.type,
    amountCents: a.amountCents,
    percentBps: a.percentBps,
    reason: a.reason,
    userName,
    authorizedBy: a.authorizedBy ? (authorizerNames.get(a.authorizedBy) ?? null) : null,
    createdAt: a.createdAt.toISOString(),
  }));

  const paymentMap = new Map<string, BillPayment>();
  for (const r of paymentRows) {
    let p = paymentMap.get(r.payment.id);
    if (!p) {
      p = {
        id: r.payment.id,
        method: r.payment.method,
        amountCents: r.payment.amountCents,
        changeCents: r.payment.changeCents,
        payerName: r.payment.payerName,
        status: r.payment.status,
        createdAt: r.payment.createdAt.toISOString(),
        userName: r.userName,
        allocations: [],
        // O que a pessoa pagou por item (ex.: R$ 15,00 do Filé, Água, Coca).
        items: paidItemRows
          .filter((i) => i.paymentId === r.payment.id)
          .map((i) => ({ productName: i.productName, amountCents: i.cents, whole: i.num === i.den })),
      };
      paymentMap.set(p.id, p);
    }
    p.allocations.push({ comandaId: r.comandaId, amountCents: r.allocated });
  }
  const paymentList = [...paymentMap.values()];

  const billComandas: BillComanda[] = ordered.map(({ comanda: c, isCounter }) => {
    const mine = adjustmentList.filter((a) => a.comandaId === c.id);
    const serviceFeeWaived = mine.some((a) => a.type === 'TAXA_SERVICO_REMOVIDA');
    const couvertWaived = mine.some((a) => a.type === 'COUVERT_REMOVIDO');
    const paidCents = paymentList
      .filter((p) => p.status === 'OK')
      .reduce((s, p) => s + (p.allocations.find((a) => a.comandaId === c.id)?.amountCents ?? 0), 0);
    const totals: ComandaTotals =
      c.status === 'FECHADA' && c.finalTotals
        ? (c.finalTotals as ComandaTotals)
        : computeTotals({
            itemsCents: items.filter((i) => i.comandaId === c.id).reduce((s, i) => s + i.amountCents, 0),
            // Venda no balcão: sem taxa de serviço e sem couvert (não há mesa nem atendimento).
            serviceFeeEnabled: settings.serviceFeeEnabled && !isCounter,
            serviceFeeWaived,
            // Couvert do dia × pessoas, pela regra do horário (+15 min de tolerância).
            couvertCents: isCounter ? 0 : couvertFor(rules ? { windows: rules.couvertWindows, mode: settings.couvertMode } : null, c),
            couvertWaived,
            discounts: mine.filter((a) => a.type === 'DESCONTO'),
            paidCents,
          });
    return {
      id: c.id,
      number: c.number,
      customerName: c.customerName,
      cpfLast3: c.cpfLast3,
      status: c.status,
      openedAt: c.openedAt.toISOString(),
      peopleCount: c.peopleCount,
      totals,
      serviceFeeWaived,
      couvertWaived,
    };
  });

  return {
    tableNumber: ordered[0]?.tableNumber ?? 0,
    tableLabel: tableLabel({ number: ordered[0]?.tableNumber ?? 0, isCounter: ordered[0]?.isCounter ?? false }),
    comandas: billComandas,
    items,
    adjustments: adjustmentList,
    payments: paymentList,
    totals: sumTotals(billComandas.map((c) => c.totals)),
    serviceFeeEnabled: settings.serviceFeeEnabled && !(ordered[0]?.isCounter ?? false),
  };
}
