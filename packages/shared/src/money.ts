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

/**
 * Converte o que o usuário digita em centavos: "12,50", "R$ 1.234,56", "12.5", "12" → inteiro.
 * Retorna null se não for um valor válido. Nunca passa por float.
 */
export function parseBRL(input: string): Cents | null {
  let s = input.replace(/R\$|\s/g, '');
  if (s === '') return null;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.'); // padrão brasileiro: ponto é milhar
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // "1.234" sem vírgula = mil duzentos e trinta e quatro
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!match) return null;
  const reais = Number(match[1]);
  const centavos = Number((match[2] ?? '').padEnd(2, '0'));
  const total = reais * 100 + centavos;
  return Number.isSafeInteger(total) ? total : null;
}

/** Centavos → texto para campo de edição: 1250 → "12,50" */
export function centsToInput(cents: Cents): string {
  assertCents(cents);
  return (cents / 100).toFixed(2).replace('.', ',');
}

/**
 * Divide um valor em `parts` partes inteiras que somam exatamente o total.
 * Os centavos que sobram vão para as primeiras partes: 1000 / 3 → [334, 333, 333].
 */
export function splitCents(total: Cents, parts: number): Cents[] {
  assertCents(total);
  if (!Number.isInteger(parts) || parts < 1) throw new Error(`Número de partes inválido: ${parts}`);
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** Aplica percentual em pontos-base (1000 = 10%) com arredondamento meio-para-cima. */
export function percentOf(cents: Cents, basisPoints: number): Cents {
  assertCents(cents);
  assertCents(basisPoints);
  return Math.round((cents * basisPoints) / 10_000);
}
