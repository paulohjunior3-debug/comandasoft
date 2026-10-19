import { describe, expect, it } from 'vitest';
import { encodeText, renderEscPos, renderText, stripAccents, wrap, type Block } from './index';

describe('acentuação', () => {
  it('CP860 (Elgin) mantém os acentos do português', () => {
    expect(encodeText('Ação Pão', 'CP860')).toEqual([0x41, 0x87, 0x84, 0x6f, 0x20, 0x50, 0x84, 0x6f]);
    expect(encodeText('ÉÔÕ', 'CP860')).toEqual([0x90, 0x8c, 0x99]);
  });

  it('CP850 tem ã e õ em outras posições', () => {
    expect(encodeText('ã õ', 'CP850')).toEqual([0xc6, 0x20, 0xe4]);
  });

  it('o que a página não tem perde o acento; SEM_ACENTO tira tudo; emoji vira ?', () => {
    expect(encodeText('Pão', 'CP437')).toEqual([...Buffer.from('Pao')]);
    expect(encodeText('Coração', 'SEM_ACENTO')).toEqual([...Buffer.from('Coracao')]);
    expect(encodeText('ok 🍺', 'CP860')).toEqual([...Buffer.from('ok ?')]);
    expect(stripAccents('“Água” – já')).toBe('"Agua" - ja');
    // Separador "·" dos cupons: existe nas três páginas (0xFA); sem acento vira "-".
    expect(encodeText('a·b', 'CP860')).toEqual([0x61, 0xfa, 0x62]);
    expect(encodeText('a·b', 'SEM_ACENTO')).toEqual([...Buffer.from('a-b')]);
  });
});

describe('layout', () => {
  it('quebra por palavras sem passar da largura', () => {
    expect(wrap('Batata frita com cheddar e bacon', 12)).toEqual(['Batata frita', 'com cheddar', 'e bacon']);
    expect(wrap('ABCDEFGHIJKLMN', 5)).toEqual(['ABCDE', 'FGHIJ', 'KLMN']);
  });

  it('prévia em texto respeita 48 colunas (80 mm) e centraliza', () => {
    const blocks: Block[] = [
      { kind: 'text', text: 'COZINHA', align: 'center', size: 'big' },
      { kind: 'rule' },
      { kind: 'pair', left: '2x Fritas', right: 'R$ 65,80' },
    ];
    const lines = renderText(blocks, 80).split('\n');
    expect(lines.every((l) => l.length <= 48)).toBe(true);
    expect(lines[1]).toBe('-'.repeat(48));
    expect(lines[2]).toMatch(/^2x Fritas +R\$ 65,80$/);
    expect(lines[2]).toHaveLength(48);
    expect(lines[0]!.trim()).toBe('C O Z I N H A');
  });

  it('bytes ESC/POS: inicializa, escolhe a tabela, corta no fim', () => {
    const bytes = renderEscPos([{ kind: 'text', text: 'Olá', bold: true }], { widthMm: 80, codepage: 'CP860', cut: true });
    expect([...bytes.slice(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 3]);
    expect([...bytes]).toEqual(expect.arrayContaining([0x4f, 0x6c, 0xa0, 0x0a]));
    expect([...bytes.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 0x03]);
  });

  it('gaveta de dinheiro só quando pedido', () => {
    const profile = { widthMm: 58 as const, codepage: 'CP437' as const, cut: false };
    const drawer = [0x1b, 0x70, 0x00, 0x19, 0xfa];
    const has = (b: Uint8Array) => Buffer.from(b).includes(Buffer.from(drawer));
    expect(has(renderEscPos([], profile, { openDrawer: true }))).toBe(true);
    expect(has(renderEscPos([], profile))).toBe(false);
  });
});
