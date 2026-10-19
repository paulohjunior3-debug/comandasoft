import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDate, type SalesReport } from '@sistema-bar/shared';
import { cashSessions, comandas, fiscalRequests, payments, printJobs } from '../src/db/schema';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let garcom: Inject;
let caixa: Inject;
let gerente: Inject;

type Key = 'caixaPrinter' | 'carlos' | 'paulo' | 'heineken' | 'pizza' | 'file' | 'agua' | 'mesa10' | 'mesa11' | 'joao' | 'ana' | 'bia' | 'carla';
const ids = {} as Record<Key, string>;
const CPF = { joao: '529.982.247-25', ana: '111.444.777-35', bia: '935.411.347-80', carla: '286.255.878-87' };
const PIN = '4321';

const bill = async (...comandaIds: string[]) =>
  (await caixa({ method: 'POST', url: '/api/cashier/bill', payload: { comandaIds } })).json();

const pay = (payload: Record<string, unknown>, as: Inject = caixa) =>
  as({
    method: 'POST',
    url: '/api/cashier/payments',
    payload: { clientUuid: randomUUID(), registerId: ids.carlos, payerName: 'Cliente', ...payload },
  });

const order = (tableId: string, comandaIds: string[], items: { productId: string; qty: number }[]) =>
  garcom({
    method: 'POST',
    url: '/api/waiter/orders',
    payload: { clientUuid: randomUUID(), tableId, comandaIds, items, createdAtDevice: new Date().toISOString() },
  });

const openComanda = async (tableId: string, customerName: string, cpf: string, peopleCount = 1) =>
  (
    await garcom({
      method: 'POST',
      url: '/api/waiter/comandas',
      payload: { clientUuid: randomUUID(), tableId, customerName, cpf, peopleCount },
    })
  ).json().id as string;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  garcom = await ctx.as('garcom');
  caixa = await ctx.as('caixa');
  gerente = await ctx.as('gerente');
  const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();

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

  // Dois caixas: Carlos pergunta o que fazer ao quitar; Paulo pede o fiscal automaticamente.
  ids.carlos = (await post('/api/admin/registers', { name: 'Caixa Carlos' })).id;
  ids.paulo = (await post('/api/admin/registers', { name: 'Caixa Paulo', fiscalMode: 'AUTOMATICO' })).id;

  const cat = (await post('/api/admin/categories', { name: 'Tudo' })).id;
  ids.heineken = (await post('/api/admin/products', { categoryId: cat, name: 'Heineken', priceCents: 2000 })).id;
  ids.pizza = (await post('/api/admin/products', { categoryId: cat, name: 'Pizza', priceCents: 5000 })).id;
  ids.file = (await post('/api/admin/products', { categoryId: cat, name: 'Filé', priceCents: 10_000 })).id;
  ids.agua = (await post('/api/admin/products', { categoryId: cat, name: 'Água', priceCents: 500 })).id;
  const tables = (await post('/api/admin/tables/bulk', { from: 10, to: 14 })).created as { id: string; number: number }[];
  ids.mesa10 = tables.find((t) => t.number === 10)!.id;
  ids.mesa11 = tables.find((t) => t.number === 11)!.id;

  ids.joao = await openComanda(ids.mesa10, 'João', CPF.joao);
  ids.ana = await openComanda(ids.mesa10, 'Ana', CPF.ana);
  ids.bia = await openComanda(ids.mesa10, 'Bia', CPF.bia);
  ids.carla = await openComanda(ids.mesa11, 'Carla', CPF.carla);

  await order(ids.mesa10, [ids.joao], [{ productId: ids.heineken, qty: 2 }, { productId: ids.pizza, qty: 1 }]); // 90,00
  await order(ids.mesa10, [ids.ana], [{ productId: ids.heineken, qty: 1 }]); // 20,00
  await order(ids.mesa10, [ids.bia], [{ productId: ids.heineken, qty: 3 }]); // 60,00
  await order(ids.mesa11, [ids.carla], [{ productId: ids.heineken, qty: 1 }]);
});
afterAll(() => ctx.close());

describe('abertura do caixa (regras do dia)', () => {
  it('não recebe sem o caixa aberto', async () => {
    const res = await pay({ comandaIds: [ids.ana], method: 'PIX', amountCents: 100 });
    expect(res.json().error).toBe('NO_OPEN_SESSION');
  });

  it('app de versão antiga (sem o caixa) recebe mensagem em português pedindo para recarregar', async () => {
    const res = await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { openingFloatCents: 0 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Faltou um dado obrigatório \(registerId\).*recarregue a página/);
    expect(res.headers['x-sistema-bar-versao']).toBeTruthy();
    const wrong = await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: ids.carlos, openingFloatCents: 'abc' } });
    expect(wrong.json().message).not.toMatch(/expected|received|Invalid/);
    const broken = await caixa({ method: 'POST', url: '/api/cashier/session/open', headers: { 'content-type': 'application/json' }, payload: '{' });
    expect(broken.json().message).toBe('Os dados enviados estão em formato inválido.');
  });

  it('o primeiro caixa define turno (passando da meia-noite), mesas e couvert', async () => {
    const res = await caixa({
      method: 'POST',
      url: '/api/cashier/session/open',
      payload: {
        registerId: ids.carlos,
        openingFloatCents: 10_000,
        expectedCloseTime: '01:00',
        tablesInService: 3,
        couvert: { amountCents: 1_500, startTime: '14:00' },
      },
    });
    expect(res.statusCode).toBe(201);
    const { session, rules } = res.json();
    expect(session).toMatchObject({ registerName: 'Caixa Carlos', openingFloatCents: 10_000, expectedCashCents: 10_000 });
    expect(new Date(session.expectedCloseAt).getTime()).toBeGreaterThan(Date.now()); // 01:00 é no futuro
    expect(rules).toMatchObject({ registerName: 'Caixa Carlos', tablesInService: 3, couvertCents: 1_500 });

    const again = await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: ids.carlos, openingFloatCents: 0 } });
    expect(again.json().error).toBe('SESSION_ALREADY_OPEN');
  });

  it('o segundo caixa abre ao mesmo tempo e segue as regras já definidas', async () => {
    const res = await gerente({
      method: 'POST',
      url: '/api/cashier/session/open',
      payload: { registerId: ids.paulo, openingFloatCents: 5_000, tablesInService: 99, couvert: null },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().rules).toMatchObject({ registerName: 'Caixa Carlos', tablesInService: 3, couvertCents: 1_500 });
    const registers = (await caixa({ method: 'GET', url: '/api/cashier/session/registers' })).json();
    expect(registers.map((r: { name: string; openSession: unknown }) => [r.name, r.openSession !== null])).toEqual([
      ['Caixa Carlos', true],
      ['Caixa Paulo', true],
    ]);
  });

  it('o garçom vê só as mesas do dia, mais as que têm comanda aberta', async () => {
    const map = (await garcom({ method: 'GET', url: '/api/waiter/tables' })).json();
    expect(map.tables.map((t: { number: number }) => t.number)).toEqual([10, 11, 12]);
  });

  it('garçom não acessa o caixa', async () => {
    expect((await garcom({ method: 'GET', url: `/api/cashier/session?registerId=${ids.carlos}` })).statusCode).toBe(403);
  });
});

describe('couvert do dia', () => {
  // Couvert desde agora − 1 h, para os testes não dependerem do relógio.
  const setCouvertStart = (date: Date) => ctx.db.update(cashSessions).set({ couvertStartAt: date }).where(eq(cashSessions.registerId, ids.carlos));
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  it('comanda aberta depois do início já nasce com couvert, multiplicado pelas pessoas', async () => {
    await setCouvertStart(hoursAgo(1));
    const casal = await openComanda(ids.mesa11, 'Casal', '714.602.380-01', 2);
    const d = (await garcom({ method: 'GET', url: `/api/waiter/comandas/${casal}` })).json();
    expect(d).toMatchObject({ peopleCount: 2, couvertCents: 3_000, totalWithFeeCents: 3_000 });
  });

  it('quem chegou antes paga só se continuar na mesa depois de início + 15 min', async () => {
    // Carla abriu "há 2 h"; o couvert começou há 10 min: ainda na tolerância.
    await ctx.db.update(comandas).set({ openedAt: hoursAgo(2) }).where(eq(comandas.id, ids.carla));
    await setCouvertStart(minutesAgo(10));
    expect((await bill(ids.carla)).totals.couvertCents).toBe(0);
    // Começou há 16 min: passou da tolerância.
    await setCouvertStart(minutesAgo(16));
    expect((await bill(ids.carla)).totals.couvertCents).toBe(1_500);
  });

  it('para os demais testes, comandas da mesa 10 ficam sem couvert (abertas antes, dentro da tolerância)', async () => {
    await ctx.db.update(comandas).set({ openedAt: hoursAgo(3) }).where(eq(comandas.tableId, ids.mesa10));
    await setCouvertStart(minutesAgo(5));
    expect((await bill(ids.joao, ids.ana, ids.bia)).totals.couvertCents).toBe(0);
  });
});

describe('busca por mesa ou CPF', () => {
  it('pela mesa lista os nomes; pelo CPF encontra a pessoa e diz a mesa', async () => {
    const byTable = (await caixa({ method: 'POST', url: '/api/cashier/lookup', payload: { tableNumber: 10 } })).json();
    expect(byTable.table.comandas.map((c: { customerName: string }) => c.customerName)).toEqual(['João', 'Ana', 'Bia']);
    const byCpf = (await caixa({ method: 'POST', url: '/api/cashier/lookup', payload: { cpf: '28625587887' } })).json();
    expect(byCpf.table.number).toBe(11);
    expect(byCpf.matchedComandaId).toBe(ids.carla);
  });

  it('CPF sem comanda aberta, CPF inválido e mesa vazia dão mensagens claras', async () => {
    const none = await caixa({ method: 'POST', url: '/api/cashier/lookup', payload: { cpf: '390.533.447-05' } });
    expect(none.json().message).toBe('Nenhuma comanda aberta com este CPF.');
    expect((await caixa({ method: 'POST', url: '/api/cashier/lookup', payload: { cpf: '123' } })).statusCode).toBe(400);
    const empty = await caixa({ method: 'POST', url: '/api/cashier/lookup', payload: { tableNumber: 12 } });
    expect(empty.json().message).toBe('A mesa 12 não tem comandas abertas.');
  });
});

describe('conta e ajustes', () => {
  it('conta da mesa: itens + 10% de taxa', async () => {
    const b = await bill(ids.joao, ids.ana, ids.bia);
    expect(b.totals).toMatchObject({ itemsCents: 17_000, serviceFeeCents: 1_700, totalCents: 18_700 });
  });

  it('desconto pelo caixa exige PIN de gerente; fica registrado quem autorizou', async () => {
    const payload = { comandaId: ids.bia, type: 'DESCONTO', amountCents: 600, reason: 'Cliente frequente' };
    expect((await caixa({ method: 'POST', url: '/api/cashier/adjustments', payload })).json().error).toBe('PIN_REQUIRED');
    expect((await caixa({ method: 'POST', url: '/api/cashier/adjustments', payload: { ...payload, authorizerPin: '0000' } })).json().error).toBe('PIN_INVALID');
    expect((await caixa({ method: 'POST', url: '/api/cashier/adjustments', payload: { ...payload, authorizerPin: PIN } })).statusCode).toBe(201);
    const b = await bill(ids.bia);
    expect(b.totals).toMatchObject({ itemsCents: 6_000, serviceFeeCents: 600, discountCents: 600, totalCents: 6_000 });
    expect(b.adjustments[0]).toMatchObject({ userName: 'caixa', authorizedBy: 'gerente' });
  });

  it('gerente logado retira a taxa sem PIN; não dá para retirar duas vezes', async () => {
    const payload = { comandaId: ids.ana, type: 'TAXA_SERVICO_REMOVIDA', reason: 'Cliente pediu' };
    expect((await gerente({ method: 'POST', url: '/api/cashier/adjustments', payload })).statusCode).toBe(201);
    expect((await gerente({ method: 'POST', url: '/api/cashier/adjustments', payload })).statusCode).toBe(409);
    expect((await bill(ids.ana)).totals).toMatchObject({ serviceFeeCents: 0, totalCents: 2_000 });
  });

  it('pré-conta sai na impressora do caixa com "não é documento fiscal"', async () => {
    const res = await caixa({ method: 'POST', url: '/api/cashier/bill/print', payload: { comandaIds: [ids.joao], registerId: ids.carlos } });
    expect(res.statusCode).toBe(200);
    await ctx.app.printWorker.runOnce();
    const preconta = ctx.printed.find((p) => p.preview.includes('CONFERÊNCIA DE CONTA'))!;
    expect(preconta.preview).toContain('NÃO É DOCUMENTO FISCAL');
    expect(preconta.preview).toContain('Caixa Carlos');
  });
});

describe('pagamentos', () => {
  it('pagamento parcial abate o restante e a comanda continua aberta', async () => {
    const res = await pay({ comandaIds: [ids.joao], method: 'PIX', amountCents: 1_000, payerName: 'João' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ closedComandaIds: [], fiscalMode: 'PERGUNTAR', fiscalRequested: false });
    expect((await bill(ids.joao)).totals).toMatchObject({ paidCents: 1_000, remainingCents: 8_900 });
  });

  it('valor maior que o restante é recusado', async () => {
    expect((await pay({ comandaIds: [ids.ana], method: 'CREDITO', amountCents: 999_999 })).json().error).toBe('OVERPAYMENT');
  });

  it('dinheiro quita duas comandas, calcula troco, abre a gaveta e NÃO imprime cupom sozinho', async () => {
    ctx.printed.length = 0;
    const res = await pay({ comandaIds: [ids.ana, ids.bia], method: 'DINHEIRO', amountCents: 8_000, tenderedCents: 10_000, payerName: 'Ana' });
    expect(res.json()).toMatchObject({ changeCents: 2_000, fiscalMode: 'PERGUNTAR', fiscalRequested: false });
    expect(res.json().closedComandaIds.sort()).toEqual([ids.ana, ids.bia].sort());
    await ctx.app.printWorker.runOnce();
    expect(ctx.printed.some((p) => p.preview.includes('CUPOM DE CONSUMO'))).toBe(false);
    expect(ctx.printed.some((p) => Buffer.from(p.bytes).includes(Buffer.from([0x1b, 0x70, 0x00])))).toBe(true); // gaveta
  });

  it('finalização: o caixa escolhe imprimir o cupom não fiscal e/ou pedir o cupom fiscal', async () => {
    ctx.printed.length = 0;
    const receipt = await caixa({ method: 'POST', url: '/api/cashier/receipts', payload: { registerId: ids.carlos, comandaIds: [ids.ana, ids.bia] } });
    expect(receipt.statusCode).toBe(200);
    await ctx.app.printWorker.runOnce();
    const cupom = ctx.printed.find((p) => p.preview.includes('CUPOM DE CONSUMO'))!;
    expect(cupom.preview).toContain('Troco');

    const fiscal = await caixa({ method: 'POST', url: '/api/cashier/fiscal-requests', payload: { registerId: ids.carlos, comandaIds: [ids.ana] } });
    expect(fiscal.statusCode).toBe(201);
    expect(fiscal.json().status).toBe('AGUARDANDO_MODULO_FISCAL');
  });

  it('pagar um VALOR de um item: quem vai embora paga R$ 15 do filé + a água, e fica registrado', async () => {
    const mesa = await openComanda(ids.mesa11, 'Mesa da família', '390.533.447-05', 5);
    await order(ids.mesa11, [mesa], [{ productId: ids.file, qty: 1 }, { productId: ids.agua, qty: 1 }]);
    const b = await bill(mesa);
    const file = b.items.find((i: { productName: string }) => i.productName === 'Filé');
    const agua = b.items.find((i: { productName: string }) => i.productName === 'Água');
    // 15,00 + 5,00 de água = 20,00 + 10% = 22,00
    const res = await pay({
      comandaIds: [mesa],
      method: 'PIX',
      amountCents: 2_200,
      payerName: 'Tio Zé',
      items: [
        { orderItemId: file.orderItemId, comandaId: mesa, amountCents: 1_500 },
        { orderItemId: agua.orderItemId, comandaId: mesa, num: 1, den: 1 },
      ],
    });
    expect(res.statusCode).toBe(201);
    const after = await bill(mesa);
    expect(after.items.find((i: { productName: string }) => i.productName === 'Filé')).toMatchObject({ paidCents: 1_500 });
    expect(after.payments[0]).toMatchObject({
      payerName: 'Tio Zé',
      items: [
        { productName: 'Filé', amountCents: 1_500, whole: false },
        { productName: 'Água', amountCents: 500, whole: true },
      ],
    });
    // O restante do filé ainda pode ser pago; passar do valor do item é recusado.
    const over = await pay({ comandaIds: [mesa], method: 'PIX', amountCents: 9_350, items: [{ orderItemId: file.orderItemId, comandaId: mesa, amountCents: 8_600 }] });
    expect(over.json().error).toBe('ITEM_OVERPAID');
    expect(over.json().message).toContain('85,00');
  });

  it('pagamento por fração: 1/3 da pizza (+10%) três vezes fecha o item; a quarta é recusada', async () => {
    const pizza = (await bill(ids.joao)).items.find((i: { productName: string }) => i.productName === 'Pizza');
    const third = { orderItemId: pizza.orderItemId, comandaId: ids.joao, num: 1, den: 3 };
    expect((await pay({ comandaIds: [ids.joao], method: 'DEBITO', amountCents: 1_000, items: [third] })).json().error).toBe('AMOUNT_CHANGED');
    for (const amount of [1_834, 1_834, 1_833]) {
      expect((await pay({ comandaIds: [ids.joao], method: 'DEBITO', amountCents: amount, items: [third] })).statusCode).toBe(201);
    }
    expect((await pay({ comandaIds: [ids.joao], method: 'DEBITO', amountCents: 1_833, items: [third] })).json().error).toBe('ITEM_OVERPAID');
  });

  it('clique duplo não cobra duas vezes', async () => {
    const clientUuid = randomUUID();
    const a = await pay({ clientUuid, comandaIds: [ids.joao], method: 'PIX', amountCents: 100 });
    const b = await pay({ clientUuid, comandaIds: [ids.joao], method: 'PIX', amountCents: 100 });
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json().duplicate).toBe(true);
  });

  it('caixa em modo fiscal AUTOMATICO já pede o cupom fiscal ao quitar', async () => {
    const remaining = (await bill(ids.joao)).totals.remainingCents;
    const res = await pay({ registerId: ids.paulo, comandaIds: [ids.joao], method: 'CREDITO', amountCents: remaining });
    expect(res.json()).toMatchObject({ closedComandaIds: [ids.joao], fiscalMode: 'AUTOMATICO', fiscalRequested: true });
    const [req] = await ctx.db.select().from(fiscalRequests).where(eq(fiscalRequests.automatic, true));
    expect(req!.comandaIds).toEqual([ids.joao]);
    // Mesa 10 ainda tem Ana e Bia? Não: foram quitadas antes. A mesa fica livre.
    const map = (await garcom({ method: 'GET', url: '/api/waiter/tables' })).json();
    expect(map.tables.find((t: { number: number }) => t.number === 10).status).toBe('LIVRE');
  });
});

describe('estorno', () => {
  it('exige gerente; reabre as comandas que o pagamento tinha fechado', async () => {
    const cash = (await bill(ids.ana, ids.bia)).payments.find((p: { method: string }) => p.method === 'DINHEIRO');
    const noPin = await caixa({ method: 'POST', url: `/api/cashier/payments/${cash.id}/refund`, payload: { reason: 'Cobrado errado' } });
    expect(noPin.json().error).toBe('PIN_REQUIRED');
    const ok = await caixa({ method: 'POST', url: `/api/cashier/payments/${cash.id}/refund`, payload: { reason: 'Cobrado errado', authorizerPin: PIN } });
    expect(ok.json().reopenedComandaIds.sort()).toEqual([ids.ana, ids.bia].sort());
    expect((await bill(ids.ana, ids.bia)).totals.remainingCents).toBe(8_000);
  });
});

describe('sangria, suprimento e fechamento por caixa', () => {
  it('movimentos são do caixa informado', async () => {
    const big = await caixa({ method: 'POST', url: '/api/cashier/session/movements', payload: { registerId: ids.carlos, type: 'SANGRIA', amountCents: 50_000, reason: 'Depósito' } });
    expect(big.statusCode).toBe(409);
    await caixa({ method: 'POST', url: '/api/cashier/session/movements', payload: { registerId: ids.carlos, type: 'SUPRIMENTO', amountCents: 5_000, reason: 'Troco extra' } });
    const s = await caixa({ method: 'POST', url: '/api/cashier/session/movements', payload: { registerId: ids.carlos, type: 'SANGRIA', amountCents: 3_000, reason: 'Depósito no banco' } });
    expect(s.json().session.expectedCashCents).toBe(12_000); // 100 + 50 − 30 (dinheiro estornado)
  });

  it('fechar um caixa com outro ainda aberto não acusa comandas abertas', async () => {
    const preview = (await caixa({ method: 'GET', url: `/api/cashier/session/close-preview?registerId=${ids.carlos}` })).json();
    expect(preview.openComandas).toBe(0);
    const closed = await caixa({
      method: 'POST',
      url: '/api/cashier/session/close',
      payload: { registerId: ids.carlos, counted: { DINHEIRO: 11_500 }, notes: 'Faltou troco' },
    });
    expect(closed.json()).toMatchObject({ differenceCents: -500, printed: true });
  });

  it('o último caixa a fechar é avisado das comandas abertas; depois disso não há regras do dia', async () => {
    const blocked = await gerente({ method: 'POST', url: '/api/cashier/session/close', payload: { registerId: ids.paulo, counted: { DINHEIRO: 5_000 } } });
    expect(blocked.json().error).toBe('OPEN_COMANDAS');
    const closed = await gerente({
      method: 'POST',
      url: '/api/cashier/session/close',
      payload: { registerId: ids.paulo, counted: { DINHEIRO: 5_000 }, confirmOpenComandas: true },
    });
    expect(closed.statusCode).toBe(200);
    expect((await caixa({ method: 'GET', url: '/api/cashier/session/day-rules' })).json().rules).toBeNull();
    expect((await pay({ comandaIds: [ids.carla], method: 'PIX', amountCents: 100 })).json().error).toBe('NO_OPEN_SESSION');
  });

  it('comprovantes saíram na impressora do caixa', async () => {
    const jobs = await ctx.db.select().from(printJobs).where(and(eq(printJobs.printerId, ids.caixaPrinter), eq(printJobs.type, 'CAIXA')));
    expect(jobs.length).toBeGreaterThanOrEqual(5); // 2 aberturas, suprimento, sangria, 2 fechamentos
  });
});

describe('relatório de vendas e entradas', () => {
  const today = localDate(new Date());
  const report = async (qs: string, as: Inject = admin) => as({ method: 'GET', url: `/api/admin/reports/sales?${qs}` });

  it('soma as entradas por forma (cartão = crédito + débito), por caixa e por dia, sem os estornos', async () => {
    const r: SalesReport = (await report(`from=${today}&to=${today}`)).json();
    const all = await ctx.db.select().from(payments);
    const ok = all.filter((p) => p.status === 'OK');
    const sum = (m: string) => ok.filter((p) => p.method === m).reduce((s, p) => s + p.amountCents, 0);
    expect(r.received.byMethod).toEqual({ CREDITO: sum('CREDITO'), DEBITO: sum('DEBITO'), PIX: sum('PIX'), DINHEIRO: sum('DINHEIRO') });
    expect(r.received.cardCents).toBe(sum('CREDITO') + sum('DEBITO'));
    expect(r.received.totalCents).toBe(ok.reduce((s, p) => s + p.amountCents, 0));
    expect(r.refunds.count).toBe(all.length - ok.length);
    expect(r.refunds.count).toBeGreaterThan(0);

    expect(r.days).toHaveLength(1);
    expect(r.days[0]!.date).toBe(today);
    expect(r.days[0]!.totalCents).toBe(r.received.totalCents);
    expect(r.registers.map((x) => x.name)).toEqual(['Caixa Carlos', 'Caixa Paulo']);
    expect(r.registers.reduce((s, x) => s + x.totalCents, 0)).toBe(r.received.totalCents);
    expect(r.cash).toMatchObject({ sessions: 2, openSessions: 0, suprimentoCents: 5_000, sangriaCents: 3_000 });
    expect(r.sessions.find((x) => x.registerName === 'Caixa Carlos')!.differenceCents).toBe(-500);
  });

  it('vendas das comandas fechadas, ticket médio, produtos e o valor pedido em cupom fiscal', async () => {
    const r: SalesReport = (await report(`from=${today}&to=${today}`)).json();
    const closed = (await ctx.db.select().from(comandas)).filter((c) => c.status === 'FECHADA');
    expect(r.sales.comandas).toBe(closed.length);
    expect(r.sales.totalCents).toBe(closed.reduce((s, c) => s + (c.finalTotals as { totalCents: number }).totalCents, 0));
    expect(r.sales.averageTicketCents).toBe(Math.round(r.sales.totalCents / r.sales.comandas));
    expect(r.products.length).toBeGreaterThan(0);
    expect(r.products[0]!.totalCents).toBeGreaterThanOrEqual(r.products.at(-1)!.totalCents);
    // Venda por produto no período, com o detalhe por dia (ex.: quantas Heinekens hoje).
    const heineken = r.products.find((p) => p.name === 'Heineken')!;
    expect(heineken.qty).toBeGreaterThan(0);
    expect(heineken.days).toEqual([{ date: today, qty: heineken.qty, totalCents: heineken.totalCents }]);

    const requests = await ctx.db.select().from(fiscalRequests);
    expect(r.fiscal.requests).toBe(requests.length);
    expect(r.fiscal.automatic).toBe(requests.filter((f) => f.automatic).length);
    expect(r.fiscal.comandas).toBe(new Set(requests.flatMap((f) => f.comandaIds)).size);
    expect(r.fiscal.requestedCents).toBeGreaterThan(0);
    expect(r.fiscal.withoutNoteCents).toBe(Math.max(0, r.received.totalCents - r.fiscal.requestedCents));
  });

  it('filtra por caixa e por período; dia sem movimento vem zerado', async () => {
    const paulo: SalesReport = (await report(`from=${today}&to=${today}&registerId=${ids.paulo}`)).json();
    expect(paulo.registers.map((x) => x.name)).toEqual(['Caixa Paulo']);
    expect(paulo.cash.sessions).toBe(1);
    const empty: SalesReport = (await report('from=2020-01-01&to=2020-01-31')).json();
    expect(empty.received.totalCents).toBe(0);
    expect(empty.days).toEqual([]);
  });

  it('valida as datas em português e é só do admin', async () => {
    expect((await report('from=2026-02-10&to=2026-02-01')).json().message).toBe('A data inicial é depois da final.');
    expect((await report('from=10/02/2026&to=2026-02-01')).json().message).toBe('Data inválida (use AAAA-MM-DD).');
    expect((await report(`from=${today}&to=${today}`, caixa)).statusCode).toBe(403);
  });
});
