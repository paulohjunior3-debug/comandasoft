import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs } from '../src/db/schema';
import { createTestContext, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Awaited<ReturnType<TestContext['as']>>;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
});
afterAll(() => ctx.close());

const auditActions = async (entity: string) =>
  (await ctx.db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entity, entity))).map(
    (a) => a.action,
  );

describe('permissões do painel admin', () => {
  it('sem login dá 401 e perfis não-admin dão 403', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/categories' })).statusCode).toBe(401);
    for (const login of ['gerente', 'caixa', 'garcom']) {
      const as = await ctx.as(login);
      expect((await as({ method: 'GET', url: '/api/admin/categories' })).statusCode).toBe(403);
    }
    expect((await admin({ method: 'GET', url: '/api/admin/categories' })).statusCode).toBe(200);
  });
});

describe('categorias e produtos', () => {
  let cervejas: string;
  let porcoes: string;

  it('cria categorias, recusa nome repetido e ordena por sortOrder', async () => {
    const a = await admin({ method: 'POST', url: '/api/admin/categories', payload: { name: 'Porções', sortOrder: 2 } });
    const b = await admin({ method: 'POST', url: '/api/admin/categories', payload: { name: 'Cervejas', sortOrder: 1 } });
    expect(a.statusCode).toBe(201);
    porcoes = a.json().id;
    cervejas = b.json().id;

    const dup = await admin({ method: 'POST', url: '/api/admin/categories', payload: { name: 'Cervejas' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toBe('Já existe uma categoria com esse nome.');

    const list = (await admin({ method: 'GET', url: '/api/admin/categories' })).json();
    expect(list.map((c: { name: string }) => c.name)).toEqual(['Cervejas', 'Porções']);
  });

  it('produto: valida preço em centavos e categoria; SKU único', async () => {
    const bad = await admin({ method: 'POST', url: '/api/admin/products', payload: { categoryId: cervejas, name: 'X', priceCents: 9.9 } });
    expect(bad.statusCode).toBe(400);

    const noCat = await admin({
      method: 'POST',
      url: '/api/admin/products',
      payload: { categoryId: '00000000-0000-4000-8000-000000000000', name: 'X', priceCents: 100 },
    });
    expect(noCat.statusCode).toBe(400);
    expect(noCat.json().message).toBe('Categoria inválida.');

    const ok = await admin({
      method: 'POST',
      url: '/api/admin/products',
      payload: { categoryId: cervejas, name: 'Heineken 600ml', priceCents: 1890, sku: 'HEI600' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ name: 'Heineken 600ml', priceCents: 1890, soldOut: false, unit: 'UN' });

    const dupSku = await admin({
      method: 'POST',
      url: '/api/admin/products',
      payload: { categoryId: cervejas, name: 'Outra', priceCents: 100, sku: 'HEI600' },
    });
    expect(dupSku.statusCode).toBe(409);
  });

  it('alterar preço gera auditoria própria; esgotado tem atalho', async () => {
    const created = await admin({
      method: 'POST',
      url: '/api/admin/products',
      payload: { categoryId: porcoes, name: 'Fritas', priceCents: 2990 },
    });
    const p = created.json();
    await admin({ method: 'PUT', url: `/api/admin/products/${p.id}`, payload: { ...p, priceCents: 3290 } });
    await admin({ method: 'PUT', url: `/api/admin/products/${p.id}`, payload: { ...p, priceCents: 3290, description: 'Grande' } });
    const sold = await admin({ method: 'PATCH', url: `/api/admin/products/${p.id}/sold-out`, payload: { soldOut: true } });
    expect(sold.json().soldOut).toBe(true);

    expect(await auditActions('product')).toEqual(
      expect.arrayContaining(['PRODUTO_CRIADO', 'PRODUTO_PRECO_ALTERADO', 'PRODUTO_ALTERADO', 'PRODUTO_ESGOTADO']),
    );
    const [priceLog] = await ctx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'PRODUTO_PRECO_ALTERADO'), eq(auditLogs.entityId, p.id)));
    expect(priceLog).toMatchObject({ beforeJson: { priceCents: 2990 }, afterJson: { priceCents: 3290 } });
  });

  it('não exclui categoria com produtos', async () => {
    const res = await admin({ method: 'DELETE', url: `/api/admin/categories/${cervejas}` });
    expect(res.statusCode).toBe(409);
    const list = (await admin({ method: 'GET', url: '/api/admin/categories' })).json();
    expect(list.find((c: { id: string }) => c.id === cervejas).productCount).toBe(1);
  });
});

describe('impressoras', () => {
  it('lista as impressoras instaladas no Windows e vincula categorias pelos dois lados', async () => {
    ctx.installedPrinters.push({ name: 'ELGIN i9 Bar', driverName: 'ELGIN i9', portName: 'USB001' });
    const installed = await admin({ method: 'GET', url: '/api/admin/printers/installed' });
    expect(installed.json()).toEqual([{ name: 'ELGIN i9 Bar', driverName: 'ELGIN i9', portName: 'USB001' }]);

    const cat = (await admin({ method: 'POST', url: '/api/admin/categories', payload: { name: 'Drinks' } })).json();
    const bar = await admin({
      method: 'POST',
      url: '/api/admin/printers',
      payload: { name: 'Bar', windowsName: 'ELGIN i9 Bar', sectorLabel: 'bar', categoryIds: [cat.id] },
    });
    expect(bar.statusCode).toBe(201);
    expect(bar.json()).toMatchObject({ sectorLabel: 'BAR', installed: true, categoryIds: [cat.id] });

    const cozinha = await admin({
      method: 'POST',
      url: '/api/admin/printers',
      payload: { name: 'Cozinha', windowsName: 'Impressora que sumiu', sectorLabel: 'COZINHA' },
    });
    expect(cozinha.json().installed).toBe(false);

    // Pela tela da categoria: Drinks sai no bar e na cozinha.
    const upd = await admin({
      method: 'PUT',
      url: `/api/admin/categories/${cat.id}`,
      payload: { name: 'Drinks', printerIds: [bar.json().id, cozinha.json().id] },
    });
    expect(upd.json().printerIds).toHaveLength(2);
    const printers = (await admin({ method: 'GET', url: '/api/admin/printers' })).json();
    expect(printers.every((p: { categoryIds: string[] }) => p.categoryIds.includes(cat.id))).toBe(true);
  });
});

describe('mesas', () => {
  it('cria em lote pulando as existentes, com QR aleatório e único', async () => {
    await admin({ method: 'POST', url: '/api/admin/tables', payload: { number: 3 } });
    const res = await admin({ method: 'POST', url: '/api/admin/tables/bulk', payload: { from: 1, to: 5, area: 'Salão' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().skipped).toEqual([3]);
    expect(res.json().created).toHaveLength(4);

    const tables = (await admin({ method: 'GET', url: '/api/admin/tables' })).json();
    expect(tables.map((t: { number: number }) => t.number)).toEqual([1, 2, 3, 4, 5]);
    const tokens = tables.map((t: { qrToken: string }) => t.qrToken);
    expect(new Set(tokens).size).toBe(5);
    expect(tokens.every((t: string) => /^[A-Za-z2-9]{10}$/.test(t))).toBe(true);

    const dup = await admin({ method: 'POST', url: '/api/admin/tables', payload: { number: 2 } });
    expect(dup.json().message).toBe('Já existe uma mesa com esse número.');

    const regen = await admin({ method: 'POST', url: `/api/admin/tables/${tables[0].id}/regenerate-qr` });
    expect(regen.json().qrToken).not.toBe(tables[0].qrToken);
  });
});

describe('usuários', () => {
  it('cria garçom que consegue logar; login repetido dá 409', async () => {
    const res = await admin({
      method: 'POST',
      url: '/api/admin/users',
      payload: { name: 'Ana', login: 'Ana.Souza', role: 'GARCOM', password: 'abc12345', pin: '1234' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ login: 'ana.souza', hasPin: true, active: true });
    expect(res.json()).not.toHaveProperty('passwordHash');

    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'ana.souza', password: 'abc12345' } });
    expect(login.statusCode).toBe(200);

    const dup = await admin({
      method: 'POST',
      url: '/api/admin/users',
      payload: { name: 'Outra', login: 'ana.souza', role: 'CAIXA', password: 'abc12345' },
    });
    expect(dup.statusCode).toBe(409);

    const logs = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, 'USUARIO_CRIADO'));
    expect(JSON.stringify(logs)).not.toContain('passwordHash');
  });

  it('admin não pode se desativar nem tirar o último admin', async () => {
    const list = (await admin({ method: 'GET', url: '/api/admin/users' })).json();
    const me = list.find((u: { login: string }) => u.login === 'admin');
    const self = await admin({ method: 'PUT', url: `/api/admin/users/${me.id}`, payload: { ...me, active: false } });
    expect(self.statusCode).toBe(409);

    // Promove o gerente a admin e tenta rebaixar o único outro admin pelo novo admin.
    const gerente = list.find((u: { login: string }) => u.login === 'gerente');
    await admin({ method: 'PUT', url: `/api/admin/users/${gerente.id}`, payload: { ...gerente, role: 'ADMIN' } });
    const asGerente = await ctx.as('gerente');
    const demote = await asGerente({ method: 'PUT', url: `/api/admin/users/${me.id}`, payload: { ...me, role: 'CAIXA' } });
    expect(demote.statusCode).toBe(200); // ainda sobra o gerente como admin
    const last = await admin({ method: 'GET', url: '/api/admin/users' });
    expect(last.statusCode).toBe(403); // "admin" virou caixa
    const backToGerente = await asGerente({ method: 'PUT', url: `/api/admin/users/${gerente.id}`, payload: { ...gerente, role: 'GERENTE' } });
    expect(backToGerente.statusCode).toBe(409);

    await asGerente({ method: 'PUT', url: `/api/admin/users/${me.id}`, payload: { ...me, role: 'ADMIN' } });
    admin = await ctx.as('admin');
  });

  it('desativar um usuário corta o acesso na hora, mesmo com token de acesso ainda válido', async () => {
    const created = (
      await admin({
        method: 'POST',
        url: '/api/admin/users',
        payload: { name: 'Temp', login: 'temp', role: 'GARCOM', password: 'abc12345' },
      })
    ).json();
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'temp', password: 'abc12345' } });
    const auth = { authorization: `Bearer ${login.json().accessToken}` };
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: auth })).statusCode).toBe(200);

    await admin({ method: 'PUT', url: `/api/admin/users/${created.id}`, payload: { ...created, active: false } });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: auth })).statusCode).toBe(401);
  });

  it('trocar a senha derruba as sessões abertas do usuário', async () => {
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'caixa', password: 'senha-certa' } });
    const refresh = login.cookies.find((c) => c.name === 'sb_refresh')!.value;
    const caixa = (await admin({ method: 'GET', url: '/api/admin/users' })).json().find((u: { login: string }) => u.login === 'caixa');

    await admin({ method: 'PUT', url: `/api/admin/users/${caixa.id}`, payload: { ...caixa, password: 'nova-senha' } });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { sb_refresh: refresh } });
    expect(r.statusCode).toBe(401);
  });
});

describe('configurações', () => {
  it('começa com os padrões e liga a taxa de serviço com auditoria', async () => {
    const initial = (await admin({ method: 'GET', url: '/api/admin/settings' })).json();
    expect(initial).toMatchObject({ serviceFeeEnabled: false, alertYellowMinutes: 15, alertRedMinutes: 30 });

    const saved = await admin({ method: 'PUT', url: '/api/admin/settings', payload: { ...initial, serviceFeeEnabled: true } });
    expect(saved.statusCode).toBe(200);
    expect((await admin({ method: 'GET', url: '/api/admin/settings' })).json().serviceFeeEnabled).toBe(true);
    expect(await auditActions('settings')).toContain('TAXA_SERVICO_LIGADA');

    const invalid = await admin({ method: 'PUT', url: '/api/admin/settings', payload: { ...initial, alertRedMinutes: 5 } });
    expect(invalid.statusCode).toBe(400);
  });
});
