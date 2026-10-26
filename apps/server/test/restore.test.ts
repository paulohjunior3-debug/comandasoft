import { randomUUID } from 'node:crypto';
import type { Bill, ClosedBillsResponse } from '@sistema-bar/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, comandas, printJobs } from '../src/db/schema';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let caixa: Inject;
let garcom: Inject;
const PIN = '2468';
const ids = {} as Record<'bar' | 'register' | 'mesa' | 'mesa2' | 'joao' | 'ana' | 'cerveja' | 'porcao', string>;

const order = async (tableId: string, comandaIds: string[], productId: string, qty: number) => {
  await garcom({
    method: 'POST',
    url: '/api/waiter/orders',
    payload: { clientUuid: randomUUID(), tableId, comandaIds, items: [{ productId, qty }], createdAtDevice: new Date().toISOString() },
  });
};
const open = async (tableId: string, customerName: string) =>
  (await garcom({ method: 'POST', url: '/api/waiter/comandas', payload: { clientUuid: randomUUID(), tableId, customerName, phone: '(34) 99999-0000' } })).json().id as string;
const bill = async (...comandaIds: string[]): Promise<Bill> =>
  (await caixa({ method: 'POST', url: '/api/cashier/bill', payload: { comandaIds } })).json();
const itemOf = (b: Bill, name: string, canceled: boolean) => b.items.find((i) => i.productName === name && i.canceled === canceled)!;
const productionJobs = () => ctx.db.select().from(printJobs).where(eq(printJobs.type, 'PRODUCAO'));

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  caixa = await ctx.as('caixa');
  garcom = await ctx.as('garcom');
  const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();
  const users = (await admin({ method: 'GET', url: '/api/admin/users' })).json();
  const me = users.find((u: { login: string }) => u.login === 'admin');
  await admin({ method: 'PUT', url: `/api/admin/users/${me.id}`, payload: { ...me, pin: PIN } });

  ids.bar = (await post('/api/admin/printers', { name: 'Bar', windowsName: 'ELGIN BAR', sectorLabel: 'BAR' })).id;
  const cat = (await post('/api/admin/categories', { name: 'Bebidas' })).id;
  await admin({ method: 'PUT', url: `/api/admin/printers/${ids.bar}`, payload: { name: 'Bar', windowsName: 'ELGIN BAR', sectorLabel: 'BAR', categoryIds: [cat] } });
  ids.cerveja = (await post('/api/admin/products', { categoryId: cat, name: 'Cerveja', priceCents: 1000 })).id;
  ids.porcao = (await post('/api/admin/products', { categoryId: cat, name: 'Porção', priceCents: 3000 })).id;
  ids.register = (await post('/api/admin/registers', { name: 'Caixa 1' })).id;
  await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: ids.register, openingFloatCents: 0 } });
  const tables = (await post('/api/admin/tables/bulk', { from: 1, to: 2 })).created as { id: string }[];
  ids.mesa = tables[0]!.id;
  ids.mesa2 = tables[1]!.id;
  ids.joao = await open(ids.mesa, 'João');
  await order(ids.mesa, [ids.joao], ids.cerveja, 3);
});
afterAll(() => ctx.close());

describe('descancelar item', () => {
  it('volta a cerveja cancelada por engano, com PIN, e manda de novo ao bar', async () => {
    const item = itemOf(await bill(ids.joao), 'Cerveja', false);
    await caixa({ method: 'POST', url: `/api/cashier/order-items/${item.orderItemId}/cancel`, payload: { qty: 3, reason: 'Errado', authorizerPin: PIN } });
    expect((await bill(ids.joao)).comandas[0]!.totals.itemsCents).toBe(0);

    const url = `/api/cashier/order-items/${item.orderItemId}/restore`;
    expect((await caixa({ method: 'POST', url, payload: { reason: 'Cancelei errado' } })).json().error).toBe('PIN_REQUIRED');
    const before = (await productionJobs()).length;
    const res = await caixa({ method: 'POST', url, payload: { reason: 'Cancelei errado', authorizerPin: PIN } });
    expect(res.json()).toMatchObject({ restoredQty: 3, sent: true });

    const b = await bill(ids.joao);
    expect(itemOf(b, 'Cerveja', false)).toMatchObject({ qty: 3, amountCents: 3000 });
    expect(b.comandas[0]!.totals.itemsCents).toBe(3000);
    const jobs = await productionJobs();
    expect(jobs.length).toBe(before + 1);
    expect(jobs.at(-1)!.payload).toMatchObject({ sector: 'BAR', customers: ['João'], items: [{ qty: 3, name: 'Cerveja', itemId: item.orderItemId }] });
    expect(await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'ITEM_DESCANCELADO'))).toHaveLength(1);

    // Já ativo: não descancela de novo.
    expect((await caixa({ method: 'POST', url, payload: { reason: 'De novo', authorizerPin: PIN } })).statusCode).toBe(409);
  });

  it('sem mandar ao bar quando o caixa desmarca a opção', async () => {
    await order(ids.mesa, [ids.joao], ids.porcao, 1);
    const item = itemOf(await bill(ids.joao), 'Porção', false);
    await caixa({ method: 'POST', url: `/api/cashier/order-items/${item.orderItemId}/cancel`, payload: { qty: 1, reason: 'Errado', authorizerPin: PIN } });
    const before = (await productionJobs()).length;
    const res = await caixa({ method: 'POST', url: `/api/cashier/order-items/${item.orderItemId}/restore`, payload: { reason: 'Errei', authorizerPin: PIN, resend: false } });
    expect(res.json()).toMatchObject({ sent: false });
    expect((await productionJobs()).length).toBe(before);
  });
});

describe('descancelar mesa', () => {
  it('a mesa cancelada aparece em Contas fechadas e volta aberta com os itens do cancelamento', async () => {
    const ana = await open(ids.mesa2, 'Ana');
    const bia = await open(ids.mesa2, 'Bia');
    await order(ids.mesa2, [ana], ids.cerveja, 2);
    await order(ids.mesa2, [ana, bia], ids.porcao, 1);
    await order(ids.mesa2, [bia], ids.cerveja, 1);
    // Cancelado antes, sozinho: continua cancelado depois de descancelar a mesa.
    const solo = (await bill(bia)).items.find((i) => i.productName === 'Cerveja')!;
    await caixa({ method: 'POST', url: `/api/cashier/order-items/${solo.orderItemId}/cancel`, payload: { qty: 1, reason: 'Não quis', authorizerPin: PIN } });
    await caixa({ method: 'POST', url: '/api/cashier/comandas/cancel', payload: { comandaIds: [ana, bia], reason: 'Foram embora', authorizerPin: PIN } });

    const closed = (await caixa({ method: 'GET', url: '/api/cashier/closed-comandas' })).json() as ClosedBillsResponse;
    expect(closed.canceled).toHaveLength(1);
    expect(closed.canceled[0]).toMatchObject({ tableNumber: 2, customers: ['Ana', 'Bia'], reason: 'Foram embora', itemsCents: 5000 });

    const res = await caixa({ method: 'POST', url: '/api/cashier/comandas/restore', payload: { comandaIds: closed.canceled[0]!.comandaIds, reason: 'Cancelei a mesa errada', authorizerPin: PIN } });
    expect(res.json()).toMatchObject({ restoredComandas: 2, restoredItems: 2, tableId: ids.mesa2 });
    const rows = await ctx.db.select().from(comandas).where(and(eq(comandas.tableId, ids.mesa2), eq(comandas.status, 'ABERTA')));
    expect(rows).toHaveLength(2);
    const b = await bill(ana, bia);
    expect(b.totals.itemsCents).toBe(5000);
    expect(b.items.filter((i) => i.canceled).map((i) => i.productName)).toEqual(['Cerveja']);
    expect((await caixa({ method: 'GET', url: '/api/cashier/closed-comandas' })).json().canceled).toEqual([]);
    expect(await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'COMANDA_DESCANCELADA'))).toHaveLength(1);
  });

  it('item de comanda cancelada pede para descancelar a mesa', async () => {
    const c = await open(ids.mesa2, 'Caio');
    await order(ids.mesa2, [c], ids.cerveja, 1);
    const item = (await bill(c)).items[0]!;
    await caixa({ method: 'POST', url: '/api/cashier/comandas/cancel', payload: { comandaIds: [c], reason: 'Teste', authorizerPin: PIN } });
    const res = await caixa({ method: 'POST', url: `/api/cashier/order-items/${item.orderItemId}/restore`, payload: { reason: 'Teste', authorizerPin: PIN } });
    expect(res.json().message).toMatch(/Descancele a mesa em Contas fechadas/);
  });
});
