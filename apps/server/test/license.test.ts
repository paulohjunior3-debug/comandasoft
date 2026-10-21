import { randomUUID } from 'node:crypto';
import type { LicenseBannerInfo, LicenseStatus } from '@sistema-bar/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, cashSessions } from '../src/db/schema';
import { generateKeyPair, importPrivateKey, importPublicKey, signToken } from '../src/licensing/token';
import { handleRequest, type ClientRecord, type KvLike, type WorkerEnv } from '../src/licensing/worker';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

const DAY = 24 * 60 * 60 * 1000;
const MACHINE = '7F3A-91C2-0B5E-D4A8';
const OTHER_MACHINE = '0000-1111-2222-3333';
const SERVER = 'https://licencas.test';
const ADMIN_TOKEN = 'token-do-dono';

function fakeKv(): KvLike {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => void data.set(key, value),
    list: async ({ prefix }) => ({ keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  };
}

/** App com licença ligada, relógio falso e o Worker de verdade atrás de um fetch falso (sem rede). */
async function createWorld() {
  const root = await generateKeyPair();
  const renewal = await generateKeyPair();
  const stranger = await generateKeyPair();
  const env: WorkerEnv = { LICENCAS: fakeKv(), CHAVE_RENOVACAO: renewal.privateKey, TOKEN_ADMIN: ADMIN_TOKEN };
  const clock = { now: new Date() };
  const net = { online: true };
  const fetchFake: typeof fetch = async (input, init) => {
    if (!net.online) throw new TypeError('fetch failed');
    return handleRequest(new Request(String(input), init), env, clock.now);
  };
  const ctx = await createTestContext({
    license: {
      enforce: true,
      keys: { root: [await importPublicKey(root.publicKey)], renewal: [await importPublicKey(renewal.publicKey)] },
      now: () => clock.now,
      machineId: async () => MACHINE,
      fetch: fetchFake,
    },
  });

  const sign = async (payload: object, key = root) => signToken(payload, await importPrivateKey(key.privateKey));
  const license = (over: Record<string, unknown> = {}) => ({
    tipo: 'licenca',
    id: 'LTESTE00001',
    cliente: 'Bar do Teste',
    cnpj: '12.345.678/0001-90',
    maquina: MACHINE,
    emitidaEm: clock.now.toISOString(),
    validaAte: null,
    recursos: ['fiscal', 'cozinha', 'qr'],
    renovacao: SERVER,
    suporte: '(34) 99999-0000',
    ...over,
  });
  const lease = (validDays: number, over: Record<string, unknown> = {}) => ({
    tipo: 'lease',
    licencaId: 'LTESTE00001',
    maquina: MACHINE,
    emitidoEm: clock.now.toISOString(),
    validoAte: new Date(clock.now.getTime() + validDays * DAY).toISOString(),
    ...over,
  });
  const worker = (method: string, path: string, body?: unknown, token = ADMIN_TOKEN) =>
    handleRequest(
      new Request(`${SERVER}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      clock.now,
    );
  const advance = (days: number) => {
    clock.now = new Date(clock.now.getTime() + days * DAY);
  };
  return { ctx, env, clock, net, root, renewal, stranger, sign, license, lease, worker, advance };
}

type World = Awaited<ReturnType<typeof createWorld>>;

describe('avaliação, carência e bloqueio', () => {
  let w: World;
  let admin: Inject;
  let caixa: Inject;
  let garcom: Inject;
  const ids: Record<string, string> = {};
  const status = async () => (await admin({ method: 'GET', url: '/api/admin/license' })).json() as LicenseStatus;
  const banner = async () => (await garcom({ method: 'GET', url: '/api/license/status' })).json() as LicenseBannerInfo;
  const openCash = (registerId: string | undefined) =>
    caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId, openingFloatCents: 0 } });
  const openComanda = (clientUuid: string = randomUUID()) =>
    garcom({
      method: 'POST',
      url: '/api/waiter/comandas',
      payload: { clientUuid, tableId: ids.mesa, customerName: `Cliente ${clientUuid.slice(0, 8)}`, phone: '(34) 99999-0000' },
    });

  beforeAll(async () => {
    w = await createWorld();
    admin = await w.ctx.as('admin');
    caixa = await w.ctx.as('caixa');
    garcom = await w.ctx.as('garcom');
    const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();
    ids.carlos = (await post('/api/admin/registers', { name: 'Caixa Carlos' })).id;
    ids.paulo = (await post('/api/admin/registers', { name: 'Caixa Paulo' })).id;
    ids.mesa = ((await post('/api/admin/tables/bulk', { from: 1, to: 1 })).created as { id: string }[])[0]!.id;
  });
  afterAll(() => w.ctx.close());

  it('instalação nova começa em avaliação de 15 dias', async () => {
    expect(await status()).toMatchObject({ state: 'VALIDA', mode: 'AVALIACAO', daysLeft: 15, machineId: MACHINE, enforced: true });
    expect(await banner()).toMatchObject({ state: 'VALIDA', message: null });
  });

  it('avisa nos últimos 7 dias', async () => {
    w.advance(9);
    const b = await banner();
    expect(b.state).toBe('AVISO');
    expect(b.message).toContain('faltam 6 dia(s)');
  });

  it('na carência tudo funciona, com faixa vermelha', async () => {
    w.advance(8.5); // dia 17,5: venceu há 2,5 dias
    expect((await banner()).state).toBe('CARENCIA');
    const res = await openCash(ids.carlos);
    expect(res.statusCode).toBe(201);
    // O caixa abriu agora (no relógio falso).
    await w.ctx.db.update(cashSessions).set({ openedAt: w.clock.now }).where(eq(cashSessions.registerId, ids.carlos!));
  });

  it('bloqueada: não abre caixa novo, mas o caixa já aberto segue o movimento', async () => {
    w.advance(0.75); // dia 18,25: passou da carência
    const s = await status();
    expect(s.state).toBe('BLOQUEADA');
    const res = await openCash(ids.paulo);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'LICENCA_BLOQUEADA' });
    expect(res.json().message).toContain('Período de avaliação encerrado');
    // Caixa Carlos aberto há 18 h (< 24 h): o salão continua.
    ids.accepted = randomUUID();
    expect((await openComanda(ids.accepted)).statusCode).toBe(201);
  });

  it('depois de 24 h do caixa aberto, para de lançar; fechar o caixa continua liberado', async () => {
    w.advance(0.3);
    expect((await openComanda()).statusCode).toBe(403);
    const close = await caixa({
      method: 'POST',
      url: '/api/cashier/session/close',
      payload: { registerId: ids.carlos, counted: { DINHEIRO: 0 }, confirmOpenComandas: true },
    });
    expect(close.statusCode).toBe(200);
    expect((await admin({ method: 'GET', url: '/api/admin/reports/sales?from=2020-01-01&to=2030-12-31' })).statusCode).toBeLessThan(500);
  });

  it('reenvio de comanda já aceita (fila do celular) responde igual mesmo bloqueado', async () => {
    expect((await openComanda(ids.accepted!)).statusCode).toBe(200);
  });

  it('atrasar o relógio do Windows não devolve dias', async () => {
    w.advance(-20);
    expect((await status()).state).toBe('BLOQUEADA');
    w.advance(20);
  });

  it('colar a licença libera na hora', async () => {
    await w.worker('PUT', '/admin/clientes/LTESTE00001', { cliente: 'Bar do Teste', cnpj: '', maquina: MACHINE });
    const res = await admin({ method: 'POST', url: '/api/admin/license', payload: { token: await w.sign(w.license()) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'VALIDA', mode: 'LICENCIADA', customer: 'Bar do Teste', machineBound: true, daysLeft: 15 });
    expect((await openCash(ids.paulo)).statusCode).toBe(201);
  });
});

describe('licença, renovação e lease manual', () => {
  let w: World;
  let admin: Inject;
  const status = async () => (await admin({ method: 'GET', url: '/api/admin/license' })).json() as LicenseStatus;
  const install = async (token: string) => admin({ method: 'POST', url: '/api/admin/license', payload: { token } });
  const renewNow = async () => (await admin({ method: 'POST', url: '/api/admin/license/renew' })).json();
  const auditCount = async (action: string) =>
    (await w.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.action, action), eq(auditLogs.entity, 'licenca')))).length;

  beforeAll(async () => {
    w = await createWorld();
    admin = await w.ctx.as('admin');
  });
  afterAll(() => w.ctx.close());

  it('recusa texto adulterado, assinado por outra chave ou de outro computador', async () => {
    const good = await w.sign(w.license());
    const tampered = `${good.slice(0, 20)}${good[20] === 'A' ? 'B' : 'A'}${good.slice(21)}`;
    for (const token of ['qualquer coisa', tampered, await w.sign(w.license(), w.stranger)]) {
      const res = await install(token);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('LICENCA_INVALIDA');
    }
    const other = await install(await w.sign(w.license({ maquina: OTHER_MACHINE })));
    expect(other.json().message).toBe(`Esta licença é do computador ${OTHER_MACHINE}; este é ${MACHINE}.`);
    expect((await status()).mode).toBe('AVALIACAO');
  });

  it('instala, audita e renova pelo servidor de licenças', async () => {
    await w.worker('PUT', '/admin/clientes/LTESTE00001', { cliente: 'Bar do Teste', cnpj: '', maquina: MACHINE });
    expect((await install(await w.sign(w.license()))).statusCode).toBe(200);
    expect(await auditCount('LICENCA_INSTALADA')).toBe(1);

    w.advance(10);
    expect((await status()).state).toBe('AVISO');
    const renewed = await renewNow();
    expect(renewed.renewal).toMatchObject({ ok: true, message: null });
    expect(renewed.status).toMatchObject({ state: 'VALIDA', daysLeft: 15 });
    const clients = (await (await w.worker('GET', '/admin/clientes')).json()) as ClientRecord[];
    expect(clients[0]).toMatchObject({ id: 'LTESTE00001', ativo: true, ultimaRenovacao: { versao: expect.any(String) } });
  });

  it('sem internet: segue com o lease que tem', async () => {
    w.net.online = false;
    w.advance(1);
    expect((await renewNow()).renewal).toMatchObject({ ok: false, message: 'Sem conexão com o servidor de licenças.' });
    expect((await status()).state).toBe('VALIDA');
    w.net.online = true;
  });

  it('suspenso: a renovação é recusada (auditada uma vez) e a licença vence sozinha', async () => {
    await w.worker('POST', '/admin/clientes/LTESTE00001/suspender');
    w.advance(1);
    await w.ctx.app.license.renew();
    await w.ctx.app.license.renew();
    expect(await auditCount('LICENCA_RENOVACAO_RECUSADA')).toBe(1);
    expect((await status()).lastRenewal).toMatchObject({ ok: false, message: 'Licença suspensa. Fale com o suporte.' });
    expect((await status()).state).toBe('VALIDA'); // não existe desligamento instantâneo

    w.advance(13); // lease de 15 dias renovado 2 dias atrás → vence em 13
    expect((await status()).state).toBe('CARENCIA');
    w.advance(3);
    const blocked = await status();
    expect(blocked.state).toBe('BLOQUEADA');
    expect(blocked.message).toContain('Licença vencida');
    expect(blocked.message).toContain('Suporte: (34) 99999-0000');
  });

  it('reativado: volta na próxima renovação', async () => {
    await w.worker('POST', '/admin/clientes/LTESTE00001/reativar');
    expect((await renewNow()).status).toMatchObject({ state: 'VALIDA', daysLeft: 15 });
  });

  it('lease manual (loja sem internet): só aceita o mais novo, da mesma licença', async () => {
    const manual = await install(await w.sign(w.lease(30), w.renewal));
    expect(manual.json()).toMatchObject({ state: 'VALIDA', daysLeft: 30 });
    expect(await auditCount('LICENCA_LEASE_INSTALADO')).toBe(1);

    const older = await install(await w.sign(w.lease(20), w.renewal));
    expect(older.json().message).toBe('Este lease não é mais novo que o instalado.');
    const otherLicense = await install(await w.sign(w.lease(40, { licencaId: 'OUTRA' }), w.renewal));
    expect(otherLicense.json().message).toBe('Este lease é de outra licença.');
    const forged = await install(await w.sign(w.lease(40), w.stranger));
    expect(forged.json().error).toBe('LICENCA_INVALIDA');
  });

  it('o lease corrige relógio adiantado por engano', async () => {
    w.advance(1);
    w.advance(400); // alguém mexeu na data do Windows
    expect((await status()).state).toBe('BLOQUEADA');
    w.advance(-400); // relógio corrigido, mas o maior horário visto ficou lá na frente
    expect((await status()).state).toBe('BLOQUEADA');
    // O lease novo (15 dias) corrige o relógio; continua valendo o manual, que vence depois.
    expect((await renewNow()).status).toMatchObject({ state: 'VALIDA', daysLeft: 29 });
  });

  it('licença sem renovação e sem fim de contrato não vence', async () => {
    expect((await install(await w.sign(w.license({ id: 'LFIXA', renovacao: null })))).statusCode).toBe(200);
    w.advance(500);
    expect(await status()).toMatchObject({ state: 'VALIDA', expiresAt: null, autoRenew: false });
  });

  it('fim de contrato vence mesmo com lease em dia', async () => {
    const end = new Date(w.clock.now.getTime() + 5 * DAY).toISOString();
    await install(await w.sign(w.license({ id: 'LCONTRATO', renovacao: null, validaAte: end })));
    expect(await status()).toMatchObject({ state: 'AVISO', expiresAt: end, daysLeft: 5 });
  });

  it('só o admin vê e troca a licença', async () => {
    const garcom = await w.ctx.as('garcom');
    expect((await garcom({ method: 'GET', url: '/api/admin/license' })).statusCode).toBe(403);
    expect((await garcom({ method: 'GET', url: '/api/license/status' })).statusCode).toBe(200);
  });
});

describe('desenvolvimento (sem bloqueio)', () => {
  let ctx: TestContext;
  let clock = Date.now();
  beforeAll(async () => {
    ctx = await createTestContext({ license: { enforce: false, now: () => new Date(clock), machineId: async () => null } });
    await ctx.app.license.status(); // começa a avaliação
    clock += 365 * DAY;
  });
  afterAll(() => ctx.close());

  it('mostra o estado, mas não bloqueia nem mostra faixa', async () => {
    const admin = await ctx.as('admin');
    expect((await admin({ method: 'GET', url: '/api/admin/license' })).json()).toMatchObject({ state: 'BLOQUEADA', enforced: false });
    expect((await admin({ method: 'GET', url: '/api/license/status' })).json()).toMatchObject({ state: 'VALIDA', message: null });
    const register = (await admin({ method: 'POST', url: '/api/admin/registers', payload: { name: 'Caixa' } })).json();
    const res = await admin({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: register.id, openingFloatCents: 0 } });
    expect(res.statusCode).toBe(201);
  });
});

describe('servidor de licenças (Worker)', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });
  afterAll(() => w.ctx.close());

  const renew = (body: unknown) =>
    handleRequest(new Request(`${SERVER}/renovar`, { method: 'POST', body: JSON.stringify(body) }), w.env, w.clock.now);

  it('exige o token do dono nas rotas de administração', async () => {
    expect((await w.worker('GET', '/admin/clientes', undefined, 'errado')).status).toBe(401);
    expect((await w.worker('GET', '/admin/clientes', undefined, '')).status).toBe(401);
  });

  it('não renova licença desconhecida nem de outro computador', async () => {
    expect((await renew({ licencaId: 'NAOEXISTE', maquina: MACHINE })).status).toBe(404);
    await w.worker('PUT', '/admin/clientes/LTESTE00001', { cliente: 'Bar', cnpj: '', maquina: MACHINE });
    const other = await renew({ licencaId: 'LTESTE00001', maquina: OTHER_MACHINE });
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toBe('MAQUINA_DIFERENTE');
    const ok = await renew({ licencaId: 'LTESTE00001', maquina: MACHINE, versao: '0.15.0' });
    expect(((await ok.json()) as { lease: string }).lease).toMatch(/^SB1\./);
  });
});
