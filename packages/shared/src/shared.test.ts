import { describe, expect, it } from 'vitest';
import {
  centsToInput,
  cpfLast3,
  DEFAULT_SETTINGS,
  formatBRL,
  formatCpf,
  isValidCpf,
  parseBRL,
  percentOf,
  printerInputSchema,
  productInputSchema,
  settingsSchema,
  userCreateSchema,
} from './index';

describe('cpf', () => {
  it('aceita CPFs válidos com e sem máscara', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
  });

  it('rejeita dígito verificador errado, tamanho errado e repetidos', () => {
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCpf('1234567890')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
  });

  it('formata e extrai os 3 últimos dígitos', () => {
    expect(formatCpf('52998224725')).toBe('529.982.247-25');
    expect(cpfLast3('529.982.247-25')).toBe('725');
  });
});

describe('money', () => {
  it('formata centavos em reais', () => {
    expect(formatBRL(123456)).toBe('R$ 1.234,56');
    expect(formatBRL(5)).toBe('R$ 0,05');
  });

  it('calcula 10% de taxa de serviço em centavos inteiros', () => {
    expect(percentOf(12345, 1000)).toBe(1235);
    expect(percentOf(10000, 1000)).toBe(1000);
  });

  it('recusa valores fracionados', () => {
    expect(() => formatBRL(10.5)).toThrow();
  });

  it('converte o que o usuário digita em centavos', () => {
    expect(parseBRL('12,50')).toBe(1250);
    expect(parseBRL('R$ 1.234,56')).toBe(123456);
    expect(parseBRL('12.5')).toBe(1250);
    expect(parseBRL('12')).toBe(1200);
    expect(parseBRL('1.234')).toBe(123400);
    expect(parseBRL('0,1')).toBe(10);
    expect(parseBRL('')).toBeNull();
    expect(parseBRL('abc')).toBeNull();
    expect(parseBRL('1,234')).toBeNull();
    expect(centsToInput(1250)).toBe('12,50');
  });
});

describe('schemas dos cadastros', () => {
  it('produto: campos vazios do formulário viram null e preço precisa ser inteiro', () => {
    const p = productInputSchema.parse({
      categoryId: '7d1f0a3c-2b9e-4c51-9a7e-1f2d3c4b5a69',
      name: ' Porção de fritas ',
      description: '',
      priceCents: 3290,
      ncm: '',
    });
    expect(p).toMatchObject({ name: 'Porção de fritas', description: null, ncm: null, unit: 'UN', soldOut: false });
    expect(productInputSchema.safeParse({ ...p, priceCents: 32.9 }).success).toBe(false);
  });

  it('impressora: setor sai em maiúsculas', () => {
    const p = printerInputSchema.parse({ name: 'Bar', windowsName: 'ELGIN i9', sectorLabel: 'bar' });
    expect(p).toMatchObject({ sectorLabel: 'BAR', widthMm: 80, codepage: 'CP860', cut: true });
  });

  it('usuário: login normalizado e PIN de 4 a 6 dígitos', () => {
    const u = userCreateSchema.parse({ name: 'Ana', login: ' Ana.Souza ', role: 'GARCOM', password: '123456', pin: '' });
    expect(u).toMatchObject({ login: 'ana.souza', pin: null });
    expect(userCreateSchema.safeParse({ ...u, pin: '12' }).success).toBe(false);
  });

  it('configurações: vermelho precisa ser depois do amarelo', () => {
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, alertRedMinutes: 10 }).success).toBe(false);
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });
});
