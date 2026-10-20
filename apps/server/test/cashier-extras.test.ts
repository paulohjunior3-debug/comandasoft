import { randomUUID } from 'node:crypto';
import type { Bill, CashierTable, TableMapResponse } from '@sistema-bar/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { couvertWindows, printJobs } from '../src/db/schema';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let caixa: Inject;
let gerente: Inject;
const PIN = '1357';
const mesa: Record<number, string> = {};
const ids = {} as Record<'cerveja' | 'porcao' | 'register' | 'ana' | 'bruno' | 'carla', string>;

const order = (as: Inject, tableId: string, comandaIds: string[], productId: string, qty: number) =>
  as({
    method: 'POST',
    url: '/api/waiter/orders',
    payload: { clientUuid: randomUUID(), tableId, comandaIds, items: [{ productId, qty }], createdAtDevice: new Date().toISOString() },
  });
const open = async (as: Inject, table: number, customerName: string, cpf: string, peopleCount = 1) =>
  (await as({ method: 'POST', url: '/api/waiter/comandas', payload: { clientUuid: randomUUID(), tableId: mesa[table], customerName, cpf, peopleCount } })).json()
    .id as string;
const bill = async (...comandaIds: string[]): Promise<Bill> => (await caixa({ method: 'POST', url: '/api/cashier/bill', payload: { comandaIds } })).json();
const item = (b: Bill, name: string, comandaId: string) => b.items.filter((i) => i.productName === name && i.comandaId === comandaId);

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  caixa = await ctx.as('caixa');
  gerente = await ctx.as('gerente');
  const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();
  const users = (await admin({ method: 'GET', url: '/api/admin/users' })).json();
  const g = users.find((u: { login: string }) => u.login === 'gerente');
  await admin({ method: 'PUT', url: `/api/admin/users/${g.id}`, payload: { ...g, pin: PIN } });

  const bar = (await post('/api/admin/printers', { name: 'Bar', windowsName: 'ELGIN BAR', sectorLabel: 'BAR' })).id;
  const cat = (await post('/api/admin/categories', { name: 'Bebidas' })).id;
  await admin({ method: 'PUT', url: `/api/admin/printers/${bar}`, payload: { name: 'Bar', windowsName: 'ELGIN BAR', sectorLabel: 'BAR', categoryIds: [cat] } });
  ids.cerveja = (await post('/api/admin/products', { categoryId: cat, name: 'Cerveja', priceCents: 1000 })).id;
  ids.porcao = (await post('/api/admin/products', { categoryId: cat, name: 'Porção', priceCents: 3000 })).id;
  for (const t of (await post('/api/admin/tables/bulk', { from: 1, to: 3 })).created as { id: string; number: number }[]) mesa[t.number] = t.id;
  const settings = (await admin({ method: 'GET', url: '/api/admin/settings' })).json();
  await admin({ method: 'PUT', url: '/api/admin/settings', payload: { ...settings, serviceFeeEnabled: true } });
  ids.register = (await post('/api/admin/registers', { name: 'Caixa 1' })).id;
  await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: ids.register, openingFloatCents: 0 } });
});
afterAll(() => ctx.close());

describe('caixa abre mesa e lança itens', () => {
  it('o perfil Caixa abre comanda e lança pedido pela mesma rota do garçom', async () => {
    ids.ana = await open(caixa, 1, 'Ana', '529.982.247-25');
    ids.bruno = await open(caixa, 1, 'Bruno', '111.444.777-35');
    expect((await order(caixa, mesa[1]!, [ids.ana], ids.cerveja, 3)).statusCode).toBe(201);
    expect(item(await bill(ids.ana), 'Cerveja', ids.ana)[0]).toMatchObject({ qty: 3, waiterName: 'caixa' });
  });

  it('lista de mesas para abrir, com quem já está em cada uma', async () => {
    const all = (await caixa({ method: 'GET', url: '/api/cashier/all-tables' })).json();
    expect(all.map((t: { number: number }) => t.number)).toEqual([1, 2, 3]);
    expect(all[0].openNames.sort()).toEqual(['Ana', 'Bruno']);
  });
});

describe('venda no balcão', () => {
  it('sem nome e sem CPF: "Balcão 1", cupom sai como BALCÃO e a conta abre para receber', async () => {
    const res = await caixa({ method: 'POST', url: '/api/cashier/counter/comanda', payload: { clientUuid: randomUUID() } });
    expect(res.statusCode).toBe(201);
    const { comandaId, tableId } = res.json();
    await order(caixa, tableId, [comandaId], ids.cerveja, 2);
    const [job] = (await ctx.db.select().from(printJobs).where(eq(printJobs.type, 'PRODUCAO'))).filter(
      (j) => (j.payload as { tableLabel?: string }).tableLabel === 'Balcão',
    );
    expect(job).toBeTruthy();
    const b = await bill(comandaId);
    // Balcão: sem taxa de serviço (mesmo com a taxa ligada) e sem couvert.
    expect(b).toMatchObject({ tableLabel: 'Balcão', serviceFeeEnabled: false, totals: { itemsCents: 2000, serviceFeeCents: 0, totalCents: 2000 } });
    expect(b.comandas[0]).toMatchObject({ customerName: 'Balcão 1', cpfLast3: null });

    const second = (await caixa({ method: 'POST', url: '/api/cashier/counter/comanda', payload: { clientUuid: randomUUID(), cpf: '286.255.878-87' } })).json();
    expect((await bill(second.comandaId)).comandas[0]).toMatchObject({ customerName: 'Balcão 2', cpfLast3: '887' });
    expect((await caixa({ method: 'POST', url: '/api/cashier/counter/comanda', payload: { clientUuid: randomUUID(), cpf: '123' } })).json().message).toBe('CPF inválido');
  });

  it('o balcão aparece no caixa como "Balcão", mas não no mapa do garçom nem no cadastro de mesas', async () => {
    const tables: CashierTable[] = (await caixa({ method: 'GET', url: '/api/cashier/tables' })).json();
    expect(tables.find((t) => t.isCounter)).toMatchObject({ label: 'Balcão', number: 0 });
    const map: TableMapResponse = (await gerente({ method: 'GET', url: '/api/waiter/tables' })).json();
    expect(map.tables.map((t) => t.number)).not.toContain(0);
    expect((await admin({ method: 'GET', url: '/api/admin/tables' })).json().map((t: { number: number }) => t.number)).not.toContain(0);
    // Não dá para transferir comanda para o balcão (o número 0 nem é aceito).
    const res = await caixa({ method: 'POST', url: '/api/cashier/transfer', payload: { comandaIds: [ids.bruno], toTableNumber: 0 } });
    expect(res.statusCode).toBe(400);
  });
});

describe('mover item entre comandas', () => {
  const move = (orderItemId: string, body: object) => caixa({ method: 'POST', url: `/api/cashier/order-items/${orderItemId}/move`, payload: body });

  it('parte da quantidade para outra comanda da mesma mesa', async () => {
    const cerveja = item(await bill(ids.ana), 'Cerveja', ids.ana)[0]!;
    const res = await move(cerveja.orderItemId, { fromComandaId: ids.ana, toComandaId: ids.bruno, qty: 1 });
    expect(res.json()).toMatchObject({ moved: 1, to: 'Bruno (mesa 1)' });
    const b = await bill(ids.ana, ids.bruno);
    expect(item(b, 'Cerveja', ids.ana)[0]).toMatchObject({ qty: 2, amountCents: 2000 });
    expect(item(b, 'Cerveja', ids.bruno)[0]).toMatchObject({ qty: 1, amountCents: 1000 });
  });

  it('item inteiro para comanda de outra mesa', async () => {
    ids.carla = await open(caixa, 2, 'Carla', '935.411.347-80');
    const cerveja = item(await bill(ids.bruno), 'Cerveja', ids.bruno)[0]!;
    expect((await move(cerveja.orderItemId, { fromComandaId: ids.bruno, toComandaId: ids.carla })).json().to).toBe('Carla (mesa 2)');
    expect(item(await bill(ids.bruno), 'Cerveja', ids.bruno)).toHaveLength(0);
    expect(item(await bill(ids.carla), 'Cerveja', ids.carla)[0]).toMatchObject({ qty: 1, amountCents: 1000 });
  });

  it('item rateado: move só a parte daquela comanda (somando se a outra já dividia)', async () => {
    await order(caixa, mesa[1]!, [ids.ana, ids.bruno], ids.porcao, 1); // 15 + 15
    const porcao = item(await bill(ids.ana), 'Porção', ids.ana)[0]!;
    await move(porcao.orderItemId, { fromComandaId: ids.ana, toComandaId: ids.bruno });
    const b = await bill(ids.ana, ids.bruno);
    expect(item(b, 'Porção', ids.ana)).toHaveLength(0);
    expect(item(b, 'Porção', ids.bruno)[0]!.amountCents).toBe(3000);
  });

  it('item já pago não se move', async () => {
    const cerveja = item(await bill(ids.ana), 'Cerveja', ids.ana)[0]!;
    await caixa({
      method: 'POST',
      url: '/api/cashier/payments',
      payload: {
        clientUuid: randomUUID(),
        registerId: ids.register,
        comandaIds: [ids.ana],
        method: 'PIX',
        amountCents: 1100, // metade de R$ 20,00 + 10% de taxa
        payerName: 'Ana',
        items: [{ orderItemId: cerveja.orderItemId, comandaId: ids.ana, num: 1, den: 2 }],
      },
    });
    const res = await move(cerveja.orderItemId, { fromComandaId: ids.ana, toComandaId: ids.bruno });
    expect(res.json().message).toMatch(/Estorne o pagamento antes de mover/);
  });
});

describe('couvert por show', () => {
  it('caixa precisa do PIN; inicia, cobra quem abre comanda, encerra e para de cobrar', async () => {
    const start = (as: Inject, body: object) => as({ method: 'POST', url: '/api/cashier/couvert/start', payload: body });
    expect((await start(caixa, { amountCents: 1500 })).json().error).toBe('PIN_REQUIRED');
    expect((await start(caixa, { amountCents: 1500, authorizerPin: PIN })).statusCode).toBe(200);
    expect((await start(gerente, { amountCents: 1500 })).json().error).toBe('COUVERT_ACTIVE');

    const casal = await open(caixa, 3, 'Duda', '000.000.001-91', 2);
    expect((await bill(casal)).comandas[0]!.totals.couvertCents).toBe(3000);

    // Encerrou: quem chega depois não paga; quem chegou durante continua pagando.
    expect((await gerente({ method: 'POST', url: '/api/cashier/couvert/stop', payload: {} })).statusCode).toBe(200);
    const depois = await open(caixa, 3, 'Edu', '000.000.002-72');
    expect((await bill(depois)).comandas[0]!.totals.couvertCents).toBe(0);
    expect((await bill(casal)).comandas[0]!.totals.couvertCents).toBe(3000);

    const state = (await caixa({ method: 'GET', url: '/api/cashier/couvert' })).json();
    expect(state).toMatchObject({ active: null, mode: 'UMA_VEZ' });
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].endAt).not.toBeNull();
    expect(await ctx.db.select().from(couvertWindows)).toHaveLength(1);
  });
});

describe('senha', () => {
  it('aceita senha de 4 dígitos e recusa menor', async () => {
    const ok = await admin({ method: 'POST', url: '/api/admin/users', payload: { name: 'Zé', login: 'zeca', role: 'GARCOM', password: '1234', active: true } });
    expect(ok.statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'zeca', password: '1234' } });
    expect(login.statusCode).toBe(200);
    const short = await admin({ method: 'POST', url: '/api/admin/users', payload: { name: 'Y', login: 'yuri', role: 'GARCOM', password: '123', active: true } });
    expect(short.json().message).toBe('A senha precisa de pelo menos 4 caracteres');
  });
});
