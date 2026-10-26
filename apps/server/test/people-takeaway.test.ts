import { randomUUID } from 'node:crypto';
import type { Bill, ComandaSummary } from '@sistema-bar/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, orders, printJobs } from '../src/db/schema';
import type { ProductionTicket } from '../src/printing/tickets';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let caixa: Inject;
let garcom: Inject;
const PIN = '2468';
const ids = {} as Record<'bar' | 'cozinha' | 'mesa' | 'cerveja' | 'porcao', string>;

const open = async (customerName: string, peopleCount = 1) =>
  (
    await garcom({
      method: 'POST',
      url: '/api/waiter/comandas',
      payload: { clientUuid: randomUUID(), tableId: ids.mesa, customerName, phone: '(34) 99999-0000', peopleCount },
    })
  ).json().id as string;
const order = async (comandaId: string, items: { productId: string; qty: number }[]) =>
  (
    await garcom({
      method: 'POST',
      url: '/api/waiter/orders',
      payload: { clientUuid: randomUUID(), tableId: ids.mesa, comandaIds: [comandaId], items, createdAtDevice: new Date().toISOString() },
    })
  ).json().orderId as string;
const bill = async (id: string): Promise<Bill> => (await caixa({ method: 'POST', url: '/api/cashier/bill', payload: { comandaIds: [id] } })).json();
const people = (as: Inject, id: string, body: object) => as({ method: 'POST', url: `/api/waiter/comandas/${id}/people`, payload: body });

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  caixa = await ctx.as('caixa');
  garcom = await ctx.as('garcom');
  const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();
  const users = (await admin({ method: 'GET', url: '/api/admin/users' })).json();
  const me = users.find((u: { login: string }) => u.login === 'admin');
  await admin({ method: 'PUT', url: `/api/admin/users/${me.id}`, payload: { ...me, pin: PIN } });

  const bebidas = (await post('/api/admin/categories', { name: 'Bebidas' })).id;
  const porcoes = (await post('/api/admin/categories', { name: 'Porções' })).id;
  ids.bar = (await post('/api/admin/printers', { name: 'Bar', windowsName: 'ELGIN BAR', sectorLabel: 'BAR' })).id;
  await admin({ method: 'PUT', url: `/api/admin/printers/${ids.bar}`, payload: { name: 'Bar', windowsName: 'ELGIN BAR', sectorLabel: 'BAR', categoryIds: [bebidas] } });
  ids.cozinha = (await post('/api/admin/printers', { name: 'Cozinha', windowsName: 'ELGIN COZ', sectorLabel: 'COZINHA', usesPanel: true })).id;
  await admin({
    method: 'PUT',
    url: `/api/admin/printers/${ids.cozinha}`,
    payload: { name: 'Cozinha', windowsName: 'ELGIN COZ', sectorLabel: 'COZINHA', usesPanel: true, categoryIds: [porcoes] },
  });
  ids.cerveja = (await post('/api/admin/products', { categoryId: bebidas, name: 'Cerveja', priceCents: 1000 })).id;
  ids.porcao = (await post('/api/admin/products', { categoryId: porcoes, name: 'Porção', priceCents: 3000 })).id;
  ids.mesa = ((await post('/api/admin/tables/bulk', { from: 1, to: 1 })).created as { id: string }[])[0]!.id;
  const register = (await post('/api/admin/registers', { name: 'Caixa 1' })).id;
  await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: register, openingFloatCents: 0 } });
  await admin({ method: 'POST', url: '/api/cashier/couvert/start', payload: { amountCents: 1500 } });
});
afterAll(() => ctx.close());

describe('pessoas da comanda', () => {
  it('esqueceu as pessoas: o garçom aumenta e o couvert acompanha', async () => {
    const c = await open('Duda');
    expect((await bill(c)).comandas[0]!.totals.couvertCents).toBe(1500);
    const r = await people(garcom, c, { peopleCount: 3 });
    expect(r.statusCode).toBe(200);
    expect((r.json() as ComandaSummary).peopleCount).toBe(3);
    expect((await bill(c)).comandas[0]!.totals.couvertCents).toBe(4500);
    const [log] = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'COMANDA_PESSOAS'));
    expect(log).toMatchObject({ beforeJson: { peopleCount: 1 }, afterJson: { peopleCount: 3 } });
  });

  it('diminuir pede o PIN do gerente', async () => {
    const c = await open('Edu', 4);
    expect((await people(garcom, c, { peopleCount: 2 })).json().error).toBe('PIN_REQUIRED');
    expect((await people(garcom, c, { peopleCount: 2, authorizerPin: '0000' })).json().error).toBe('PIN_INVALID');
    expect((await people(garcom, c, { peopleCount: 2, authorizerPin: PIN })).json().peopleCount).toBe(2);
    expect((await bill(c)).comandas[0]!.totals.couvertCents).toBe(3000);
    expect((await people(garcom, c, { peopleCount: 0 })).statusCode).toBe(400);
  });
});

describe('para viagem depois de lançado', () => {
  it('muda o painel da cozinha na hora e manda aviso ao bar que já imprimiu', async () => {
    const c = await open('Fabi');
    const orderId = await order(c, [
      { productId: ids.cerveja, qty: 2 },
      { productId: ids.porcao, qty: 1 },
    ]);
    await ctx.app.printWorker.runOnce(); // o cupom do bar sai
    ctx.printed.length = 0;

    const url = `/api/waiter/orders/${orderId}/takeaway`;
    const r = await garcom({ method: 'POST', url, payload: { takeaway: true } });
    expect(r.json()).toMatchObject({ orderId, takeaway: true, changed: true, notified: 1 });
    const [o] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(o!.takeaway).toBe(true);

    const [panel] = await ctx.db.select().from(printJobs).where(and(eq(printJobs.referenceId, orderId), eq(printJobs.status, 'PAINEL')));
    expect((panel!.payload as ProductionTicket).takeaway).toBe(true);
    const kitchen = (await admin({ method: 'GET', url: '/api/kitchen' })).json();
    expect(JSON.stringify(kitchen)).toContain('"takeaway":true');

    await ctx.app.printWorker.runOnce();
    expect(ctx.printed).toHaveLength(1);
    expect(ctx.printed[0]!.printer).toBe('Bar');
    expect(ctx.printed[0]!.preview).toContain('AGORA É PARA VIAGEM');
    expect(ctx.printed[0]!.preview).toContain('2x Cerveja');

    // De novo com o mesmo valor: nada muda.
    expect((await garcom({ method: 'POST', url, payload: { takeaway: true } })).json()).toMatchObject({ changed: false });
    // O caixa vê o item marcado.
    expect((await bill(c)).items.every((i) => i.takeaway && i.orderId === orderId)).toBe(true);
    // Desmarcar avisa o bar de novo.
    expect((await caixa({ method: 'POST', url, payload: { takeaway: false } })).json()).toMatchObject({ takeaway: false, notified: 1 });
    expect(await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'PEDIDO_VIAGEM'))).toHaveLength(2);
  });
});
