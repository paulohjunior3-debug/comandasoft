/**
 * Conversão de texto para as páginas de código das impressoras térmicas (SPEC 5.5, "Acentuação").
 * Só os caracteres do português (e alguns comuns) são mapeados; o resto perde o acento
 * ("SEM_ACENTO" sempre remove). Qualquer coisa fora do ASCII que sobrar vira "?".
 */

export const CODEPAGES = ['CP860', 'CP850', 'CP437', 'SEM_ACENTO'] as const;
export type Codepage = (typeof CODEPAGES)[number];

/** Número da tabela para o comando ESC t n (padrão Epson, seguido pelas Elgin). */
export const ESC_T_TABLE: Record<Codepage, number> = { CP437: 0, CP850: 2, CP860: 3, SEM_ACENTO: 0 };

const CP860: Record<string, number> = {
  Ç: 0x80, ü: 0x81, é: 0x82, â: 0x83, ã: 0x84, à: 0x85, Á: 0x86, ç: 0x87, ê: 0x88, Ê: 0x89, è: 0x8a, Í: 0x8b,
  Ô: 0x8c, ì: 0x8d, Ã: 0x8e, Â: 0x8f, É: 0x90, À: 0x91, È: 0x92, ô: 0x93, õ: 0x94, ò: 0x95, Ú: 0x96, ù: 0x97,
  Ì: 0x98, Õ: 0x99, Ü: 0x9a, Ù: 0x9d, Ó: 0x9f, á: 0xa0, í: 0xa1, ó: 0xa2, ú: 0xa3, ñ: 0xa4, Ñ: 0xa5,
  ª: 0xa6, º: 0xa7, Ò: 0xa9, '·': 0xfa, '°': 0xf8,
};

const CP850: Record<string, number> = {
  Ç: 0x80, ü: 0x81, é: 0x82, â: 0x83, à: 0x85, ç: 0x87, ê: 0x88, è: 0x8a, ì: 0x8d, É: 0x90, ô: 0x93,
  ò: 0x95, ù: 0x97, Ü: 0x9a, á: 0xa0, í: 0xa1, ó: 0xa2, ú: 0xa3, ñ: 0xa4, Ñ: 0xa5, ª: 0xa6, º: 0xa7,
  Á: 0xb5, Â: 0xb6, À: 0xb7, ã: 0xc6, Ã: 0xc7, Ê: 0xd2, È: 0xd4, Í: 0xd6, Ì: 0xde, Ó: 0xe0, Ô: 0xe2,
  Ò: 0xe3, õ: 0xe4, Õ: 0xe5, Ú: 0xe9, Ù: 0xeb, '·': 0xfa, '°': 0xf8,
};

const CP437: Record<string, number> = {
  Ç: 0x80, ü: 0x81, é: 0x82, â: 0x83, à: 0x85, ç: 0x87, ê: 0x88, è: 0x8a, ì: 0x8d, É: 0x90, ô: 0x93,
  ò: 0x95, ù: 0x97, Ü: 0x9a, á: 0xa0, í: 0xa1, ó: 0xa2, ú: 0xa3, ñ: 0xa4, Ñ: 0xa5, ª: 0xa6, º: 0xa7,
  '·': 0xfa, '°': 0xf8,
};

const TABLES: Record<Codepage, Record<string, number>> = { CP860, CP850, CP437, SEM_ACENTO: {} };

/** "Ação" → "Acao". Também troca aspas/traços tipográficos por ASCII. */
export function stripAccents(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/·/g, '-')
    .replace(/°/g, 'o');
}

export function encodeText(text: string, codepage: Codepage): number[] {
  const table = TABLES[codepage];
  const out: number[] = [];
  for (const ch of text.normalize('NFC')) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) {
      out.push(code);
      continue;
    }
    const mapped = table[ch];
    if (mapped !== undefined) {
      out.push(mapped);
      continue;
    }
    for (const c of stripAccents(ch)) {
      const cc = c.charCodeAt(0);
      out.push(cc >= 0x20 && cc < 0x7f ? cc : 0x3f);
    }
  }
  return out;
}
