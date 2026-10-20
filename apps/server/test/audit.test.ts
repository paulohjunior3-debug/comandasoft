import { localDate, type AuditOptions, type AuditPage } from '@sistema-bar/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let caixa: Inject;
const today = localDate(new Date());

const audit = async (qs: string): Promise<AuditPage> => (await admin({ method: 'GET', url: `/api/admin/audit?from=${today}&to=${today}&${qs}` })).json();

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  caixa = await ctx.as('caixa');
  // Uma senha errada, um produto cadastrado e o preço dele alterado.
  await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'garcom', password: 'errada-123' } });
  const cat = (await admin({ method: 'POST', url: '/api/admin/categories', payload: { name: 'Cervejas' } })).json().id;
  const p = (await admin({ method: 'POST', url: '/api/admin/products', payload: { categoryId: cat, name: 'Heineken', priceCents: 1500 } })).json();
  await admin({ method: 'PUT', url: `/api/admin/products/${p.id}`, payload: { ...p, priceCents: 1800 } });
});
afterAll(() => ctx.close());

describe('auditoria', () => {
  it('lista do mais recente para o mais antigo, com quem fez', async () => {
    const page = await audit('');
    expect(page.entries[0]!.action).toBe('PRODUTO_PRECO_ALTERADO');
    expect(page.entries[0]!.userName).toBe('admin');
    expect(page.entries[0]).toMatchObject({ before: { priceCents: 1500 }, after: { priceCents: 1800 } });
    const actions = page.entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['LOGIN', 'LOGIN_FALHOU', 'CATEGORIA_CRIADA', 'PRODUTO_CRIADO']));
  });

  it('filtra por tipo, ação, usuário, sensíveis e texto', async () => {
    expect((await audit('group=ACESSO')).entries.every((e) => e.action.startsWith('LOGIN'))).toBe(true);
    expect((await audit('action=LOGIN_FALHOU')).entries).toHaveLength(1);
    const sensitive = (await audit('sensitive=1')).entries.map((e) => e.action);
    expect(sensitive).toContain('PRODUTO_PRECO_ALTERADO');
    expect(sensitive).toContain('LOGIN_FALHOU');
    expect(sensitive).not.toContain('PRODUTO_CRIADO');
    expect((await audit('q=heineken')).entries.map((e) => e.action).sort()).toEqual(['PRODUTO_CRIADO', 'PRODUTO_PRECO_ALTERADO']);
    expect((await audit('q=100%25')).entries).toEqual([]); // "%" é texto, não curinga

    const options: AuditOptions = (await admin({ method: 'GET', url: '/api/admin/audit/options' })).json();
    const garcom = options.users.find((u) => u.name === 'garcom')!;
    expect((await audit(`userId=${garcom.id}`)).entries.map((e) => e.action)).toEqual(['LOGIN_FALHOU']);
    expect(options.actions).toContain('PRODUTO_PRECO_ALTERADO');
  });

  it('pagina com "carregar mais" sem repetir registros', async () => {
    const all = (await audit('limit=500')).entries.map((e) => e.id);
    const first = await audit('limit=2');
    expect(first.entries).toHaveLength(2);
    expect(first.nextBefore).toBe(first.entries[1]!.id);
    const second = await audit(`limit=2&before=${first.nextBefore}`);
    expect([...first.entries, ...second.entries].map((e) => e.id)).toEqual(all.slice(0, 4));
  });

  it('dia sem registros vem vazio; datas inválidas em português', async () => {
    const empty: AuditPage = (await admin({ method: 'GET', url: '/api/admin/audit?from=2020-01-01&to=2020-01-02' })).json();
    expect(empty).toEqual({ entries: [], nextBefore: null });
    expect((await admin({ method: 'GET', url: '/api/admin/audit?from=2026-02-10&to=2026-02-01' })).json().message).toBe('A data inicial é depois da final.');
  });

  it('só o admin consulta, e ninguém altera ou apaga o registro', async () => {
    expect((await caixa({ method: 'GET', url: `/api/admin/audit?from=${today}&to=${today}` })).statusCode).toBe(403);
    const id = (await audit('limit=1')).entries[0]!.id;
    for (const method of ['DELETE', 'PUT', 'PATCH'] as const) {
      expect((await admin({ method, url: `/api/admin/audit/${id}`, payload: {} })).statusCode).toBe(404);
    }
  });
});
