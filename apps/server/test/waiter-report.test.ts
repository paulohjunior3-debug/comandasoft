import { randomUUID } from 'node:crypto';
import type { CashierTable, MyOrder, SalesReport } from '@sistema-bar/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, PASSWORD, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let caixa: Inject;
let garcom: Inject;
let maria: Inject;
const ids = {} as Record<'mesa' | 'mesa2' | 'cerveja' | 'porcao' | 'register' | 'ana' | 'bia', string>;

const order = (as: Inject, tableId: string, comandaIds: string[], items: { productId: string; qty: number }[]) =>
  as({ method: 'POST', url: '/api/waiter/orders', payload: { clientUuid: randomUUID(), tableId, comandaIds, items, createdAtDevice: new Date().toISOString() } });

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  caixa = await ctx.as('caixa');
  garcom = await ctx.as('garcom');
  const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();
  await post('/api/admin/users', { name: 'Maria', login: 'maria', password: PASSWORD, role: 'GARCOM', active: true });
  maria = await ctx.as('maria');

  const printer = (await post('/api/admin/printers', { name: 'Caixa', windowsName: 'EPSON', sectorLabel: 'CAIXA' })).id;
  const settings = (await admin({ method: 'GET', url: '/api/admin/settings' })).json();
  await admin({ method: 'PUT', url: '/api/admin/settings', payload: { ...settings, cashierPrinterId: printer, serviceFeeEnabled: true } });
  const cat = (await post('/api/admin/categories', { name: 'Bebidas' })).id;
  ids.cerveja = (await post('/api/admin/products', { categoryId: cat, name: 'Cerveja', priceCents: 1000 })).id;
  ids.porcao = (await post('/api/admin/products', { categoryId: cat, name: 'Porção', priceCents: 4000 })).id;
  ids.mesa = (await post('/api/admin/tables', { number: 1 })).id;
  ids.mesa2 = (await post('/api/admin/tables', { number: 2 })).id;
  ids.register = (await post('/api/admin/registers', { name: 'Caixa 1' })).id;
  await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: ids.register, openingFloatCents: 0 } });

  const open = async (tableId: string, customerName: string) =>
    (await garcom({ method: 'POST', url: '/api/waiter/comandas', payload: { clientUuid: randomUUID(), tableId, customerName, phone: '(34) 98765-4321' } })).json()
      .id as string;
  ids.ana = await open(ids.mesa, 'Ana');
  ids.bia = await open(ids.mesa2, 'Bia');
  // Ana: 3 + 2 cervejas (garçom) e 1 porção (Maria). Bia: 1 cerveja (Maria).
  await order(garcom, ids.mesa, [ids.ana], [{ productId: ids.cerveja, qty: 3 }]);
  await order(garcom, ids.mesa, [ids.ana], [{ productId: ids.cerveja, qty: 2 }]);
  await order(maria, ids.mesa, [ids.ana], [{ productId: ids.porcao, qty: 1 }]);
  await order(maria, ids.mesa2, [ids.bia], [{ productId: ids.cerveja, qty: 1 }]);
  await maria({ method: 'POST', url: `/api/waiter/tables/${ids.mesa}/visit`, payload: { clientUuid: randomUUID() } });
  await maria({ method: 'POST', url: `/api/waiter/tables/${ids.mesa2}/visit`, payload: { clientUuid: randomUUID() } });
});
afterAll(() => ctx.close());

describe('meus lançamentos (garçom)', () => {
  it('cada garçom vê só os pedidos que ele lançou, do mais recente para o mais antigo', async () => {
    const mine: MyOrder[] = (await maria({ method: 'GET', url: '/api/waiter/orders/mine' })).json();
    expect(mine.map((o) => [o.tableNumber, o.customers, o.items.map((i) => `${i.qty}x ${i.name}`)])).toEqual([
      [2, ['Bia'], ['1x Cerveja']],
      [1, ['Ana'], ['1x Porção']],
    ]);
    const other: MyOrder[] = (await garcom({ method: 'GET', url: '/api/waiter/orders/mine' })).json();
    expect(other).toHaveLength(2);
    expect(other.every((o) => o.customers[0] === 'Ana')).toBe(true);
  });
});

describe('caixa: nome e telefone do cliente', () => {
  it('a comanda traz o telefone informado', async () => {
    const tables: CashierTable[] = (await caixa({ method: 'GET', url: '/api/cashier/tables' })).json();
    expect(tables.find((t) => t.number === 1)!.comandas[0]).toMatchObject({ customerName: 'Ana', phone: '34987654321' });
  });
});

describe('cupom da conta', () => {
  it('itens iguais saem juntos numa linha (na tela continuam separados)', async () => {
    const bill = (await caixa({ method: 'POST', url: '/api/cashier/bill', payload: { comandaIds: [ids.ana] } })).json();
    expect(bill.items.filter((i: { productName: string }) => i.productName === 'Cerveja')).toHaveLength(2);
    ctx.printed.length = 0;
    await caixa({ method: 'POST', url: '/api/cashier/bill/print', payload: { comandaIds: [ids.ana], registerId: ids.register } });
    await ctx.app.printWorker.runOnce();
    const preview = ctx.printed.find((p) => p.preview.includes('CONFER'))!.preview;
    expect(preview).toMatch(/5x Cerveja\s+R\$ 50,00/);
    expect(preview).not.toMatch(/3x Cerveja|2x Cerveja/);
  });
});

describe('relatório por garçom', () => {
  it('soma o que cada um vendeu nas comandas fechadas, com a taxa proporcional e os atendimentos', async () => {
    for (const [comandaId, cents] of [[ids.ana, 9900], [ids.bia, 1100]] as const) {
      await caixa({
        method: 'POST',
        url: '/api/cashier/payments',
        payload: { clientUuid: randomUUID(), registerId: ids.register, comandaIds: [comandaId], method: 'PIX', amountCents: cents, payerName: 'X' },
      });
    }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const session = (await caixa({ method: 'GET', url: `/api/cashier/session?registerId=${ids.register}` })).json();
    const day = session?.session?.businessDate ?? session?.businessDate ?? today;
    const report: SalesReport = (await admin({ method: 'GET', url: `/api/admin/reports/sales?from=${day}&to=${day}` })).json();
    const byName = Object.fromEntries(report.waiters.map((w) => [w.name, w]));
    expect(byName.garcom).toMatchObject({ itemsCents: 5000, qty: 5, orders: 2, comandas: 1, tables: 1, serviceFeeCents: 500, visits: 0 });
    expect(byName.Maria).toMatchObject({ itemsCents: 5000, qty: 2, orders: 2, comandas: 2, tables: 2, serviceFeeCents: 500, visits: 2 });
    // Empate no valor: quem atendeu mais vem primeiro.
    expect(report.waiters[0]!.name).toBe('Maria');
  });
});
