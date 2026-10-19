/** Valores monetários são sempre inteiros em centavos. */
export type Cents = number;

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function assertCents(value: number): asserts value is Cents {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Valor monetário inválido (esperado inteiro em centavos): ${value}`);
  }
}

/** 123456 → "R$ 1.234,56" */
export function formatBRL(cents: Cents): string {
  assertCents(cents);
  return brl.format(cents / 100).replace(/ /g, ' ');
}

/** Aplica percentual em pontos-base (1000 = 10%) com arredondamento meio-para-cima. */
export function percentOf(cents: Cents, basisPoints: number): Cents {
  assertCents(cents);
  assertCents(basisPoints);
  return Math.round((cents * basisPoints) / 10_000);
}
