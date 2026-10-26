import { encodeText, ESC_T_TABLE, type Codepage } from './encoding';

/**
 * Documento de cupom independente da impressora: uma lista de linhas com estilo.
 * O mesmo documento vira bytes ESC/POS (impressora real) ou texto (emulador / prévia na tela),
 * então o que aparece no painel é exatamente o que sai no papel.
 */

export type Align = 'left' | 'center' | 'right';
export type Size = 'normal' | 'tall' | 'wide' | 'big';

export interface LineStyle {
  align?: Align;
  bold?: boolean;
  /** tall = altura dupla; wide = largura dupla; big = as duas. */
  size?: Size;
}

export type Block =
  | ({ kind: 'text'; text: string } & LineStyle)
  /** Texto à esquerda e à direita na mesma linha (ex.: item e valor). */
  | ({ kind: 'pair'; left: string; right: string } & LineStyle)
  | { kind: 'rule'; char?: string }
  | { kind: 'feed'; lines: number }
  /** QR Code (ex.: consulta da NFC-e), centralizado. `size` = tamanho do módulo, de 3 a 8. */
  | { kind: 'qr'; data: string; size?: number };

export interface PrinterProfile {
  widthMm: 58 | 80;
  codepage: Codepage;
  cut: boolean;
}

/** Colunas da fonte A: 48 no papel de 80 mm, 32 no de 58 mm. */
export const columnsFor = (widthMm: 58 | 80) => (widthMm === 80 ? 48 : 32);

const isWide = (size?: Size) => size === 'wide' || size === 'big';

/** Quebra o texto em linhas de no máximo `width` caracteres, por palavras. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (word.length > width) {
        if (line) lines.push(line);
        for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
        line = lines.pop() ?? '';
        continue;
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function place(text: string, width: number, align: Align = 'left'): string {
  if (align === 'left') return text;
  const pad = Math.max(0, width - text.length);
  return align === 'center' ? ' '.repeat(Math.floor(pad / 2)) + text : ' '.repeat(pad) + text;
}

function pairLine(left: string, right: string, width: number): string[] {
  const room = width - right.length - 1;
  const lefts = wrap(left, Math.max(1, room));
  const last = lefts.pop() ?? '';
  return [...lefts, last + ' '.repeat(Math.max(1, width - last.length - right.length)) + right];
}

/** Linhas de texto já posicionadas, como sairão no papel (largura em caracteres "normais"). */
export function renderText(blocks: Block[], widthMm: 58 | 80): string {
  const cols = columnsFor(widthMm);
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'feed') {
      for (let i = 0; i < b.lines; i++) out.push('');
      continue;
    }
    if (b.kind === 'rule') {
      out.push((b.char ?? '-').repeat(cols));
      continue;
    }
    if (b.kind === 'qr') {
      // Na prévia não dá para desenhar o QR: mostra um quadro no lugar dele.
      for (const l of ['+----------+', '| QR CODE  |', '|          |', '+----------+']) out.push(place(l, cols, 'center'));
      continue;
    }
    const wide = isWide(b.size);
    const width = wide ? Math.floor(cols / 2) : cols;
    const lines = b.kind === 'text' ? wrap(b.text, width) : pairLine(b.left, b.right, width);
    for (const l of lines) {
      // Na prévia, letra larga ocupa duas colunas: espaça para manter o alinhamento real.
      const placed = place(l, width, b.align);
      out.push(wide ? placed.split('').join(' ') : placed);
    }
  }
  return out.join('\n');
}

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const SIZE_BYTE: Record<Size, number> = { normal: 0x00, tall: 0x01, wide: 0x10, big: 0x11 };
const ALIGN_BYTE: Record<Align, number> = { left: 0, center: 1, right: 2 };

/** Bytes ESC/POS para a impressora térmica. */
export function renderEscPos(
  blocks: Block[],
  profile: PrinterProfile,
  options: { openDrawer?: boolean; /** Só abre a gaveta: sem avanço de papel nem corte. */ drawerOnly?: boolean } = {},
): Uint8Array {
  const cols = columnsFor(profile.widthMm);
  const bytes: number[] = [ESC, 0x40, ESC, 0x74, ESC_T_TABLE[profile.codepage]];
  const style = (s: LineStyle) => {
    bytes.push(ESC, 0x61, ALIGN_BYTE[s.align ?? 'left']);
    bytes.push(ESC, 0x45, s.bold ? 1 : 0);
    bytes.push(GS, 0x21, SIZE_BYTE[s.size ?? 'normal']);
  };

  for (const b of blocks) {
    if (b.kind === 'feed') {
      bytes.push(ESC, 0x64, Math.min(255, b.lines));
      continue;
    }
    if (b.kind === 'rule') {
      style({});
      bytes.push(...encodeText((b.char ?? '-').repeat(cols), profile.codepage), LF);
      continue;
    }
    if (b.kind === 'qr') {
      bytes.push(...qrBytes(b.data, b.size ?? 5));
      continue;
    }
    style(b);
    const width = isWide(b.size) ? Math.floor(cols / 2) : cols;
    const lines = b.kind === 'text' ? wrap(b.text, width) : pairLine(b.left, b.right, width);
    for (const l of lines) bytes.push(...encodeText(l, profile.codepage), LF);
  }

  style({});
  if (options.openDrawer || options.drawerOnly) bytes.push(ESC, 0x70, 0x00, 0x19, 0xfa); // pulso na gaveta (SPEC 5.5)
  if (options.drawerOnly) return Uint8Array.from(bytes);
  if (profile.cut) bytes.push(GS, 0x56, 0x42, 0x03); // avança e corta (corte parcial)
  else bytes.push(ESC, 0x64, 4);
  return Uint8Array.from(bytes);
}

/**
 * QR Code nativo da impressora (GS ( k, modelo 2), aceito pelas térmicas Epson e Elgin:
 * modelo, tamanho do módulo, correção de erro M, grava os dados e imprime, centralizado.
 */
function qrBytes(data: string, size: number): number[] {
  const payload = [...Buffer.from(data, 'ascii')];
  const len = payload.length + 3;
  const module = Math.min(8, Math.max(3, Math.round(size)));
  return [
    ESC, 0x61, 1,
    GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00,
    GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, module,
    GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31,
    GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30, ...payload,
    GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30,
    LF,
    ESC, 0x61, 0,
  ];
}
