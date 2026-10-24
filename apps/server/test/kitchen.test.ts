import { randomUUID } from 'node:crypto';
import type { Bill, KitchenPanelResponse } from '@sistema-bar/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, printJobs } from '../src/db/schema';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let garcom: Inject;
let caixa: Inject;
let cozinha: Inject;
const PIN = '4321';
const ids = {} as Record<'pratos' | 'bar' | 'kitchen' | 'file' | 'heineken' | 'mesa1' | 'paulo' | 'ana', string>;

const order = (comandaId: string, items: { productId: string; qty: number; notes?: string }[], takeaway?: boolean) =>
  garcom({
    method: 'POST',
    url: '/api/waiter/orders',
    payload: { clientUuid: randomUUID(), tableId: ids.mesa1, comandaIds: [comandaId], items, createdAtDevice: new Date().toISOString(), takeaway },
  });
const panel = async (): Promise<KitchenPanelResponse> => (await cozinha({ method: 'GET', url: '/api/kitchen' })).json();
const ready = (id: string) => cozinha({ method: 'POST', url: `/api/kitchen/tickets/${id}/ready`, payload: {} });
const billItem = async (comandaId: string, name: string) => {
  const bill: Bill = (await caixa({ method: 'POST', url: '/api/cashier/bill', payload: { comandaIds: [comandaId] } })).json();
  return bill.items.find((i) => i.productName === name && !i.canceled)!;
};
const cancel = (orderItemId: string, qty: number) =>
  caixa({ method: 'POST', url: `/api/cashier/order-items/${orderItemId}/cancel`, payload: { qty, reason: 'Desistiu', authorizerPin: PIN } });
const cancelJobs = () => ctx.db.select().from(printJobs).where(and(eq(printJobs.printerId, ids.kitchen), eq(printJobs.type, 'CANCELAMENTO')));

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  garcom = await ctx.as('garcom');
  caixa = await ctx.as('caixa');
  cozinha = await ctx.as('cozinha');
  const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();

  const users = (await admin({ method: 'GET', url: '/api/admin/users' })).json();
  const me = users.find((u: { login: string }) => u.login === 'admin');
  await admin({ method: 'PUT', url: `/api/admin/users/${me.id}`, payload: { ...me, pin: PIN } });

  // Estes testes conferem o aviso de cancelamento nos setores (desligado por padrão).
  const current = (await admin({ method: 'GET', url: '/api/admin/settings' })).json();
  await admin({ method: 'PUT', url: '/api/admin/settings', payload: { ...current, printCancelTickets: true } });
  const pratos = (ids.pratos = (await post('/api/admin/categories', { name: 'Pratos' })).id);
  const cervejas = (await post('/api/admin/categories', { name: 'Cervejas' })).id;
  ids.kitchen = (await post('/api/admin/printers', { name: 'Cozinha', windowsName: 'ELGIN COZINHA', sectorLabel: 'COZINHA', usesPanel: true, categoryIds: [pratos] })).id;
  ids.bar = (await post('/api/admin/printers', { name: 'Bar', windowsName: 'ELGIN BAR', sectorLabel: 'BAR', categoryIds: [cervejas] })).id;
  ids.file = (await post('/api/admin/products', { categoryId: pratos, name: 'Filé à parmegiana', priceCents: 6000 })).id;
  ids.heineken = (await post('/api/admin/products', { categoryId: cervejas, name: 'Heineken', priceCents: 1500 })).id;
  const tables = (await post('/api/admin/tables/bulk', { from: 1, to: 2 })).created as { id: string; number: number }[];
  ids.mesa1 = tables.find((t) => t.number === 1)!.id;
  const register = (await post('/api/admin/registers', { name: 'Caixa 1' })).id;
  await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: register, openingFloatCents: 0 } });

  const open = async (customerName: string) =>
    (await garcom({ method: 'POST', url: '/api/waiter/comandas', payload: { clientUuid: randomUUID(), tableId: ids.mesa1, customerName, phone: '(34) 99999-0000' } })).json()
      .id as string;
  ids.paulo = await open('Paulo');
  ids.ana = await open('Ana');
});
afterAll(() => ctx.close());

describe('painel da cozinha', () => {
  it('pedido da cozinha vai para o painel sem imprimir; o do bar imprime na hora', async () => {
    const res = await order(ids.paulo, [{ productId: ids.file, qty: 2, notes: 'bem passado' }, { productId: ids.heineken, qty: 1 }], true);
    expect(res.json()).toMatchObject({ printJobs: 1, panelTickets: 1 });
    await ctx.app.printWorker.runOnce();
    expect(ctx.printed.map((p) => p.printer)).toEqual(['Bar']);

    const p = await panel();
    expect(p.printers).toEqual([{ id: ids.kitchen, name: 'Cozinha', sector: 'COZINHA' }]);
    expect(p.tickets).toHaveLength(1);
    expect(p.tickets[0]).toMatchObject({
      tableNumber: 1,
      tableLabel: null,
      customers: ['Paulo'],
      waiter: 'garcom',
      takeaway: true,
      items: [{ qty: 2, name: 'Filé à parmegiana', notes: 'bem passado' }],
    });
    expect(Date.now() - Date.parse(p.tickets[0]!.createdAt)).toBeLessThan(60_000);
    // O id interno do item não vai para a tela.
    expect(JSON.stringify(p.tickets[0])).not.toContain('itemId');
  });

  it('só a cozinha (e gerente/admin) vê o painel', async () => {
    expect((await garcom({ method: 'GET', url: '/api/kitchen' })).statusCode).toBe(403);
    expect((await caixa({ method: 'GET', url: '/api/kitchen' })).statusCode).toBe(403);
    expect((await admin({ method: 'GET', url: '/api/kitchen' })).statusCode).toBe(200);
    // E a cozinha não lança pedido nem mexe no caixa.
    expect((await cozinha({ method: 'GET', url: '/api/waiter/tables' })).statusCode).toBe(403);
    expect((await cozinha({ method: 'GET', url: '/api/cashier/tables' })).statusCode).toBe(403);
  });

  it('cancelar item ainda no painel tira do cartão, sem cupom de cancelamento', async () => {
    const item = await billItem(ids.paulo, 'Filé à parmegiana');
    expect((await cancel(item.orderItemId, 1)).statusCode).toBe(200);
    expect((await panel()).tickets[0]!.items).toEqual([{ qty: 1, name: 'Filé à parmegiana', notes: 'bem passado' }]);
    expect(await cancelJobs()).toHaveLength(0);
  });

  it('comanda transferida: o cartão e o cupom saem com a mesa nova', async () => {
    await caixa({ method: 'POST', url: '/api/cashier/transfer', payload: { comandaIds: [ids.paulo], toTableNumber: 2 } });
    const [ticket] = (await panel()).tickets;
    expect(ticket!.tableNumber).toBe(2);

    ctx.printed.length = 0;
    expect((await ready(ticket!.id)).json()).toEqual({ ok: true, already: false });
    expect((await panel()).tickets).toEqual([]);
    await ctx.app.printWorker.runOnce();
    const printed = ctx.printed.find((p) => p.printer === 'Cozinha')!;
    expect(printed.preview).toContain('M E S A   2');
    expect(printed.preview).toContain('V I A G E M');
    expect(printed.preview).toContain('1x Filé à parmegiana');
    expect(printed.preview).toContain('>> BEM PASSADO');

    const [job] = await ctx.db.select().from(printJobs).where(eq(printJobs.id, ticket!.id));
    expect(job).toMatchObject({ status: 'OK' });
    expect(job!.readyAt).toBeInstanceOf(Date);
    // Segundo Enter (ou outra tela) no mesmo pedido não imprime de novo.
    expect((await ready(ticket!.id)).json()).toEqual({ ok: true, already: true });
  });

  it('depois do "pronto", cancelar manda o cupom de cancelamento como sempre', async () => {
    const item = await billItem(ids.paulo, 'Filé à parmegiana');
    expect((await cancel(item.orderItemId, 1)).statusCode).toBe(200);
    expect(await cancelJobs()).toHaveLength(1);
  });

  it('pedido todo cancelado antes do "pronto" some do painel; sem "para viagem" não leva a faixa', async () => {
    await order(ids.ana, [{ productId: ids.file, qty: 1 }]);
    const [ticket] = (await panel()).tickets;
    expect(ticket).toMatchObject({ customers: ['Ana'], takeaway: false, tableNumber: 1 });
    await cancel((await billItem(ids.ana, 'Filé à parmegiana')).orderItemId, 1);
    expect((await panel()).tickets).toEqual([]);
    expect((await ready(ticket!.id)).statusCode).toBe(404);
  });

  it('Enter sem querer: o pedido aparece nos finalizados e volta para a tela', async () => {
    await ctx.app.printWorker.runOnce();
    ctx.printed.length = 0;
    await order(ids.ana, [{ productId: ids.file, qty: 1, notes: 'sem queijo' }]);
    const [ticket] = (await panel()).tickets;
    await ready(ticket!.id);
    await ctx.app.printWorker.runOnce();
    expect(ctx.printed.map((p) => p.printer)).toEqual(['Cozinha']);

    const done = (await cozinha({ method: 'GET', url: '/api/kitchen/done' })).json();
    expect(done[0]).toMatchObject({ id: ticket!.id, customers: ['Ana'], printed: true, readyBy: 'cozinha' });
    expect((await garcom({ method: 'POST', url: `/api/kitchen/tickets/${ticket!.id}/revert`, payload: {} })).statusCode).toBe(403);

    expect((await cozinha({ method: 'POST', url: `/api/kitchen/tickets/${ticket!.id}/revert`, payload: {} })).json()).toEqual({ ok: true, already: false });
    // Volta com o mesmo cronômetro e sai dos finalizados.
    const back = (await panel()).tickets.find((t) => t.id === ticket!.id)!;
    expect(back.createdAt).toBe(ticket!.createdAt);
    expect((await cozinha({ method: 'GET', url: '/api/kitchen/done' })).json().some((d: { id: string }) => d.id === ticket!.id)).toBe(false);
    expect((await cozinha({ method: 'POST', url: `/api/kitchen/tickets/${ticket!.id}/revert`, payload: {} })).json()).toEqual({ ok: true, already: true });

    const [log] = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'PAINEL_REVERTIDO'));
    expect(log).toMatchObject({ entityId: ticket!.id });

    // Pronto de novo: imprime de novo.
    ctx.printed.length = 0;
    await ready(ticket!.id);
    await ctx.app.printWorker.runOnce();
    expect(ctx.printed.map((p) => p.printer)).toEqual(['Cozinha']);
    expect(ctx.printed[0]!.preview).toContain('>> SEM QUEIJO');
  });

  it('reverter antes de imprimir: o cupom não sai', async () => {
    await order(ids.ana, [{ productId: ids.file, qty: 2 }]);
    const [ticket] = (await panel()).tickets;
    await ready(ticket!.id);
    await cozinha({ method: 'POST', url: `/api/kitchen/tickets/${ticket!.id}/revert`, payload: {} });
    ctx.printed.length = 0;
    await ctx.app.printWorker.runOnce();
    expect(ctx.printed).toEqual([]);
    expect((await panel()).tickets.map((t) => t.id)).toContain(ticket!.id);
    // Deixa o painel limpo para o próximo teste.
    await ready(ticket!.id);
    await ctx.app.printWorker.runOnce();
    expect((await cozinha({ method: 'POST', url: `/api/kitchen/tickets/${randomUUID()}/revert`, payload: {} })).statusCode).toBe(404);
  });

  it('pronto só de alguns itens: o cupom sai com eles e o resto continua no painel', async () => {
    await ctx.app.printWorker.runOnce();
    ctx.printed.length = 0;
    await order(ids.ana, [{ productId: ids.file, qty: 2, notes: 'ao ponto' }, { productId: ids.file, qty: 1, notes: 'sem molho' }]);
    const [ticket] = (await panel()).tickets.filter((t) => t.customers[0] === 'Ana');
    expect(ticket!.items).toHaveLength(2);
    const res = await cozinha({ method: 'POST', url: `/api/kitchen/tickets/${ticket!.id}/ready`, payload: { items: [1] } });
    expect(res.json()).toMatchObject({ ok: true, partial: true, printedItems: 1, remainingItems: 1 });
    await ctx.app.printWorker.runOnce();
    expect(ctx.printed.map((p) => p.printer)).toEqual(['Cozinha']);
    expect(ctx.printed[0]!.preview).toContain('>> SEM MOLHO');
    expect(ctx.printed[0]!.preview).not.toContain('AO PONTO');
    const still = (await panel()).tickets.find((t) => t.id === ticket!.id)!;
    expect(still.items).toEqual([{ qty: 2, name: 'Filé à parmegiana', notes: 'ao ponto' }]);
    expect(still.createdAt).toBe(ticket!.createdAt);
    // O resto, depois: pronto normal.
    await ready(ticket!.id);
    await ctx.app.printWorker.runOnce();
    expect((await panel()).tickets.find((t) => t.id === ticket!.id)).toBeUndefined();
  });

  it('cupom da cozinha sai só com a hora (sem a data)', async () => {
    const last = ctx.printed.at(-1)!.preview;
    expect(last).toMatch(/garcom · \d{2}:\d{2} · #/);
  });

  it('impressora sem painel continua imprimindo na hora', async () => {
    await admin({
      method: 'PUT',
      url: `/api/admin/printers/${ids.kitchen}`,
      payload: { name: 'Cozinha', windowsName: 'ELGIN COZINHA', sectorLabel: 'COZINHA', usesPanel: false, categoryIds: [ids.pratos] },
    });
    await ctx.app.printWorker.runOnce(); // o cupom de cancelamento do teste anterior
    ctx.printed.length = 0;
    expect((await order(ids.ana, [{ productId: ids.file, qty: 1 }])).json()).toMatchObject({ printJobs: 1, panelTickets: 0 });
    await ctx.app.printWorker.runOnce();
    expect(ctx.printed.map((p) => p.printer)).toEqual(['Cozinha']);
    expect((await panel()).tickets).toEqual([]);
  });
});
