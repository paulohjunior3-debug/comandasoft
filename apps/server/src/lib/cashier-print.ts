import { formatBRL, PAYMENT_METHOD_LABELS, type Bill, type Settings } from '@sistema-bar/shared';
import { and, eq } from 'drizzle-orm';
import { printers, printJobs } from '../db/schema';
import type { BillTicket, CashTicket, CompanyHeader, DrawerTicket, NfceTicket } from '../printing/tickets';
import type { Queryable } from './billing';

export const companyOf = (s: Settings): CompanyHeader => ({
  name: s.companyName,
  document: s.companyDocument,
  address: s.companyAddress,
  phone: s.companyPhone,
  footer: s.receiptFooter,
});

type CashierPayload = BillTicket | CashTicket | DrawerTicket | NfceTicket;

const JOB_TYPE = { CONTA: 'PRE_CONTA', CAIXA: 'CAIXA', GAVETA: 'GAVETA', NFCE: 'DANFE' } as const;

/**
 * Coloca um cupom na fila da impressora do caixa: a do próprio caixa (Caixa Carlos tem a sua),
 * senão a "impressora do caixa" das Configurações. Sem impressora (ou desativada), não imprime
 * e devolve false para a tela avisar.
 */
export async function enqueueCashierPrint(
  db: Queryable,
  settings: Settings,
  payload: CashierPayload,
  referenceId?: string,
  registerPrinterId?: string | null,
) {
  const printerId = registerPrinterId ?? settings.cashierPrinterId;
  if (!printerId) return false;
  const [printer] = await db
    .select({ id: printers.id })
    .from(printers)
    .where(and(eq(printers.id, printerId), eq(printers.active, true)));
  if (!printer) return false;
  const type = payload.kind === 'CONTA' ? (payload.variant === 'CUPOM' ? 'CUPOM' : 'PRE_CONTA') : JOB_TYPE[payload.kind];
  await db.insert(printJobs).values({ printerId: printer.id, type, payload, referenceId: referenceId ?? null });
  return true;
}

/** Monta a pré-conta ou o cupom final a partir da conta calculada. */
/**
 * No papel, itens iguais saem numa linha só (10 cervejas = "10x Cerveja" com o valor das 10),
 * na ordem em que apareceram. Na tela do caixa continuam separados, com horário e garçom.
 * Rateado só se junta com rateado do mesmo jeito (a parte de cada comanda muda o valor).
 */
function groupItems(items: Bill['items']): BillTicket['comandas'][number]['items'] {
  const groups = new Map<string, BillTicket['comandas'][number]['items'][number]>();
  for (const i of items) {
    const shared = i.sharedWith > 1;
    const key = [i.productName, i.unitPriceCents, shared ? i.sharedWith : 1].join('|');
    const g = groups.get(key);
    if (g) {
      g.qty += i.qty;
      g.amountCents += i.amountCents;
    } else {
      groups.set(key, { qty: i.qty, name: i.productName, amountCents: i.amountCents, shared });
    }
  }
  return [...groups.values()];
}

export function billTicket(bill: Bill, variant: BillTicket['variant'], settings: Settings, operator: string, openDrawer = false): BillTicket {
  return {
    kind: 'CONTA',
    variant,
    company: companyOf(settings),
    tableNumber: bill.tableNumber,
    tableLabel: bill.tableLabel === `Mesa ${bill.tableNumber}` ? undefined : bill.tableLabel,
    createdAt: new Date().toISOString(),
    operator,
    comandas: bill.comandas.map((c) => ({
      name: c.customerName,
      items: groupItems(bill.items.filter((i) => i.comandaId === c.id && i.amountCents > 0)),
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
        detail: p.items.length
          ? p.items.map((i) => `${i.whole ? '' : `${formatBRL(i.amountCents)} do `}${i.productName}`).join(' + ')
          : undefined,
      })),
    openDrawer,
  };
}
