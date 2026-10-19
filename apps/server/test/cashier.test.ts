import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comandas, printJobs } from '../src/db/schema';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let garcom: Inject;
let caixa: Inject;
let gerente: Inject;

type Key = 'caixaPrinter' | 'heineken' | 'pizza' | 'mesa10' | 'mesa11' | 'paulo' | 'ana' | 'bia' | 'carla';
const ids = {} as Record<Key, string>;
const CPF = { paulo: '529.982.247-25', ana: '111.444.777-35', bia: '935.411.347-80', carla: '286.255.878-87' };
const PIN = '4321';

const bill = async (...comandaIds: string[]) =>
  (await caixa({ method: 'POST', url: '/api/cashier/bill', payload: { comandaIds } })).json();

const pay = (payload: Record<string, unknown>, as: Inject = caixa) =>
  as({ method: 'POST', url: '/api/cashier/payments', payload: { clientUuid: randomUUID(), payerName: 'Cliente', ...payload } });

const order = (tableId: string, comandaIds: string[], items: { productId: string; qty: number }[]) =>
  garcom({
    method: 'POST',
    url: '/api/waiter/orders',
    payload: { clientUuid: randomUUID(), tableId, comandaIds, items, createdAtDevice: new Date().toISOString() },
  });

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  garcom = await ctx.as('garcom');
  caixa = await ctx.as('caixa');
  gerente = await ctx.as('gerente');
  const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();

  // Gerente com PIN para autorizar no caixa.
  const users = (await admin({ method: 'GET', url: '/api/admin/users' })).json();
  const g = users.find((u: { login: string }) => u.login === 'gerente');
  await admin({ method: 'PUT', url: `/api/admin/users/${g.id}`, payload: { ...g, pin: PIN } });

  ids.caixaPrinter = (await post('/api/admin/printers', { name: 'Caixa', windowsName: 'ELGIN CAIXA', sectorLabel: 'CAIXA' })).id;
  const settings = (await admin({ method: 'GET', url: '/api/admin/settings' })).json();
  await admin({
    method: 'PUT',
    url: '/api/admin/settings',
    payload: { ...settings, serviceFeeEnabled: true, cashierPrinterId: ids.caixaPrinter, companyName: 'Bar do Teste' },
  });

  const cat = (await post('/api/admin/categories', { name: 'Tudo' })).id;
  ids.heineken = (await post('/api/admin/products', { categoryId: cat, name: 'Heineken', priceCents: 2000 })).id;
  ids.pizza = (await post('/api/admin/products', { categoryId: cat, name: 'Pizza', priceCents: 5000 })).id;
  const tables = (await post('/api/admin/tables/bulk', { from: 10, to: 12 })).created as { id: string; number: number }[];
  ids.mesa10 = tables.find((t) => t.number === 10)!.id;
  ids.mesa11 = tables.find((t) => t.number === 11)!.id;

  const open = async (tableId: string, customerName: string, cpf: string) =>
    (await garcom({ method: 'POST', url: '/api/waiter/comandas', payload: { clientUuid: randomUUID(), tableId, customerName, cpf } })).json().id;
  ids.paulo = await open(ids.mesa10, 'Paulo', CPF.paulo);
  ids.ana = await open(ids.mesa10, 'Ana', CPF.ana);
  ids.bia = await open(ids.mesa10, 'Bia', CPF.bia);
  ids.carla = await open(ids.mesa11, 'Carla', CPF.carla);

  await order(ids.mesa10, [ids.paulo], [{ productId: ids.heineken, qty: 2 }, { productId: ids.pizza, qty: 1 }]); // 90,00
  await order(ids.mesa10, [ids.ana], [{ productId: ids.heineken, qty: 1 }]); // 20,00
  await order(ids.mesa10, [ids.bia], [{ productId: ids.heineken, qty: 3 }]); // 60,00
  await order(ids.mesa11, [ids.carla], [{ productId: ids.heineken, qty: 1 }]);
});
afterAll(() => ctx.close());

describe('sessão de caixa', () => {
  it('não recebe sem caixa aberto; abre com fundo de troco; só um aberto por vez', async () => {
    const early = await pay({ comandaIds: [ids.ana], method: 'PIX', amountCents: 100 });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe('NO_OPEN_SESSION');

    const open = await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { openingFloatCents: 10_000 } });
    expect(open.statusCode).toBe(201);
    expect(open.json().session).toMatchObject({ openingFloatCents: 10_000, expectedCashCents: 10_000, openedBy: 'caixa' });
    const again = await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { openingFloatCents: 0 } });
    expect(again.json().error).toBe('SESSION_ALREADY_OPEN');
  });

  it('garçom não acessa o caixa', async () => {
    expect((await garcom({ method: 'GET', url: '/api/cashier/session' })).statusCode).toBe(403);
  });
});

describe('busca por mesa ou CPF', () => {
  it('pela mesa lista os nomes; pelo CPF encontra a pessoa e diz a mesa', async () => {
    const byTable = (await caixa({ method: 'POST', url: '/api/cashier/lookup', payload: { tableNumber: 10 } })).json();
    expect(byTable.table.comandas.map((c: { customerName: string }) => c.customerName)).toEqual(['Paulo', 'Ana', 'Bia']);
    expect(byTable.matchedComandaId).toBeNull();

    const byCpf = (await caixa({ method: 'POST', url: '/api/cashier/lookup', payload: { cpf: '28625587887' } })).json();
    expect(byCpf.table.number).toBe(11);
    expect(byCpf.matchedComandaId).toBe(ids.carla);
  });

  it('CPF sem comanda aberta, CPF inválido e mesa vazia dão mensagens claras', async () => {
    const none = await caixa({ method: 'POST', url: '/api/cashier/lookup', payload: { cpf: '714.602.380-01' } });
    expect(none.statusCode).toBe(404);
    expect(none.json().message).toBe('Nenhuma comanda aberta com este CPF.');
    expect((await caixa({ method: 'POST', url: '/api/cashier/lookup', payload: { cpf: '123' } })).statusCode).toBe(400);
    const empty = await caixa({ method: 'POST', url: '/api/cashier/lookup', payload: { tableNumber: 12 } });
    expect(empty.json().message).toBe('A mesa 12 não tem comandas abertas.');
  });
});

describe('conta e ajustes', () => {
  it('conta da mesa: itens + 10% de taxa', async () => {
    const b = await bill(ids.paulo, ids.ana, ids.bia);
    expect(b.totals).toMatchObject({ itemsCents: 17_000, serviceFeeCents: 1_700, totalCents: 18_700, remainingCents: 18_700 });
    expect(b.comandas[0].totals).toMatchObject({ itemsCents: 9_000, serviceFeeCents: 900, totalCents: 9_900 });
  });

  it('desconto pelo caixa exige PIN de gerente; fica registrado quem autorizou', async () => {
    const payload = { comandaId: ids.bia, type: 'DESCONTO', amountCents: 600, reason: 'Cliente frequente' };
    const noPin = await caixa({ method: 'POST', url: '/api/cashier/adjustments', payload });
    expect(noPin.json().error).toBe('PIN_REQUIRED');
    const wrong = await caixa({ method: 'POST', url: '/api/cashier/adjustments', payload: { ...payload, authorizerPin: '0000' } });
    expect(wrong.json().error).toBe('PIN_INVALID');
    const ok = await caixa({ method: 'POST', url: '/api/cashier/adjustments', payload: { ...payload, authorizerPin: PIN } });
    expect(ok.statusCode).toBe(201);

    const b = await bill(ids.bia);
    expect(b.totals).toMatchObject({ itemsCents: 6_000, serviceFeeCents: 600, discountCents: 600, totalCents: 6_000 });
    expect(b.adjustments[0]).toMatchObject({ type: 'DESCONTO', reason: 'Cliente frequente', userName: 'caixa', authorizedBy: 'gerente' });
  });

  it('gerente logado retira a taxa sem PIN; não dá para retirar duas vezes', async () => {
    const payload = { comandaId: ids.ana, type: 'TAXA_SERVICO_REMOVIDA', reason: 'Cliente pediu' };
    expect((await gerente({ method: 'POST', url: '/api/cashier/adjustments', payload })).statusCode).toBe(201);
    expect((await gerente({ method: 'POST', url: '/api/cashier/adjustments', payload })).statusCode).toBe(409);
    expect((await bill(ids.ana)).totals).toMatchObject({ serviceFeeCents: 0, totalCents: 2_000 });
  });

  it('pré-conta sai na impressora do caixa com "não é documento fiscal"', async () => {
    const res = await caixa({ method: 'POST', url: '/api/cashier/bill/print', payload: { comandaIds: [ids.paulo, ids.ana, ids.bia] } });
    expect(res.statusCode).toBe(200);
    await ctx.app.printWorker.runOnce();
    const preconta = ctx.printed.find((p) => p.printer === 'Caixa' && p.preview.includes('CONFERÊNCIA DE CONTA'))!;
    expect(preconta.preview).toContain('Bar do Teste');
    expect(preconta.preview).toContain('NÃO É DOCUMENTO FISCAL');
    expect(preconta.preview).toContain('Taxa de serviço (10%)');
  });
});

describe('pagamentos', () => {
  it('pagamento parcial abate o restante e a comanda continua aberta', async () => {
    const res = await pay({ comandaIds: [ids.paulo], method: 'PIX', amountCents: 1_000, payerName: 'Paulo' });
    expect(res.statusCode).toBe(201);
    expect(res.json().closedComandaIds).toEqual([]);
    const b = await bill(ids.paulo);
    expect(b.totals).toMatchObject({ paidCents: 1_000, remainingCents: 8_900 });
    expect(b.payments[0]).toMatchObject({ payerName: 'Paulo', method: 'PIX', amountCents: 1_000 });
  });

  it('valor maior que o restante é recusado (para dinheiro, informe o entregue)', async () => {
    const res = await pay({ comandaIds: [ids.ana], method: 'CREDITO', amountCents: 999_999 });
    expect(res.json().error).toBe('OVERPAYMENT');
  });

  it('um pagamento em dinheiro quita duas comandas, calcula o troco, fecha e imprime o cupom com gaveta', async () => {
    ctx.printed.length = 0;
    // Ana 20,00 (sem taxa) + Bia 60,00 = 80,00; cliente entrega 100,00.
    const res = await pay({ comandaIds: [ids.ana, ids.bia], method: 'DINHEIRO', amountCents: 8_000, tenderedCents: 10_000, payerName: 'Ana' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ changeCents: 2_000 });
    expect(res.json().closedComandaIds.sort()).toEqual([ids.ana, ids.bia].sort());

    const [ana] = await ctx.db.select().from(comandas).where(eq(comandas.id, ids.ana));
    expect(ana).toMatchObject({ status: 'FECHADA', finalTotals: { totalCents: 2_000, remainingCents: 0 } });

    await ctx.app.printWorker.runOnce();
    const cupom = ctx.printed.find((p) => p.preview.includes('CUPOM DE CONSUMO'))!;
    expect(cupom.preview).toContain('Troco');
    expect(Buffer.from(cupom.bytes).includes(Buffer.from([0x1b, 0x70, 0x00]))).toBe(true); // abre a gaveta
  });

  it('dinheiro entregue menor que o valor é recusado', async () => {
    const res = await pay({ comandaIds: [ids.paulo], method: 'DINHEIRO', amountCents: 1_000, tenderedCents: 500 });
    expect(res.json().error).toBe('INSUFFICIENT_CASH');
  });

  it('pagamento por fração: 1/3 da pizza (+10%) três vezes fecha o item; a quarta é recusada', async () => {
    const b = await bill(ids.paulo);
    const pizza = b.items.find((i: { productName: string }) => i.productName === 'Pizza');
    const third = { orderItemId: pizza.orderItemId, comandaId: ids.paulo, num: 1, den: 3 };

    const wrong = await pay({ comandaIds: [ids.paulo], method: 'DEBITO', amountCents: 1_000, items: [third] });
    expect(wrong.json().error).toBe('AMOUNT_CHANGED');

    // 1/3 de 50,00 = 16,67 + 10% = 1,67 → 18,34
    for (const amount of [1_834, 1_834]) {
      expect((await pay({ comandaIds: [ids.paulo], method: 'DEBITO', amountCents: amount, items: [third] })).statusCode).toBe(201);
    }
    // Último terço fecha os centavos: 16,66 + 1,67 = 18,33
    expect((await pay({ comandaIds: [ids.paulo], method: 'DEBITO', amountCents: 1_833, items: [third] })).statusCode).toBe(201);
    const after = (await bill(ids.paulo)).items.find((i: { productName: string }) => i.productName === 'Pizza');
    expect(after).toMatchObject({ paidCents: 5_000, paidFraction: { num: 1, den: 1 } });

    const extra = await pay({ comandaIds: [ids.paulo], method: 'DEBITO', amountCents: 1_833, items: [third] });
    expect(extra.json().error).toBe('ITEM_OVERPAID');
  });

  it('clique duplo não cobra duas vezes', async () => {
    const clientUuid = randomUUID();
    const a = await pay({ clientUuid, comandaIds: [ids.paulo], method: 'PIX', amountCents: 100 });
    const b = await pay({ clientUuid, comandaIds: [ids.paulo], method: 'PIX', amountCents: 100 });
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json().duplicate).toBe(true);
    expect((await bill(ids.paulo)).payments.filter((p: { amountCents: number }) => p.amountCents === 100)).toHaveLength(1);
  });

  it('quitando a última comanda a mesa fica livre no mapa do garçom', async () => {
    const remaining = (await bill(ids.paulo)).totals.remainingCents;
    const res = await pay({ comandaIds: [ids.paulo], method: 'CREDITO', amountCents: remaining });
    expect(res.json().closedComandaIds).toEqual([ids.paulo]);
    const map = (await garcom({ method: 'GET', url: '/api/waiter/tables' })).json();
    expect(map.tables.find((t: { number: number }) => t.number === 10).status).toBe('LIVRE');
    // Comanda fechada não aceita mais pedido.
    expect((await order(ids.mesa10, [ids.paulo], [{ productId: ids.heineken, qty: 1 }])).json().error).toBe('COMANDA_NOT_OPEN');
  });
});

describe('estorno', () => {
  it('exige gerente; reabre as comandas que o pagamento tinha fechado', async () => {
    const b = await bill(ids.ana, ids.bia);
    const cash = b.payments.find((p: { method: string }) => p.method === 'DINHEIRO');

    const noPin = await caixa({ method: 'POST', url: `/api/cashier/payments/${cash.id}/refund`, payload: { reason: 'Cobrado errado' } });
    expect(noPin.json().error).toBe('PIN_REQUIRED');
    const ok = await caixa({
      method: 'POST',
      url: `/api/cashier/payments/${cash.id}/refund`,
      payload: { reason: 'Cobrado errado', authorizerPin: PIN },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().reopenedComandaIds.sort()).toEqual([ids.ana, ids.bia].sort());

    const after = await bill(ids.ana, ids.bia);
    expect(after.totals.remainingCents).toBe(8_000);
    expect(after.payments.find((p: { id: string }) => p.id === cash.id).status).toBe('ESTORNADO');
    const again = await gerente({ method: 'POST', url: `/api/cashier/payments/${cash.id}/refund`, payload: { reason: 'De novo' } });
    expect(again.json().error).toBe('ALREADY_REFUNDED');
  });
});

describe('sangria, suprimento e fechamento', () => {
  it('sangria maior que o dinheiro da gaveta é recusada; movimentos entram no esperado', async () => {
    const summary = (await caixa({ method: 'GET', url: '/api/cashier/session' })).json().session;
    // Fundo 100,00; o pagamento em dinheiro foi estornado.
    expect(summary.expectedCashCents).toBe(10_000);

    const big = await caixa({ method: 'POST', url: '/api/cashier/session/movements', payload: { type: 'SANGRIA', amountCents: 50_000, reason: 'Depósito' } });
    expect(big.statusCode).toBe(409);
    await caixa({ method: 'POST', url: '/api/cashier/session/movements', payload: { type: 'SUPRIMENTO', amountCents: 5_000, reason: 'Troco extra' } });
    const s = await caixa({ method: 'POST', url: '/api/cashier/session/movements', payload: { type: 'SANGRIA', amountCents: 3_000, reason: 'Depósito no banco' } });
    expect(s.json().session.expectedCashCents).toBe(12_000);
    expect(s.json().printed).toBe(true);
  });

  it('fechamento avisa comandas abertas, calcula a diferença e imprime o relatório', async () => {
    const preview = (await caixa({ method: 'GET', url: '/api/cashier/session/close-preview' })).json();
    expect(preview.openComandas).toBe(3); // Carla, Ana e Bia (reabertas)
    expect(preview.expected).toMatchObject({ DINHEIRO: 12_000, CREDITO: expect.any(Number), PIX: 1_100 });

    const blocked = await caixa({ method: 'POST', url: '/api/cashier/session/close', payload: { counted: { DINHEIRO: 11_500 } } });
    expect(blocked.json().error).toBe('OPEN_COMANDAS');

    ctx.printed.length = 0;
    const closed = await caixa({
      method: 'POST',
      url: '/api/cashier/session/close',
      payload: { counted: { DINHEIRO: 11_500, PIX: 1_100 }, confirmOpenComandas: true, notes: 'Faltou troco' },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ differenceCents: -500, differenceByMethod: { DINHEIRO: -500, PIX: 0 }, printed: true });

    await ctx.app.printWorker.runOnce();
    const report = ctx.printed.find((p) => p.preview.includes('FECHAMENTO DE CAIXA'))!;
    expect(report.preview).toContain('FALTA');
    expect(report.preview).toContain('Obs.: Faltou troco');

    expect((await caixa({ method: 'GET', url: '/api/cashier/session' })).json().session).toBeNull();
    expect((await pay({ comandaIds: [ids.carla], method: 'PIX', amountCents: 100 })).json().error).toBe('NO_OPEN_SESSION');
  });

  it('cada comprovante do caixa foi para a impressora do caixa', async () => {
    const jobs = await ctx.db.select().from(printJobs).where(and(eq(printJobs.printerId, ids.caixaPrinter), eq(printJobs.type, 'CAIXA')));
    expect(jobs.length).toBeGreaterThanOrEqual(4); // abertura, suprimento, sangria, fechamento
  });
});
