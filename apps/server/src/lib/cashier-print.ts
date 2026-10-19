import { PAYMENT_METHOD_LABELS, type Bill, type Settings } from '@sistema-bar/shared';
import { and, eq } from 'drizzle-orm';
import { printers, printJobs } from '../db/schema';
import type { BillTicket, CashTicket, CompanyHeader, DrawerTicket } from '../printing/tickets';
import type { Queryable } from './billing';

export const companyOf = (s: Settings): CompanyHeader => ({
  name: s.companyName,
  document: s.companyDocument,
  address: s.companyAddress,
  phone: s.companyPhone,
  footer: s.receiptFooter,
});

type CashierPayload = BillTicket | CashTicket | DrawerTicket;

const JOB_TYPE = { CONTA: 'PRE_CONTA', CAIXA: 'CAIXA', GAVETA: 'GAVETA' } as const;

/**
 * Coloca um cupom na fila da impressora do caixa (Configurações). Sem impressora do caixa
 * configurada (ou desativada), não imprime e devolve false para a tela avisar.
 */
export async function enqueueCashierPrint(db: Queryable, settings: Settings, payload: CashierPayload, referenceId?: string) {
  if (!settings.cashierPrinterId) return false;
  const [printer] = await db
    .select({ id: printers.id })
    .from(printers)
    .where(and(eq(printers.id, settings.cashierPrinterId), eq(printers.active, true)));
  if (!printer) return false;
  const type = payload.kind === 'CONTA' ? (payload.variant === 'CUPOM' ? 'CUPOM' : 'PRE_CONTA') : JOB_TYPE[payload.kind];
  await db.insert(printJobs).values({ printerId: printer.id, type, payload, referenceId: referenceId ?? null });
  return true;
}

/** Monta a pré-conta ou o cupom final a partir da conta calculada. */
export function billTicket(bill: Bill, variant: BillTicket['variant'], settings: Settings, operator: string, openDrawer = false): BillTicket {
  return {
    kind: 'CONTA',
    variant,
    company: companyOf(settings),
    tableNumber: bill.tableNumber,
    createdAt: new Date().toISOString(),
    operator,
    comandas: bill.comandas.map((c) => ({
      name: c.customerName,
      items: bill.items
        .filter((i) => i.comandaId === c.id && i.amountCents > 0)
        .map((i) => ({ qty: i.qty, name: i.productName, amountCents: i.amountCents, shared: i.sharedWith > 1 })),
      itemsCents: c.totals.itemsCents,
      serviceFeeCents: c.totals.serviceFeeCents,
      couvertCents: c.totals.couvertCents,
      discountCents: c.totals.discountCents,
      totalCents: c.totals.totalCents,
    })),
    totals: bill.totals,
    payments: bill.payments
      .filter((p) => p.status === 'OK')
      .map((p) => ({
        payerName: p.payerName,
        method: PAYMENT_METHOD_LABELS[p.method],
        // Só a parte que abateu as comandas desta conta.
        amountCents: p.allocations.filter((a) => bill.comandas.some((c) => c.id === a.comandaId)).reduce((s, a) => s + a.amountCents, 0),
        changeCents: p.changeCents,
      })),
    openDrawer,
  };
}
