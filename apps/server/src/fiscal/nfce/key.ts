/** Dígito verificador da chave de acesso: módulo 11, pesos 2 a 9 da direita para a esquerda. */
export function keyCheckDigit(key43: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = key43.length - 1; i >= 0; i--) {
    sum += Number(key43[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/**
 * Chave de acesso de 44 dígitos: cUF + AAMM + CNPJ + modelo + série + número + tpEmis + cNF + DV.
 */
export function accessKey(p: { cUF: string; yearMonth: string; cnpj: string; series: number; number: number; tpEmis: number; cNF: string }) {
  const base =
    p.cUF +
    p.yearMonth +
    p.cnpj.padStart(14, '0') +
    '65' +
    String(p.series).padStart(3, '0') +
    String(p.number).padStart(9, '0') +
    String(p.tpEmis) +
    p.cNF.padStart(8, '0');
  if (base.length !== 43 || !/^\d+$/.test(base)) throw new Error(`Chave de acesso inválida: ${base}`);
  const dv = keyCheckDigit(base);
  return { key: base + dv, dv };
}

/** Código numérico aleatório da nota (8 dígitos), diferente do número da nota. */
export function randomCNF(number: number): string {
  for (;;) {
    const n = String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0');
    if (Number(n) !== number) return n;
  }
}
