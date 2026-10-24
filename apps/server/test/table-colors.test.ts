import { randomUUID } from 'node:crypto';
import type { CashierTable, TableDetail, TableMapResponse } from '@sistema-bar/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, comandas, orders, tableVisits } from '../src/db/schema';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let garcom: Inject;
let caixa: Inject;
const ids = {} as Record<'mesa' | 'cerveja' | 'register' | 'ana' | 'bruno', string>;

const cashierTable = async (): Promise<CashierTable> =>
  ((await caixa({ method: 'GET', url: '/api/cashier/tables' })).json() as CashierTable[]).find((t) => t.id === ids.mesa)!;
const mapEntry = async () => ((await garcom({ method: 'GET', url: '/api/waiter/tables' })).json() as TableMapResponse).tables.find((t) => t.id === ids.mesa)!;
const detail = async (): Promise<TableDetail> => (await garcom({ method: 'GET', url: `/api/waiter/tables/${ids.mesa}` })).json();
const clearAlert = (as: Inject = garcom) => as({ method: 'POST', url: `/api/waiter/tables/${ids.mesa}/clear-alert`, payload: {} });

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  garcom = await ctx.as('garcom');
  caixa = await ctx.as('caixa');
  const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();

  const printer = (await post('/api/admin/printers', { name: 'Caixa', windowsName: 'EPSON', sectorLabel: 'CAIXA' })).id;
  const settings = (await admin({ method: 'GET', url: '/api/admin/settings' })).json();
  await admin({ method: 'PUT', url: '/api/admin/settings', payload: { ...settings, cashierPrinterId: printer } });
  const cat = (await post('/api/admin/categories', { name: 'Bebidas' })).id;
  ids.cerveja = (await post('/api/admin/products', { categoryId: cat, name: 'Cerveja', priceCents: 1000 })).id;
  ids.mesa = (await post('/api/admin/tables', { number: 7 })).id;
  ids.register = (await post('/api/admin/registers', { name: 'Caixa 1' })).id;
  await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: ids.register, openingFloatCents: 0 } });

  const open = async (customerName: string) =>
    (await garcom({ method: 'POST', url: '/api/waiter/comandas', payload: { clientUuid: randomUUID(), tableId: ids.mesa, customerName, phone: '(34) 99999-0000' } })).json()
      .id as string;
  ids.ana = await open('Ana');
  ids.bruno = await open('Bruno');
  for (const comandaId of [ids.ana, ids.bruno]) {
    await garcom({
      method: 'POST',
      url: '/api/waiter/orders',
      payload: { clientUuid: randomUUID(), tableId: ids.mesa, comandaIds: [comandaId], items: [{ productId: ids.cerveja, qty: 1 }], createdAtDevice: new Date().toISOString() },
    });
  }
});
afterAll(() => ctx.close());

describe('cores das mesas', () => {
  it('mesa aberta e atendida fica verde', async () => {
    expect(await cashierTable()).toMatchObject({ tone: 'verde', billAlert: false, partialPaid: false });
    expect(await mapEntry()).toMatchObject({ status: 'OCUPADA', billAlert: false, partialPaid: false });
  });

  it('"minhas mesas": quem abriu, lançou ou atendeu nesta ocupação', async () => {
    expect((await mapEntry()).mine).toBe(true); // o garçom abriu as comandas
    const maria = await (async () => {
      const { PASSWORD } = await import('./helpers');
      await admin({ method: 'POST', url: '/api/admin/users', payload: { name: 'Maria', login: 'maria', password: PASSWORD, role: 'GARCOM', active: true } });
      return ctx.as('maria');
    })();
    const entryFor = async (as: Inject) => ((await as({ method: 'GET', url: '/api/waiter/tables' })).json() as TableMapResponse).tables.find((t) => t.id === ids.mesa)!;
    expect((await entryFor(maria)).mine).toBe(false);
    await maria({ method: 'POST', url: `/api/waiter/tables/${ids.mesa}/visit`, payload: { clientUuid: randomUUID() } });
    expect((await entryFor(maria)).mine).toBe(true);
  });

  it('sem pedido nem "atendi a mesa" há mais de 20 min fica amarela; atender volta a verde', async () => {
    const old = new Date(Date.now() - 25 * 60_000);
    await ctx.db.update(comandas).set({ openedAt: old }).where(eq(comandas.tableId, ids.mesa));
    await ctx.db.update(orders).set({ receivedAt: old }).where(eq(orders.tableId, ids.mesa));
    await ctx.db.update(tableVisits).set({ visitedAt: old }).where(eq(tableVisits.tableId, ids.mesa));
    expect((await cashierTable()).tone).toBe('amarelo');

    await garcom({ method: 'POST', url: `/api/waiter/tables/${ids.mesa}/visit`, payload: { clientUuid: randomUUID() } });
    expect((await cashierTable()).tone).toBe('verde');
  });

  it('imprimir a pré-conta (da mesa ou de uma comanda) deixa a mesa vermelha', async () => {
    const res = await caixa({ method: 'POST', url: '/api/cashier/bill/print', payload: { comandaIds: [ids.ana], registerId: ids.register } });
    expect(res.statusCode).toBe(200);
    expect(await cashierTable()).toMatchObject({ tone: 'vermelho', billAlert: true });
    expect((await mapEntry()).billAlert).toBe(true);
    expect((await detail()).billAlert).toBe(true);
  });

  it('alguém paga a sua comanda: continua vermelha, agora com a estrela de pago parcial', async () => {
    const pay = await caixa({
      method: 'POST',
      url: '/api/cashier/payments',
      payload: { clientUuid: randomUUID(), registerId: ids.register, comandaIds: [ids.ana], method: 'PIX', amountCents: 1000, payerName: 'Ana' },
    });
    expect(pay.statusCode).toBeLessThan(300);
    expect(await cashierTable()).toMatchObject({ tone: 'vermelho', partialPaid: true });
  });

  it('tirar do vermelho volta para a cor do atendimento e mantém a estrela', async () => {
    expect((await clearAlert()).json()).toEqual({ cleared: 1 });
    expect(await cashierTable()).toMatchObject({ tone: 'verde', billAlert: false, partialPaid: true });
    expect(await detail()).toMatchObject({ billAlert: false, partialPaid: true });
    expect((await clearAlert(caixa)).json()).toEqual({ cleared: 0 });
    const logs = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'MESA_ALERTA_CONTA_REMOVIDO'));
    expect(logs).toHaveLength(1);

    // Imprimir de novo acende o alerta de novo.
    await caixa({ method: 'POST', url: '/api/cashier/bill/print', payload: { comandaIds: [ids.bruno], registerId: ids.register } });
    expect((await cashierTable()).tone).toBe('vermelho');
  });

  it('pagamento parcial (sem fechar a comanda) também acende a estrela', async () => {
    await clearAlert();
    const fresh = (await admin({ method: 'POST', url: '/api/admin/tables', payload: { number: 8 } })).json().id as string;
    const c = (
      await garcom({ method: 'POST', url: '/api/waiter/comandas', payload: { clientUuid: randomUUID(), tableId: fresh, customerName: 'Caio', phone: '(34) 99999-0000' } })
    ).json().id as string;
    await garcom({
      method: 'POST',
      url: '/api/waiter/orders',
      payload: { clientUuid: randomUUID(), tableId: fresh, comandaIds: [c], items: [{ productId: ids.cerveja, qty: 3 }], createdAtDevice: new Date().toISOString() },
    });
    const before = ((await caixa({ method: 'GET', url: '/api/cashier/tables' })).json() as CashierTable[]).find((t) => t.id === fresh)!;
    expect(before.partialPaid).toBe(false);
    await caixa({
      method: 'POST',
      url: '/api/cashier/payments',
      payload: { clientUuid: randomUUID(), registerId: ids.register, comandaIds: [c], method: 'DINHEIRO', amountCents: 1000, tenderedCents: 1000, payerName: 'Caio' },
    });
    const after = ((await caixa({ method: 'GET', url: '/api/cashier/tables' })).json() as CashierTable[]).find((t) => t.id === fresh)!;
    expect(after).toMatchObject({ partialPaid: true, tone: 'verde' });
  });
});
