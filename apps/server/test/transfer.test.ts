import { randomUUID } from 'node:crypto';
import type { Bill, CashierTable, NameSearchHit } from '@sistema-bar/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, comandas } from '../src/db/schema';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let caixa: Inject;
let garcom: Inject;
const mesa: Record<number, string> = {};
const ids = {} as Record<'anaSilva' | 'joao' | 'anaPaula' | 'bia' | 'cerveja', string>;

const open = async (table: number, customerName: string, cpf: string, phone = '(34) 99999-0000') =>
  (await garcom({ method: 'POST', url: '/api/waiter/comandas', payload: { clientUuid: randomUUID(), tableId: mesa[table], customerName, cpf, phone } })).json().id as string;
const order = (tableId: string, comandaIds: string[]) =>
  garcom({
    method: 'POST',
    url: '/api/waiter/orders',
    payload: { clientUuid: randomUUID(), tableId, comandaIds, items: [{ productId: ids.cerveja, qty: 2 }], createdAtDevice: new Date().toISOString() },
  });
const search = async (name: string): Promise<NameSearchHit[]> => (await caixa({ method: 'POST', url: '/api/cashier/search', payload: { name } })).json();
const transfer = (comandaIds: string[], toTableNumber: number) => caixa({ method: 'POST', url: '/api/cashier/transfer', payload: { comandaIds, toTableNumber } });
const tableOf = async (id: string) => (await ctx.db.select({ t: comandas.tableId }).from(comandas).where(eq(comandas.id, id)))[0]!.t;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  caixa = await ctx.as('caixa');
  garcom = await ctx.as('garcom');
  const cat = (await admin({ method: 'POST', url: '/api/admin/categories', payload: { name: 'Bebidas' } })).json().id;
  ids.cerveja = (await admin({ method: 'POST', url: '/api/admin/products', payload: { categoryId: cat, name: 'Cerveja', priceCents: 1000 } })).json().id;
  const created = (await admin({ method: 'POST', url: '/api/admin/tables/bulk', payload: { from: 1, to: 4 } })).json().created as { id: string; number: number }[];
  for (const t of created) mesa[t.number] = t.id;
  ids.anaSilva = await open(1, 'Ana Silva', '529.982.247-25');
  ids.joao = await open(1, 'João', '111.444.777-35', '(34) 98765-4321');
  ids.anaPaula = await open(2, 'Ana Paula', '935.411.347-80');
  ids.bia = await open(2, 'Bia', '286.255.878-87');
  await order(mesa[1]!, [ids.joao]);
  await order(mesa[1]!, [ids.anaSilva]);
});
afterAll(() => ctx.close());

describe('caixa: busca por nome', () => {
  it('acha por parte do nome, sem acento, e diz a mesa', async () => {
    expect((await search('ana')).map((h) => [h.customerName, h.tableNumber])).toEqual([
      ['Ana Silva', 1],
      ['Ana Paula', 2],
    ]);
    expect((await search('joao')).map((h) => h.customerName)).toEqual(['João']);
    expect(await search('zé')).toEqual([]);
    expect((await caixa({ method: 'POST', url: '/api/cashier/search', payload: { name: 'a' } })).json().message).toBe('Digite ao menos 2 letras do nome');
  });

  it('acha pelo telefone (inteiro ou só o final) sem devolver o número', async () => {
    const byPhone = async (phone: string) => (await caixa({ method: 'POST', url: '/api/cashier/search', payload: { phone } })).json();
    expect((await byPhone('34987654321')).map((h: NameSearchHit) => h.customerName)).toEqual(['João']);
    const hits = await byPhone('87654321');
    expect(hits.map((h: NameSearchHit) => [h.customerName, h.tableNumber])).toEqual([['João', 1]]);
    expect(JSON.stringify(hits)).not.toContain('4321');
    expect(await byPhone('11111111')).toEqual([]);
  });
});

describe('caixa: itens com horário e garçom', () => {
  it('cada item da conta diz quando chegou e quem lançou', async () => {
    const bill: Bill = (await caixa({ method: 'POST', url: '/api/cashier/bill', payload: { comandaIds: [ids.joao] } })).json();
    expect(bill.items[0]).toMatchObject({ productName: 'Cerveja', waiterName: 'garcom' });
    expect(Date.now() - Date.parse(bill.items[0]!.orderedAt)).toBeLessThan(60_000);
  });
});

describe('caixa: transferência', () => {
  it('leva uma comanda para outra mesa, com os itens', async () => {
    const res = await transfer([ids.joao], 3);
    expect(res.json()).toMatchObject({ moved: 1, fromTableNumbers: [1], toTableNumber: 3 });
    expect(await tableOf(ids.joao)).toBe(mesa[3]);
    const tables: CashierTable[] = (await caixa({ method: 'GET', url: '/api/cashier/tables' })).json();
    expect(tables.find((t) => t.number === 3)!.totals.itemsCents).toBe(2000);
    expect(tables.find((t) => t.number === 1)!.comandas.map((c) => c.customerName)).toEqual(['Ana Silva']);
    const [log] = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'TRANSFERENCIA'));
    expect(log!.afterJson).toMatchObject({ mesa: 3, comandas: ['João'] });
  });

  it('pedido que estava na fila do celular com a mesa antiga vai para a mesa nova', async () => {
    const res = await order(mesa[1]!, [ids.joao]);
    expect(res.statusCode).toBe(201);
    const tables: CashierTable[] = (await caixa({ method: 'GET', url: '/api/cashier/tables' })).json();
    expect(tables.find((t) => t.number === 3)!.totals.itemsCents).toBe(4000);
  });

  it('não deixa dois nomes iguais na mesma mesa, nem mesa que não existe', async () => {
    await open(4, 'Bia', '000.000.001-91');
    const clash = await transfer([ids.bia], 4);
    expect(clash.statusCode).toBe(409);
    expect(clash.json().message).toMatch(/Já existe "Bia" aberta na mesa 4/);
    expect((await transfer([ids.bia], 99)).json().message).toBe('Mesa 99 não existe.');
    expect((await transfer([ids.bia], 2)).json().message).toBe('Já está na mesa 2.');
  });

  it('a mesa inteira de uma vez', async () => {
    const res = await transfer([ids.anaPaula, ids.bia], 1);
    expect(res.json()).toMatchObject({ moved: 2, toTableNumber: 1 });
    const tables: CashierTable[] = (await caixa({ method: 'GET', url: '/api/cashier/tables' })).json();
    expect(tables.find((t) => t.number === 2)).toBeUndefined();
    expect(tables.find((t) => t.number === 1)!.comandas.map((c) => c.customerName).sort()).toEqual(['Ana Paula', 'Ana Silva', 'Bia']);
    // Mesas na ordem do número (posição fixa no quadro do caixa).
    expect(tables.map((t) => t.number)).toEqual([...tables.map((t) => t.number)].sort((a, b) => a - b));
  });

  it('garçom não transfere pelo caixa', async () => {
    expect((await garcom({ method: 'POST', url: '/api/cashier/transfer', payload: { comandaIds: [ids.bia], toTableNumber: 3 } })).statusCode).toBe(403);
  });
});

describe('caixa: QR para instalar o app nos celulares', () => {
  it('informa os IPs deste PC na rede (só para o caixa)', async () => {
    const res = await caixa({ method: 'GET', url: '/api/cashier/lan-addresses' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().addresses)).toBe(true);
    expect(res.json().addresses.every((a: string) => /^\d+\.\d+\.\d+\.\d+$/.test(a) && a !== '127.0.0.1')).toBe(true);
    expect((await garcom({ method: 'GET', url: '/api/cashier/lan-addresses' })).statusCode).toBe(403);
  });
});
