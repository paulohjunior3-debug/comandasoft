import { percentOf, type Cents } from './money';

/**
 * Cálculo da conta de uma comanda (SPEC 5.7 e 6, "Saldo da comanda").
 *
 *   itens            = soma das partes desta comanda nos itens ativos
 *   taxa de serviço  = 10% dos itens, se o dono ligou e não foi retirada desta comanda
 *   couvert          = valor por pessoa (1 comanda = 1 pessoa), se configurado e não retirado
 *   desconto         = valores fixos + percentuais sobre os itens
 *   total            = itens + taxa + couvert − desconto (nunca negativo)
 *   restante         = total − pagamentos válidos
 *
 * A taxa incide sobre os itens antes do desconto.
 */

export const SERVICE_FEE_BPS = 1000;

export interface DiscountInput {
  /** Desconto em valor (centavos)… */
  amountCents?: number | null;
  /** …ou em percentual, em pontos-base (1000 = 10%), sobre os itens. */
  percentBps?: number | null;
}

export interface TotalsInput {
  itemsCents: Cents;
  serviceFeeEnabled: boolean;
  serviceFeeWaived: boolean;
  couvertCents: Cents;
  couvertWaived: boolean;
  discounts: DiscountInput[];
  paidCents: Cents;
}

export interface ComandaTotals {
  itemsCents: Cents;
  serviceFeeCents: Cents;
  couvertCents: Cents;
  discountCents: Cents;
  totalCents: Cents;
  paidCents: Cents;
  remainingCents: Cents;
}

export function computeTotals(input: TotalsInput): ComandaTotals {
  const items = input.itemsCents;
  const serviceFee = input.serviceFeeEnabled && !input.serviceFeeWaived ? percentOf(items, SERVICE_FEE_BPS) : 0;
  const couvert = input.couvertWaived ? 0 : input.couvertCents;
  const gross = items + serviceFee + couvert;
  const discountRaw = input.discounts.reduce(
    (sum, d) => sum + (d.amountCents ?? 0) + (d.percentBps ? percentOf(items, d.percentBps) : 0),
    0,
  );
  const discount = Math.min(discountRaw, gross);
  const total = gross - discount;
  return {
    itemsCents: items,
    serviceFeeCents: serviceFee,
    couvertCents: couvert,
    discountCents: discount,
    totalCents: total,
    paidCents: input.paidCents,
    remainingCents: Math.max(0, total - input.paidCents),
  };
}

/** Soma totais de várias comandas (fechamento da mesa inteira). */
export function sumTotals(list: ComandaTotals[]): ComandaTotals {
  const zero: ComandaTotals = {
    itemsCents: 0,
    serviceFeeCents: 0,
    couvertCents: 0,
    discountCents: 0,
    totalCents: 0,
    paidCents: 0,
    remainingCents: 0,
  };
  return list.reduce(
    (acc, t) => ({
      itemsCents: acc.itemsCents + t.itemsCents,
      serviceFeeCents: acc.serviceFeeCents + t.serviceFeeCents,
      couvertCents: acc.couvertCents + t.couvertCents,
      discountCents: acc.discountCents + t.discountCents,
      totalCents: acc.totalCents + t.totalCents,
      paidCents: acc.paidCents + t.paidCents,
      remainingCents: acc.remainingCents + t.remainingCents,
    }),
    zero,
  );
}

/**
 * Distribui um pagamento entre comandas, na ordem escolhida pelo caixa:
 * quita a primeira, depois a segunda… Devolve quanto foi para cada uma.
 */
export function allocateSequential(amount: Cents, remainings: { id: string; remainingCents: Cents }[]) {
  let left = amount;
  const out: { id: string; amountCents: Cents }[] = [];
  for (const r of remainings) {
    if (left <= 0) break;
    const part = Math.min(left, r.remainingCents);
    if (part > 0) out.push({ id: r.id, amountCents: part });
    left -= part;
  }
  return { allocations: out, unallocated: left };
}

/** Fração como inteiros (1/3 da pizza), comparável sem ponto flutuante. */
export interface Fraction {
  num: number;
  den: number;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

export function addFractions(a: Fraction, b: Fraction): Fraction {
  const num = a.num * b.den + b.num * a.den;
  const den = a.den * b.den;
  const g = gcd(num, den) || 1;
  return { num: num / g, den: den / g };
}

/**
 * Valor de uma fração de item. Quando a fração completa o item (já pago + esta = 1),
 * devolve exatamente o que falta, para os centavos fecharem.
 */
export function fractionAmount(itemCents: Cents, fraction: Fraction, alreadyPaid: { fraction: Fraction; cents: Cents }) {
  const after = addFractions(alreadyPaid.fraction, fraction);
  if (after.num > after.den) return null; // passaria de 100% do item
  if (after.num === after.den) return itemCents - alreadyPaid.cents;
  return Math.round((itemCents * fraction.num) / fraction.den);
}
