import { describe, expect, it } from 'vitest';
import { cpfLast3, formatBRL, formatCpf, isValidCpf, percentOf } from './index';

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
});
