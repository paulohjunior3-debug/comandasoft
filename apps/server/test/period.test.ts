import { localDate, periodOf, type SalesReport } from '@sistema-bar/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let caixa: Inject;
let carlos: string;
let paulo: string;
const today = localDate(new Date());
const yesterday = localDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
// Bar que fecha na segunda: terça = Período 1 … domingo = 6.
const week = { weekStartDay: 2, closedDays: [1] };

const report = async (qs: string): Promise<SalesReport> => (await admin({ method: 'GET', url: `/api/admin/reports/sales?${qs}` })).json();
const close = (registerId: string) =>
  caixa({ method: 'POST', url: '/api/cashier/session/close', payload: { registerId, counted: { DINHEIRO: 0 }, confirmOpenComandas: true } });

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  caixa = await ctx.as('caixa');
  const settings = (await admin({ method: 'GET', url: '/api/admin/settings' })).json();
  await admin({ method: 'PUT', url: '/api/admin/settings', payload: { ...settings, ...week } });
  carlos = (await admin({ method: 'POST', url: '/api/admin/registers', payload: { name: 'Caixa Carlos' } })).json().id;
  paulo = (await admin({ method: 'POST', url: '/api/admin/registers', payload: { name: 'Caixa Paulo' } })).json().id;
});
afterAll(() => ctx.close());

describe('dia do movimento e período na abertura do caixa', () => {
  it('a abertura sugere o período pela semana do bar', async () => {
    const day = (await caixa({ method: 'GET', url: '/api/cashier/session/day-rules' })).json();
    expect(day.periods.map((p: { weekday: number }) => p.weekday)).toEqual([2, 3, 4, 5, 6, 0]);
    expect(day.suggested.period).toBe(periodOf(day.suggested.businessDate, week));
  });

  it('dia do movimento só hoje ou ontem', async () => {
    const res = await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: carlos, openingFloatCents: 0, businessDate: '2020-01-01' } });
    expect(res.json().message).toBe('O dia do movimento deve ser hoje ou ontem.');
  });

  it('o primeiro caixa define dia e período; o segundo herda', async () => {
    // Abriu de madrugada pelo movimento de ontem, e corrigiu o período na mão.
    const first = await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: carlos, openingFloatCents: 0, businessDate: yesterday, period: 3 } });
    expect(first.statusCode).toBe(201);
    const second = await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: paulo, openingFloatCents: 0, businessDate: today, period: 1 } });
    expect(second.statusCode).toBe(201);
    const rules = (await caixa({ method: 'GET', url: '/api/cashier/session/day-rules' })).json().rules;
    expect(rules).toMatchObject({ businessDate: yesterday, period: 3 });
    const s = (await caixa({ method: 'GET', url: `/api/cashier/session?registerId=${paulo}` })).json().session;
    expect(s).toMatchObject({ businessDate: yesterday, period: 3 });
  });

  it('o relatório conta pelo dia do movimento e filtra por período', async () => {
    const byDay = await report(`from=${yesterday}&to=${yesterday}`);
    expect(byDay.days).toMatchObject([{ date: yesterday, period: 3 }]);
    expect(byDay.sessions.map((s) => s.period)).toEqual([3, 3]);
    expect((await report(`from=${yesterday}&to=${today}&period=3`)).cash.sessions).toBe(2);
    expect((await report(`from=${yesterday}&to=${today}&period=2`)).cash.sessions).toBe(0);
  });

  it('sem informar, o período vem da semana (ou "dia extra" no dia fechado)', async () => {
    await close(carlos);
    await close(paulo);
    await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: carlos, openingFloatCents: 0, businessDate: today } });
    const s = (await caixa({ method: 'GET', url: `/api/cashier/session?registerId=${carlos}` })).json().session;
    expect(s).toMatchObject({ businessDate: today, period: periodOf(today, week) });
  });
});
