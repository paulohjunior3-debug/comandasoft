import { describe, expect, it } from 'vitest';
import { couvertFor } from './billing';
import { atLocalTime, couvertStart, formatLocalTime, nextLocalTime } from './time';

// 19/10/2026 16:00 em Brasília = 19:00 UTC
const abertura = new Date('2026-10-19T19:00:00Z');

describe('horários do turno (Brasília)', () => {
  it('converte HH:MM de Brasília no mesmo dia', () => {
    expect(atLocalTime(abertura, '14:00').toISOString()).toBe('2026-10-19T17:00:00.000Z');
    expect(formatLocalTime(abertura)).toBe('16:00');
  });

  it('fechamento depois da meia-noite cai no dia seguinte', () => {
    expect(nextLocalTime(abertura, '01:00').toISOString()).toBe('2026-10-20T04:00:00.000Z');
    expect(nextLocalTime(abertura, '23:30').toISOString()).toBe('2026-10-20T02:30:00.000Z');
  });

  it('meia-noite em Brasília não confunde o dia (abertura às 22h = 01h UTC do dia seguinte)', () => {
    const tarde = new Date('2026-10-20T01:00:00Z'); // 19/10 22:00 em Brasília
    expect(atLocalTime(tarde, '20:00').toISOString()).toBe('2026-10-19T23:00:00.000Z');
  });

  it('couvert: mesmo dia, mesmo que já tenha começado; dia seguinte só se for de madrugada', () => {
    expect(couvertStart(abertura, '14:00').toISOString()).toBe('2026-10-19T17:00:00.000Z');
    expect(couvertStart(abertura, '20:00').toISOString()).toBe('2026-10-19T23:00:00.000Z');
    const noite = new Date('2026-10-20T02:00:00Z'); // 23:00
    expect(couvertStart(noite, '01:00').toISOString()).toBe('2026-10-20T04:00:00.000Z');
  });
});

describe('regra do couvert', () => {
  const rules = { couvertCents: 1500, couvertStartAt: '2026-10-19T17:00:00Z' }; // a partir das 14:00
  const at = (hhmm: string) => new Date(`2026-10-19T${hhmm}:00-03:00`);

  it('quem abre a comanda depois do início já paga, por pessoa', () => {
    expect(couvertFor(rules, { openedAt: at('14:30'), closedAt: null, peopleCount: 2 }, at('14:31'))).toBe(3000);
  });

  it('quem chegou antes paga se ficar além de 14:15 (tolerância)', () => {
    const antes = { openedAt: at('13:00'), closedAt: null, peopleCount: 1 };
    expect(couvertFor(rules, antes, at('14:10'))).toBe(0);
    expect(couvertFor(rules, antes, at('14:15'))).toBe(1500);
  });

  it('quem foi embora antes de 14:15 não paga; sem couvert no dia, ninguém paga', () => {
    expect(couvertFor(rules, { openedAt: at('12:00'), closedAt: at('14:10'), peopleCount: 3 }, at('18:00'))).toBe(0);
    expect(couvertFor(null, { openedAt: at('15:00'), closedAt: null, peopleCount: 3 })).toBe(0);
  });
});

describe('busca sem acento', () => {
  it('acha "file" em "Filé" e "acai" em "Açaí"', async () => {
    const { matchesSearch } = await import('./text');
    expect(matchesSearch('Filé à Parmegiana', 'file a parm')).toBe(true);
    expect(matchesSearch('Açaí 500ml', 'ACAI')).toBe(true);
    expect(matchesSearch('Coca-Cola', 'guarana')).toBe(false);
  });
});

describe('dias de operação', () => {
  it('a data é a de Brasília: 01:30 de 20/10 em Brasília (04:30 UTC) ainda é dia 20, 23:30 de 19/10 é dia 19', async () => {
    const { localDate, localDayRange, daysBetween } = await import('./time');
    expect(localDate(new Date('2026-10-20T04:30:00Z'))).toBe('2026-10-20');
    expect(localDate(new Date('2026-10-20T02:30:00Z'))).toBe('2026-10-19');
    const { start, end } = localDayRange('2026-10-19', '2026-10-20');
    expect(start.toISOString()).toBe('2026-10-19T03:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-21T03:00:00.000Z');
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(31);
  });
});

describe('semana do bar e períodos', () => {
  it('fecha na segunda, começa na terça: terça = 1 … domingo = 6', async () => {
    const { periodOf, periodTable, suggestedBusinessDate, periodLabel } = await import('./period');
    const week = { weekStartDay: 2, closedDays: [1] };
    expect(periodTable(week).map((d) => d.weekday)).toEqual([2, 3, 4, 5, 6, 0]);
    expect(periodOf('2026-10-20', week)).toBe(1); // terça
    expect(periodOf('2026-10-25', week)).toBe(6); // domingo
    expect(periodOf('2026-10-19', week)).toBeNull(); // segunda: fechado
    expect(periodLabel(3, '2026-10-22')).toBe('Período 3 (quinta)');
    // 00:30 de quarta em Brasília ainda é o movimento de terça; 16h de quarta é quarta.
    expect(suggestedBusinessDate(new Date('2026-10-21T03:30:00Z'))).toBe('2026-10-20');
    expect(suggestedBusinessDate(new Date('2026-10-21T19:00:00Z'))).toBe('2026-10-21');
  });
});
