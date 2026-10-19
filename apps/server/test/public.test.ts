import { randomUUID } from 'node:crypto';
import { maskName, type PublicComandaOption, type PublicComandaView, type PublicTableInfo } from '@sistema-bar/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPublicApp } from '../src/public-app';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let pub: FastifyInstance;
let admin: Inject;
let garcom: Inject;
let qr: string;
let otherQr: string;
const ids = {} as Record<'mesa' | 'outra' | 'paulo' | 'ana' | 'fechada' | 'cerveja' | 'esgotado', string>;

// CPF do Paulo termina em 725; o da Ana em 735.
const CPF_PAULO = '529.982.247-25';
const CPF_ANA = '111.444.777-35';

const get = (url: string, token?: string) =>
  pub.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
const unlock = (comandaId: string, pin: string, table = qr) =>
  pub.inject({ method: 'POST', url: `/api/public/m/${table}/comandas/${comandaId}/unlock`, payload: { pin } });

beforeAll(async () => {
  ctx = await createTestContext();
  pub = await buildPublicApp({ db: ctx.db, jwtSecret: 'x'.repeat(32), webDist: false });
  admin = await ctx.as('admin');
  garcom = await ctx.as('garcom');
  const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();

  const settings = (await admin({ method: 'GET', url: '/api/admin/settings' })).json();
  await admin({ method: 'PUT', url: '/api/admin/settings', payload: { ...settings, companyName: 'Bar do Teste', guestWifiName: 'Bar-Clientes', serviceFeeEnabled: true } });

  const cat = (await post('/api/admin/categories', { name: 'Bebidas' })).id;
  ids.cerveja = (await post('/api/admin/products', { categoryId: cat, name: 'Cerveja', priceCents: 1000 })).id;
  const esg = await post('/api/admin/products', { categoryId: cat, name: 'Vinho', priceCents: 9000 });
  ids.esgotado = esg.id;
  await admin({ method: 'PUT', url: `/api/admin/products/${esg.id}`, payload: { ...esg, soldOut: true } });

  const tables = (await post('/api/admin/tables/bulk', { from: 1, to: 2 })).created as { id: string; number: number; qrToken: string }[];
  ids.mesa = tables[0]!.id;
  qr = tables[0]!.qrToken;
  ids.outra = tables[1]!.id;
  otherQr = tables[1]!.qrToken;

  const open = async (customerName: string, cpf: string) =>
    (await garcom({ method: 'POST', url: '/api/waiter/comandas', payload: { clientUuid: randomUUID(), tableId: ids.mesa, customerName, cpf } })).json().id as string;
  ids.paulo = await open('Paulo Henrique', CPF_PAULO);
  ids.ana = await open('Ana', CPF_ANA);
  await garcom({
    method: 'POST',
    url: '/api/waiter/orders',
    payload: { clientUuid: randomUUID(), tableId: ids.mesa, comandaIds: [ids.paulo], items: [{ productId: ids.cerveja, qty: 2 }], createdAtDevice: new Date().toISOString() },
  });
});
afterAll(async () => {
  await pub.close();
  await ctx.close();
});

describe('QR da mesa (servidor do cliente)', () => {
  it('nomes mascarados: 3 letras e a inicial do sobrenome', () => {
    expect(maskName('Paulo Henrique')).toBe('Pau*** H.');
    expect(maskName('ana')).toBe('ana***');
    expect(maskName('  João  da Silva ')).toBe('Joã*** S.');
  });

  it('abre o cardápio sem login, sem os esgotados', async () => {
    const res = await get(`/api/public/m/${qr}`);
    expect(res.statusCode).toBe(200);
    const info: PublicTableInfo = res.json();
    expect(info).toMatchObject({ tableNumber: 1, companyName: 'Bar do Teste', guestWifiName: 'Bar-Clientes' });
    const names = info.menu.flatMap((c) => c.products.map((p) => p.name));
    expect(names).toContain('Cerveja');
    expect(names).not.toContain('Vinho');
  });

  it('QR desconhecido não revela nada', async () => {
    const res = await get('/api/public/m/naoexiste123');
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/QR Code não reconhecido/);
  });

  it('lista só as comandas abertas desta mesa, com nome mascarado e sem CPF', async () => {
    const list: PublicComandaOption[] = (await get(`/api/public/m/${qr}/comandas`)).json();
    expect(list.map((c) => c.maskedName)).toEqual(['Pau*** H.', 'Ana***']);
    expect(JSON.stringify(list)).not.toMatch(/Henrique|725|cpf/i);
    expect((await get(`/api/public/m/${otherQr}/comandas`)).json()).toEqual([]);
  });

  it('com os 3 últimos números do CPF vê a própria comanda (itens, taxa, total); sem o token, não', async () => {
    expect((await get(`/api/public/m/${qr}/comandas/${ids.paulo}`)).statusCode).toBe(401);
    const res = await unlock(ids.paulo, '725');
    expect(res.statusCode).toBe(200);
    const { token } = res.json();
    const view: PublicComandaView = (await get(`/api/public/m/${qr}/comandas/${ids.paulo}`, token)).json();
    expect(view.customerName).toBe('Paulo Henrique');
    expect(view.items).toMatchObject([{ name: 'Cerveja', qty: 2, amountCents: 2000 }]);
    expect(view.totals).toMatchObject({ itemsCents: 2000, serviceFeeCents: 200, totalCents: 2200, remainingCents: 2200 });

    // O token vale só para essa comanda e só pelo QR da mesa dela.
    expect((await get(`/api/public/m/${qr}/comandas/${ids.ana}`, token)).statusCode).toBe(401);
    expect((await get(`/api/public/m/${otherQr}/comandas/${ids.paulo}`, token)).statusCode).toBe(410);
    // E não serve para a API interna.
    const staff = await ctx.app.inject({ method: 'GET', url: '/api/waiter/menu', headers: { authorization: `Bearer ${token}` } });
    expect(staff.statusCode).toBe(401);
  });

  it('PIN errado conta as tentativas; na 5ª a consulta bloqueia até o garçom liberar', async () => {
    expect((await unlock(ids.ana, '12')).json().message).toBe('Digite os 3 últimos números do CPF.');
    const first = await unlock(ids.ana, '000');
    expect(first.statusCode).toBe(401);
    expect(first.json().message).toBe('Números não conferem. Restam 4 tentativas.');
    for (const pin of ['001', '002']) await unlock(ids.ana, pin);
    expect((await unlock(ids.ana, '003')).json().message).toMatch(/Resta 1 tentativa/);
    const fifth = await unlock(ids.ana, '004');
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json().error).toBe('QR_LOCKED');
    // Bloqueada: nem o PIN certo entra; a lista mostra o cadeado.
    expect((await unlock(ids.ana, '735')).statusCode).toBe(423);
    const list: PublicComandaOption[] = (await get(`/api/public/m/${qr}/comandas`)).json();
    expect(list.find((c) => c.id === ids.ana)!.locked).toBe(true);

    // O garçom vê o bloqueio e libera; o cliente entra com o PIN certo.
    expect((await garcom({ method: 'GET', url: `/api/waiter/comandas/${ids.ana}` })).json().qrLocked).toBe(true);
    expect((await garcom({ method: 'POST', url: `/api/waiter/comandas/${ids.ana}/qr-release` })).statusCode).toBe(200);
    expect((await garcom({ method: 'GET', url: `/api/waiter/comandas/${ids.ana}` })).json().qrLocked).toBe(false);
    expect((await unlock(ids.ana, '735')).statusCode).toBe(200);
  });

  it('o servidor do cliente não tem login, caixa nem administração', async () => {
    for (const url of ['/api/auth/login', '/api/admin/settings', '/api/waiter/menu', '/api/cashier/tables', '/api/health']) {
      const res = await pub.inject({ method: url.endsWith('login') ? 'POST' : 'GET', url, payload: url.endsWith('login') ? {} : undefined });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('o admin recebe a porta e os endereços sugeridos para imprimir o QR', async () => {
    const info = (await admin({ method: 'GET', url: '/api/admin/tables/qr-info' })).json();
    expect(info).toEqual({ publicPort: null, suggestedBaseUrls: [] });
  });
});
