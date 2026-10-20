import { randomUUID } from 'node:crypto';
import type { Bill } from '@sistema-bar/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, printJobs } from '../src/db/schema';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let caixa: Inject;
let garcom: Inject;
const PIN = '2468';
const ids = {} as Record<'bar' | 'register' | 'mesa' | 'joao' | 'ana' | 'cerveja' | 'porcao', string>;

const order = async (comandaIds: string[], productId: string, qty: number) => {
  await garcom({
    method: 'POST',
    url: '/api/waiter/orders',
    payload: { clientUuid: randomUUID(), tableId: ids.mesa, comandaIds, items: [{ productId, qty }], createdAtDevice: new Date().toISOString() },
  });
};
const bill = async (...comandaIds: string[]): Promise<Bill> =>
  (await caixa({ method: 'POST', url: '/api/cashier/bill', payload: { comandaIds } })).json();
const cancel = (orderItemId: string, body: Record<string, unknown>, as: Inject = caixa) =>
  as({ method: 'POST', url: `/api/cashier/order-items/${orderItemId}/cancel`, payload: { reason: 'Lançado errado', ...body } });
const itemOf = (b: Bill, name: string, comandaId: string, canceled = false) =>
  b.items.find((i) => i.productName === name && i.comandaId === comandaId && i.canceled === canceled)!;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  caixa = await ctx.as('caixa');
  garcom = await ctx.as('garcom');
  const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();

  // O PIN que autoriza é o do administrador (o gerente também poderia ter um).
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

  ids.mesa = ((await post('/api/admin/tables/bulk', { from: 1, to: 1 })).created as { id: string }[])[0]!.id;
  const open = async (customerName: string, cpf: string) =>
    (await garcom({ method: 'POST', url: '/api/waiter/comandas', payload: { clientUuid: randomUUID(), tableId: ids.mesa, customerName, cpf } })).json().id as string;
  ids.joao = await open('João', '529.982.247-25');
  ids.ana = await open('Ana', '111.444.777-35');
  await order([ids.joao], ids.cerveja, 3); // 30,00
  await order([ids.joao, ids.ana], ids.porcao, 1); // 30,00 rateado: 15,00 cada
});
afterAll(() => ctx.close());

describe('cancelar item no caixa', () => {
  it('perfil Caixa precisa do PIN de gerente/admin; PIN errado é recusado', async () => {
    const item = itemOf(await bill(ids.joao), 'Cerveja', ids.joao);
    expect((await cancel(item.orderItemId, { qty: 1 })).json().error).toBe('PIN_REQUIRED');
    const wrong = await cancel(item.orderItemId, { qty: 1, authorizerPin: '0000' });
    expect(wrong.json().error).toBe('PIN_INVALID');
    expect(wrong.json().message).toMatch(/gerente ou do administrador/);
    expect((await cancel(item.orderItemId, { qty: 1, reason: '' }, garcom)).statusCode).toBe(403);
  });

  it('cancela parte da quantidade: 1 de 3 cervejas sai da conta e o bar recebe o aviso', async () => {
    const item = itemOf(await bill(ids.joao), 'Cerveja', ids.joao);
    const res = await cancel(item.orderItemId, { qty: 1, authorizerPin: PIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ canceledQty: 1, remainingQty: 2, printed: true });

    const b = await bill(ids.joao);
    expect(itemOf(b, 'Cerveja', ids.joao)).toMatchObject({ qty: 2, amountCents: 2000, canceled: false });
    expect(itemOf(b, 'Cerveja', ids.joao, true)).toMatchObject({ qty: 1, amountCents: 0, canceled: true });
    expect(b.comandas[0]!.totals.itemsCents).toBe(2000 + 1500);

    const [job] = await ctx.db.select().from(printJobs).where(and(eq(printJobs.type, 'CANCELAMENTO'), eq(printJobs.referenceId, item.orderItemId)));
    expect(job!.printerId).toBe(ids.bar);
    expect(job!.payload).toMatchObject({ kind: 'CANCELAMENTO', sector: 'BAR', items: [{ qty: 1, name: 'Cerveja' }], authorizedBy: 'admin', reason: 'Lançado errado' });
    const logs = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'ITEM_CANCELADO'));
    expect(logs).toHaveLength(1);
  });

  it('não cancela mais do que tem nem o que já foi cancelado', async () => {
    const b = await bill(ids.joao);
    const item = itemOf(b, 'Cerveja', ids.joao);
    expect((await cancel(item.orderItemId, { qty: 5, authorizerPin: PIN })).json().message).toBe('O item tem só 2 unidade(s).');
    expect((await cancel(itemOf(b, 'Cerveja', ids.joao, true).orderItemId, { qty: 1, authorizerPin: PIN })).json().error).toBe('ALREADY_CANCELED');
  });

  it('item rateado: cancela para as duas comandas', async () => {
    const porcao = itemOf(await bill(ids.joao, ids.ana), 'Porção', ids.ana);
    // Admin logado não precisa digitar PIN.
    expect((await cancel(porcao.orderItemId, { qty: 1 }, admin)).statusCode).toBe(200);
    const b = await bill(ids.joao, ids.ana);
    expect(itemOf(b, 'Porção', ids.joao, true).canceled).toBe(true);
    expect(itemOf(b, 'Porção', ids.ana, true).canceled).toBe(true);
    expect(b.comandas.find((c) => c.id === ids.ana)!.totals.itemsCents).toBe(0);
  });

  it('item já pago precisa de estorno antes', async () => {
    const item = itemOf(await bill(ids.joao), 'Cerveja', ids.joao);
    const paid = await caixa({
      method: 'POST',
      url: '/api/cashier/payments',
      payload: {
        clientUuid: randomUUID(),
        registerId: ids.register,
        comandaIds: [ids.joao],
        method: 'PIX',
        amountCents: 1000,
        payerName: 'João',
        items: [{ orderItemId: item.orderItemId, comandaId: ids.joao, num: 1, den: 2 }],
      },
    });
    expect(paid.statusCode).toBe(201);
    const res = await cancel(item.orderItemId, { qty: 1, authorizerPin: PIN });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/Estorne o pagamento/);
  });
});
