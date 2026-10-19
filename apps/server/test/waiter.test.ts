import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comandas, orderItems, orders, printJobs } from '../src/db/schema';
import { createCpfVault } from '../src/lib/cpf-vault';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let garcom: Inject;
type Key = 'bar' | 'cozinha' | 'cervejas' | 'porcoes' | 'sobremesas' | 'heineken' | 'fritas' | 'pudim' | 'mesa10' | 'mesa11' | 'paulo' | 'ana' | 'pauloMesa11';
const ids = {} as Record<Key, string>;

// CPFs válidos de teste (gerados, não pertencem a ninguém).
const CPF = ['529.982.247-25', '111.444.777-35', '935.411.347-80', '286.255.878-87', '714.602.380-01'];

const open = (tableId: string, customerName: string, cpf: string, clientUuid = randomUUID()) =>
  garcom({ method: 'POST', url: '/api/waiter/comandas', payload: { clientUuid, tableId, customerName, cpf } });

const order = (payload: { comandaIds: string[]; items: { productId: string; qty: number; notes?: string }[]; tableId?: string; clientUuid?: string }) =>
  garcom({
    method: 'POST',
    url: '/api/waiter/orders',
    payload: { clientUuid: randomUUID(), tableId: ids.mesa10, createdAtDevice: new Date().toISOString(), ...payload },
  });

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  garcom = await ctx.as('garcom');
  const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();

  ids.bar = (await post('/api/admin/printers', { name: 'Bar', windowsName: 'P1', sectorLabel: 'BAR' })).id;
  ids.cozinha = (await post('/api/admin/printers', { name: 'Cozinha', windowsName: 'P2', sectorLabel: 'COZINHA' })).id;
  ids.cervejas = (await post('/api/admin/categories', { name: 'Cervejas', printerIds: [ids.bar] })).id;
  ids.porcoes = (await post('/api/admin/categories', { name: 'Porções', printerIds: [ids.cozinha] })).id;
  ids.sobremesas = (await post('/api/admin/categories', { name: 'Sobremesas' })).id;
  ids.heineken = (await post('/api/admin/products', { categoryId: ids.cervejas, name: 'Heineken', priceCents: 1890 })).id;
  ids.fritas = (await post('/api/admin/products', { categoryId: ids.porcoes, name: 'Fritas', priceCents: 1000 })).id;
  ids.pudim = (await post('/api/admin/products', { categoryId: ids.sobremesas, name: 'Pudim', priceCents: 1200 })).id;
  const tables = (await post('/api/admin/tables/bulk', { from: 10, to: 12 })).created as { id: string; number: number }[];
  ids.mesa10 = tables.find((t) => t.number === 10)!.id;
  ids.mesa11 = tables.find((t) => t.number === 11)!.id;
});
afterAll(() => ctx.close());

describe('abertura de comanda', () => {
  it('exige CPF válido', async () => {
    const res = await open(ids.mesa10, 'Paulo', '123.456.789-00');
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('CPF inválido');
  });

  it('abre com nome + CPF + mesa e nunca grava o CPF em claro', async () => {
    const res = await open(ids.mesa10, 'Paulo', CPF[0]!);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ customerName: 'Paulo', tableNumber: 10, status: 'ABERTA', totalCents: 0 });
    ids.paulo = res.json().id;

    const [row] = await ctx.db.select().from(comandas).where(eq(comandas.id, ids.paulo));
    expect(JSON.stringify(row)).not.toContain('52998224725');
    expect(row!.cpfLast3).toBe('725');
    const vault = createCpfVault('c'.repeat(32));
    expect(row!.cpfHmac).toBe(vault.hmac(CPF[0]!));
    expect(vault.reveal(row!.cpfEncrypted)).toBe('52998224725');
  });

  it('reenviar a mesma abertura (mesmo clientUuid) não duplica', async () => {
    const uuid = randomUUID();
    const a = await open(ids.mesa10, 'Ana', CPF[1]!, uuid);
    const b = await open(ids.mesa10, 'Ana', CPF[1]!, uuid);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    ids.ana = a.json().id;
  });

  it('um CPF só pode ter uma comanda aberta, em qualquer mesa', async () => {
    const res = await open(ids.mesa11, 'Paulo H.', '52998224725');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'CPF_HAS_OPEN_COMANDA' });
    expect(res.json().message).toContain('mesa 10');
  });

  it('nome repetido na mesma mesa pede complemento; em outra mesa pode', async () => {
    const dup = await open(ids.mesa10, 'paulo', CPF[2]!);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('DUPLICATE_NAME');
    expect((await open(ids.mesa10, 'Paulo S.', CPF[2]!)).statusCode).toBe(201);
    const other = await open(ids.mesa11, 'Paulo', CPF[3]!);
    expect(other.statusCode).toBe(201);
    ids.pauloMesa11 = other.json().id;
  });

  it('caixa não usa as rotas do garçom', async () => {
    const caixa = await ctx.as('caixa');
    expect((await caixa({ method: 'GET', url: '/api/waiter/tables' })).statusCode).toBe(403);
  });
});

describe('lançamento de pedidos', () => {
  it('grava o pedido e gera um cupom por impressora, no setor certo', async () => {
    const res = await order({
      comandaIds: [ids.paulo],
      items: [
        { productId: ids.heineken, qty: 2 },
        { productId: ids.fritas, qty: 1, notes: 'sem sal' },
        { productId: ids.pudim, qty: 1 },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ duplicate: false, printJobs: 2, unroutedItems: 1 });

    const jobs = await ctx.db.select().from(printJobs).where(eq(printJobs.referenceId, res.json().orderId));
    const bar = jobs.find((j) => j.printerId === ids.bar)!;
    const cozinha = jobs.find((j) => j.printerId === ids.cozinha)!;
    expect(bar.payload).toMatchObject({ sector: 'BAR', tableNumber: 10, customers: ['Paulo'], waiter: 'garcom', items: [{ qty: 2, name: 'Heineken' }] });
    expect(cozinha.payload).toMatchObject({ sector: 'COZINHA', items: [{ qty: 1, name: 'Fritas', notes: 'sem sal' }] });
    expect(bar.status).toBe('PENDENTE');

    const detail = (await garcom({ method: 'GET', url: `/api/waiter/comandas/${ids.paulo}` })).json();
    expect(detail.subtotalCents).toBe(2 * 1890 + 1000 + 1200);
    expect(detail.items).toHaveLength(3);
  });

  it('reenvio do mesmo pedido (inclusive simultâneo) nunca duplica itens nem cupons', async () => {
    const clientUuid = randomUUID();
    const payload = { clientUuid, comandaIds: [ids.ana], items: [{ productId: ids.heineken, qty: 1 }] };
    const [a, b] = await Promise.all([order(payload), order(payload)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    const c = await order(payload);
    expect(c.json()).toMatchObject({ duplicate: true, printJobs: 1 });

    const saved = await ctx.db.select().from(orders).where(eq(orders.clientUuid, clientUuid));
    expect(saved).toHaveLength(1);
    expect(await ctx.db.select().from(orderItems).where(eq(orderItems.orderId, saved[0]!.id))).toHaveLength(1);
    expect(await ctx.db.select().from(printJobs).where(eq(printJobs.referenceId, saved[0]!.id))).toHaveLength(1);
  });

  it('rateio entre comandas divide o valor sem perder centavos', async () => {
    const extra = (await open(ids.mesa10, 'Bia', CPF[4]!)).json().id;
    const res = await order({ comandaIds: [extra, ids.ana, ids.paulo], items: [{ productId: ids.fritas, qty: 1 }] });
    expect(res.statusCode).toBe(201);

    const part = async (id: string) =>
      (await garcom({ method: 'GET', url: `/api/waiter/comandas/${id}` })).json().items.find((i: { productName: string; sharedWith: number }) => i.productName === 'Fritas' && i.sharedWith === 3);
    expect((await part(extra)).amountCents).toBe(334);
    expect((await part(ids.ana)).amountCents).toBe(333);
    expect((await part(ids.paulo)).amountCents).toBe(333);

    const [job] = await ctx.db.select().from(printJobs).where(eq(printJobs.referenceId, res.json().orderId));
    expect(job!.payload).toMatchObject({ customers: ['Bia', 'Ana', 'Paulo'] });
  });

  it('recusa produto esgotado e comanda de outra mesa', async () => {
    await admin({ method: 'PATCH', url: `/api/admin/products/${ids.pudim}/sold-out`, payload: { soldOut: true } });
    const sold = await order({ comandaIds: [ids.paulo], items: [{ productId: ids.pudim, qty: 1 }] });
    expect(sold.statusCode).toBe(409);
    expect(sold.json()).toMatchObject({ error: 'SOLD_OUT', message: 'Esgotado: Pudim.' });
    await admin({ method: 'PATCH', url: `/api/admin/products/${ids.pudim}/sold-out`, payload: { soldOut: false } });

    const wrong = await order({ comandaIds: [ids.pauloMesa11], items: [{ productId: ids.fritas, qty: 1 }] });
    expect(wrong.statusCode).toBe(400);
  });

  it('preço fica congelado no item: mudar o cardápio não muda a comanda', async () => {
    const before = (await garcom({ method: 'GET', url: `/api/waiter/comandas/${ids.ana}` })).json().subtotalCents;
    const product = (await admin({ method: 'GET', url: '/api/admin/products' })).json().find((p: { id: string }) => p.id === ids.heineken);
    await admin({ method: 'PUT', url: `/api/admin/products/${ids.heineken}`, payload: { ...product, priceCents: 2500 } });
    expect((await garcom({ method: 'GET', url: `/api/waiter/comandas/${ids.ana}` })).json().subtotalCents).toBe(before);
  });
});

describe('mapa de mesas e fechamento', () => {
  it('mostra status, quantidade de comandas e total por mesa', async () => {
    const map = (await garcom({ method: 'GET', url: '/api/waiter/tables' })).json();
    const m10 = map.tables.find((t: { number: number }) => t.number === 10);
    const m12 = map.tables.find((t: { number: number }) => t.number === 12);
    expect(m10).toMatchObject({ status: 'OCUPADA', comandaCount: 4 });
    expect(m10.totalCents).toBeGreaterThan(0);
    expect(m10.lastAttendedAt).not.toBeNull();
    expect(m12).toMatchObject({ status: 'LIVRE', comandaCount: 0, lastAttendedAt: null });
    expect(map).toMatchObject({ alertYellowMinutes: 15, alertRedMinutes: 30 });
  });

  it('"atendi a mesa" é idempotente e atualiza o último atendimento', async () => {
    const clientUuid = randomUUID();
    const before = (await garcom({ method: 'GET', url: '/api/waiter/tables' })).json().tables.find((t: { number: number }) => t.number === 11).lastAttendedAt;
    await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 2; i++) {
      expect((await garcom({ method: 'POST', url: `/api/waiter/tables/${ids.mesa11}/visit`, payload: { clientUuid } })).statusCode).toBe(204);
    }
    const after = (await garcom({ method: 'GET', url: '/api/waiter/tables' })).json().tables.find((t: { number: number }) => t.number === 11).lastAttendedAt;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('pedir fechamento deixa a mesa em fechamento quando todas as comandas pediram', async () => {
    const res = await garcom({ method: 'POST', url: `/api/waiter/comandas/${ids.pauloMesa11}/request-close` });
    expect(res.json().status).toBe('EM_FECHAMENTO');
    const map = (await garcom({ method: 'GET', url: '/api/waiter/tables' })).json();
    expect(map.tables.find((t: { number: number }) => t.number === 11).status).toBe('EM_FECHAMENTO');
  });

  it('taxa de serviço aparece na comanda quando o dono liga', async () => {
    const settings = (await admin({ method: 'GET', url: '/api/admin/settings' })).json();
    await admin({ method: 'PUT', url: '/api/admin/settings', payload: { ...settings, serviceFeeEnabled: true } });
    const d = (await garcom({ method: 'GET', url: `/api/waiter/comandas/${ids.paulo}` })).json();
    expect(d.serviceFeeCents).toBe(Math.round(d.subtotalCents / 10));
    expect(d.totalWithFeeCents).toBe(d.subtotalCents + d.serviceFeeCents);
  });

  it('pedido para comanda encerrada é recusado, mas o reenvio de um pedido já aceito continua ok', async () => {
    const clientUuid = randomUUID();
    const ok = await order({ clientUuid, comandaIds: [ids.ana], items: [{ productId: ids.fritas, qty: 1 }] });
    expect(ok.statusCode).toBe(201);
    await ctx.db.update(comandas).set({ status: 'FECHADA', closedAt: new Date() }).where(eq(comandas.id, ids.ana));

    const late = await order({ comandaIds: [ids.ana], items: [{ productId: ids.fritas, qty: 1 }] });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe('COMANDA_NOT_OPEN');

    const resend = await order({ clientUuid, comandaIds: [ids.ana], items: [{ productId: ids.fritas, qty: 1 }] });
    expect(resend.statusCode).toBe(200);
    expect(resend.json().duplicate).toBe(true);
  });

  it('cardápio do garçom traz só itens ativos, agrupados por categoria', async () => {
    const menu = (await garcom({ method: 'GET', url: '/api/waiter/menu' })).json();
    expect(menu.map((c: { name: string }) => c.name)).toEqual(['Cervejas', 'Porções', 'Sobremesas']);
    expect(menu[0].products[0]).toMatchObject({ name: 'Heineken', priceCents: 2500, soldOut: false });
  });
});
