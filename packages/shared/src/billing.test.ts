import { describe, expect, it } from 'vitest';
import { addFractions, allocateSequential, computeTotals, fractionAmount, sumTotals, type TotalsInput } from './billing';

const base: TotalsInput = {
  itemsCents: 10_000,
  serviceFeeEnabled: false,
  serviceFeeWaived: false,
  couvertCents: 0,
  couvertWaived: false,
  discounts: [],
  paidCents: 0,
};

describe('conta da comanda', () => {
  it('sem taxa: total = itens', () => {
    expect(computeTotals(base)).toMatchObject({ totalCents: 10_000, remainingCents: 10_000, serviceFeeCents: 0 });
  });

  it('taxa de serviço de 10% quando o dono liga; retirada zera só nesta comanda', () => {
    expect(computeTotals({ ...base, serviceFeeEnabled: true }).totalCents).toBe(11_000);
    expect(computeTotals({ ...base, serviceFeeEnabled: true, serviceFeeWaived: true }).serviceFeeCents).toBe(0);
    // 10% de R$ 33,33 = R$ 3,33 (arredonda o meio centavo para cima: 333,3 → 333)
    expect(computeTotals({ ...base, itemsCents: 3333, serviceFeeEnabled: true }).serviceFeeCents).toBe(333);
  });

  it('couvert por pessoa e desconto (valor + percentual sobre os itens)', () => {
    const t = computeTotals({
      ...base,
      serviceFeeEnabled: true,
      couvertCents: 1500,
      discounts: [{ amountCents: 500 }, { percentBps: 1000 }],
    });
    // 100,00 + 10,00 taxa + 15,00 couvert − (5,00 + 10,00) = 110,00
    expect(t).toMatchObject({ serviceFeeCents: 1000, couvertCents: 1500, discountCents: 1500, totalCents: 11_000 });
  });

  it('desconto nunca deixa o total negativo; pagamentos abatem o restante', () => {
    expect(computeTotals({ ...base, discounts: [{ amountCents: 50_000 }] }).totalCents).toBe(0);
    expect(computeTotals({ ...base, paidCents: 4_000 }).remainingCents).toBe(6_000);
    expect(computeTotals({ ...base, paidCents: 12_000 }).remainingCents).toBe(0);
  });

  it('soma de várias comandas', () => {
    const a = computeTotals(base);
    const b = computeTotals({ ...base, itemsCents: 2_500, paidCents: 500 });
    expect(sumTotals([a, b])).toMatchObject({ totalCents: 12_500, paidCents: 500, remainingCents: 12_000 });
  });
});

describe('pagamentos', () => {
  it('um pagamento quita as comandas na ordem escolhida', () => {
    const r = allocateSequential(7_000, [
      { id: 'a', remainingCents: 5_000 },
      { id: 'b', remainingCents: 4_000 },
    ]);
    expect(r).toEqual({ allocations: [{ id: 'a', amountCents: 5_000 }, { id: 'b', amountCents: 2_000 }], unallocated: 0 });
    expect(allocateSequential(10_000, [{ id: 'a', remainingCents: 3_000 }]).unallocated).toBe(7_000);
  });

  it('frações de item: 1/3 + 1/3 + 1/3 da pizza fecham exatamente o valor', () => {
    const pizza = 5_000;
    const third = { num: 1, den: 3 };
    const p1 = fractionAmount(pizza, third, { fraction: { num: 0, den: 1 }, cents: 0 })!;
    const p2 = fractionAmount(pizza, third, { fraction: third, cents: p1 })!;
    const p3 = fractionAmount(pizza, third, { fraction: { num: 2, den: 3 }, cents: p1 + p2 })!;
    expect([p1, p2, p3]).toEqual([1667, 1667, 1666]);
    expect(p1 + p2 + p3).toBe(pizza);
    expect(fractionAmount(pizza, { num: 1, den: 2 }, { fraction: { num: 2, den: 3 }, cents: 3334 })).toBeNull();
    expect(addFractions({ num: 1, den: 2 }, { num: 1, den: 4 })).toEqual({ num: 3, den: 4 });
  });
});
