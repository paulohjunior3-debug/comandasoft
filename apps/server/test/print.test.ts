import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, printJobs } from '../src/db/schema';
import { backoffMs } from '../src/printing/worker';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let garcom: Inject;
let caixa: Inject;
const ids = {} as Record<'bar' | 'cozinha' | 'heineken' | 'fritas' | 'mesa' | 'paulo', string>;

const order = (items: { productId: string; qty: number; notes?: string }[]) =>
  garcom({
    method: 'POST',
    url: '/api/waiter/orders',
    payload: { clientUuid: randomUUID(), tableId: ids.mesa, comandaIds: [ids.paulo], items, createdAtDevice: new Date().toISOString() },
  });

const jobsOf = (printerId: string) =>
  ctx.db.select().from(printJobs).where(eq(printJobs.printerId, printerId)).orderBy(asc(printJobs.createdAt));

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  garcom = await ctx.as('garcom');
  caixa = await ctx.as('caixa');
  const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();
  ids.bar = (await post('/api/admin/printers', { name: 'Bar', windowsName: 'ELGIN BAR', sectorLabel: 'BAR' })).id;
  ids.cozinha = (await post('/api/admin/printers', { name: 'Cozinha', windowsName: 'ELGIN COZINHA', sectorLabel: 'COZINHA', widthMm: 58 })).id;
  const cervejas = (await post('/api/admin/categories', { name: 'Cervejas', printerIds: [ids.bar] })).id;
  const porcoes = (await post('/api/admin/categories', { name: 'Porções', printerIds: [ids.cozinha] })).id;
  ids.heineken = (await post('/api/admin/products', { categoryId: cervejas, name: 'Heineken 600ml', priceCents: 1890 })).id;
  ids.fritas = (await post('/api/admin/products', { categoryId: porcoes, name: 'Batata frita', priceCents: 3290 })).id;
  ids.mesa = (await post('/api/admin/tables', { number: 10 })).id;
  ids.paulo = (
    await garcom({
      method: 'POST',
      url: '/api/waiter/comandas',
      payload: { clientUuid: randomUUID(), tableId: ids.mesa, customerName: 'Paulo', cpf: '529.982.247-25' },
    })
  ).json().id;
});
afterAll(() => ctx.close());

describe('worker de impressão', () => {
  it('imprime cada cupom na impressora do setor, com mesa e nome em destaque', async () => {
    await order([
      { productId: ids.heineken, qty: 2 },
      { productId: ids.fritas, qty: 1, notes: 'sem sal' },
    ]);
    await ctx.app.printWorker.runOnce();

    expect(ctx.printed.map((p) => p.printer).sort()).toEqual(['Bar', 'Cozinha']);
    const bar = ctx.printed.find((p) => p.printer === 'Bar')!;
    expect(bar.preview).toContain('M E S A   1 0');
    expect(bar.preview).toContain('PAULO');
    expect(bar.preview).toContain('2x Heineken 600ml');
    expect([...bar.bytes.slice(0, 2)]).toEqual([0x1b, 0x40]);

    const cozinha = ctx.printed.find((p) => p.printer === 'Cozinha')!;
    expect(cozinha.preview).toContain('>> SEM SAL');
    // Papel de 58 mm: nenhuma linha passa de 32 colunas.
    expect(cozinha.preview.split('\n').every((l) => l.length <= 32)).toBe(true);

    const all = await ctx.db.select().from(printJobs);
    expect(all.every((j) => j.status === 'OK' && j.printedAt && j.attempts === 1)).toBe(true);
  });

  it('impressora com problema não trava as outras e mantém a ordem dos seus cupons', async () => {
    ctx.printed.length = 0;
    ctx.failing.set('ELGIN BAR', 'sem papel');
    await order([{ productId: ids.heineken, qty: 1 }, { productId: ids.fritas, qty: 1 }]);
    await order([{ productId: ids.heineken, qty: 3 }]);
    await ctx.app.printWorker.runOnce();

    expect(ctx.printed.map((p) => p.printer)).toEqual(['Cozinha']);
    const [first, second] = (await jobsOf(ids.bar)).filter((j) => j.status !== 'OK');
    expect(first).toMatchObject({ status: 'ERRO', lastError: 'sem papel', attempts: 1 });
    expect(first!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(second).toMatchObject({ status: 'PENDENTE', attempts: 0 }); // espera o primeiro

    // Antes do backoff, não tenta de novo.
    await ctx.app.printWorker.runOnce();
    expect((await jobsOf(ids.bar)).find((j) => j.id === first!.id)!.attempts).toBe(1);

    // Papel trocado: o caixa manda tentar de novo e sai tudo, em ordem.
    ctx.failing.delete('ELGIN BAR');
    const retry = await caixa({ method: 'POST', url: `/api/print/jobs/${first!.id}/retry` });
    expect(retry.statusCode).toBe(200);
    await ctx.app.printWorker.runOnce();
    expect(ctx.printed.map((p) => p.jobId)).toEqual([expect.any(String), first!.id, second!.id]);
    expect((await jobsOf(ids.bar)).every((j) => j.status === 'OK')).toBe(true);
  });

  it('espera cresce a cada falha até 60 s', () => {
    expect([1, 2, 3, 4, 5, 10].map(backoffMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  it('impressora desativada segura os cupons já na fila até ser reativada', async () => {
    ctx.printed.length = 0;
    await order([{ productId: ids.fritas, qty: 1 }]); // entra na fila antes da desativação
    const printer = (await admin({ method: 'GET', url: '/api/admin/printers' })).json().find((p: { id: string }) => p.id === ids.cozinha);
    await admin({ method: 'PUT', url: `/api/admin/printers/${ids.cozinha}`, payload: { ...printer, active: false } });
    await ctx.app.printWorker.runOnce();
    expect(ctx.printed).toHaveLength(0);

    // Pedido novo com a impressora desativada: não gera cupom e o garçom é avisado.
    const res = await order([{ productId: ids.fritas, qty: 1 }]);
    expect(res.json()).toMatchObject({ printJobs: 0, unroutedItems: 1 });

    await admin({ method: 'PUT', url: `/api/admin/printers/${ids.cozinha}`, payload: { ...printer, active: true } });
    await ctx.app.printWorker.runOnce();
    expect(ctx.printed.map((p) => p.printer)).toEqual(['Cozinha']);
  });

  it('cupom que estava "imprimindo" quando o servidor caiu volta para a fila ao iniciar', async () => {
    const [job] = await jobsOf(ids.bar);
    await ctx.db.update(printJobs).set({ status: 'IMPRIMINDO' }).where(eq(printJobs.id, job!.id));
    await ctx.app.printWorker.start();
    await ctx.app.printWorker.stop();
    const [after] = await ctx.db.select().from(printJobs).where(eq(printJobs.id, job!.id));
    expect(['PENDENTE', 'OK']).toContain(after!.status);
  });
});

describe('fila de impressão (caixa)', () => {
  it('reimpressão gera novo cupom marcado e fica na auditoria', async () => {
    ctx.printed.length = 0;
    const [original] = await jobsOf(ids.bar);
    const res = await caixa({ method: 'POST', url: `/api/print/jobs/${original!.id}/reprint` });
    expect(res.statusCode).toBe(201);
    await ctx.app.printWorker.runOnce();
    expect(ctx.printed[0]!.preview).toContain('REIMPRESSÃO');

    const [copy] = await ctx.db.select().from(printJobs).where(eq(printJobs.id, res.json().id));
    expect(copy).toMatchObject({ reprintOf: original!.id, status: 'OK' });
    const [log] = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'REIMPRESSAO'));
    expect(log!.entityId).toBe(original!.id);
  });

  it('lista a fila com status por impressora e mostra a prévia', async () => {
    ctx.failing.set('ELGIN COZINHA', 'impressora desligada');
    await order([{ productId: ids.fritas, qty: 2 }]);
    await ctx.app.printWorker.runOnce();

    const queue = (await caixa({ method: 'GET', url: '/api/print/queue' })).json();
    expect(queue.mode).toBe('emulador');
    const cozinha = queue.printers.find((p: { printerName: string }) => p.printerName === 'Cozinha');
    expect(cozinha).toMatchObject({ errors: 1, lastError: 'impressora desligada' });
    expect(queue.jobs[0]).toMatchObject({ status: 'ERRO', description: 'Mesa 10 · Paulo · 2 itens' });

    const open = (await caixa({ method: 'GET', url: '/api/print/queue?status=ABERTOS' })).json();
    expect(open.jobs.every((j: { status: string }) => j.status !== 'OK')).toBe(true);

    const preview = (await caixa({ method: 'GET', url: `/api/print/jobs/${queue.jobs[0].id}/preview` })).json();
    expect(preview.text).toContain('2x Batata frita');
    ctx.failing.delete('ELGIN COZINHA');
  });

  it('garçom não acessa a fila; caixa e gerente acessam', async () => {
    expect((await garcom({ method: 'GET', url: '/api/print/queue' })).statusCode).toBe(403);
    const gerente = await ctx.as('gerente');
    expect((await gerente({ method: 'GET', url: '/api/print/queue' })).statusCode).toBe(200);
  });
});

describe('imprimir teste', () => {
  it('admin manda uma página de teste com acentos para a impressora', async () => {
    ctx.printed.length = 0;
    const res = await admin({ method: 'POST', url: `/api/admin/printers/${ids.bar}/test` });
    expect(res.statusCode).toBe(201);
    await ctx.app.printWorker.runOnce();
    const page = ctx.printed.find((p) => p.jobId === res.json().jobId)!;
    expect(page.preview).toContain('TESTE DE IMPRESSÃO');
    expect(page.preview).toContain('Ação, pão, coração');
    expect(page.preview).toContain('Windows: ELGIN BAR');
  });
});
