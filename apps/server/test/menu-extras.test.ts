import type { MenuCategory, Product } from '@sistema-bar/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let garcom: Inject;
let cat: string;

const menu = async () => ((await garcom({ method: 'GET', url: '/api/waiter/menu' })).json() as MenuCategory[]).flatMap((c) => c.products);

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  garcom = await ctx.as('garcom');
  cat = (await admin({ method: 'POST', url: '/api/admin/categories', payload: { name: 'Porções' } })).json().id;
});
afterAll(() => ctx.close());

describe('destaques e selos do cardápio', () => {
  it('salva com o produto e aparece no cardápio', async () => {
    const res = await admin({
      method: 'POST',
      url: '/api/admin/products',
      payload: { categoryId: cat, name: 'Tilápia empanada', priceCents: 8900, featured: true, badges: ['MAIS_PEDIDO', 'SERVE_2'] },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as Product;
    expect(created).toMatchObject({ featured: true, badges: ['MAIS_PEDIDO', 'SERVE_2'] });
    await admin({ method: 'POST', url: '/api/admin/products', payload: { categoryId: cat, name: 'Batata frita', priceCents: 3000 } });

    const list = (await admin({ method: 'GET', url: '/api/admin/products' })).json() as Product[];
    expect(list.find((p) => p.name === 'Batata frita')).toMatchObject({ featured: false, badges: [] });
    expect((await menu()).find((p) => p.id === created.id)).toMatchObject({ featured: true, badges: ['MAIS_PEDIDO', 'SERVE_2'] });

    // Tira o destaque e um selo.
    const upd = await admin({
      method: 'PUT',
      url: `/api/admin/products/${created.id}`,
      payload: { categoryId: cat, name: 'Tilápia empanada', priceCents: 8900, featured: false, badges: ['SERVE_2'] },
    });
    expect(upd.json()).toMatchObject({ featured: false, badges: ['SERVE_2'] });
    expect((await menu()).find((p) => p.id === created.id)).toMatchObject({ featured: false, badges: ['SERVE_2'] });
  });

  it('no máximo 3 selos; selo desconhecido é recusado', async () => {
    const base = { categoryId: cat, name: 'Isca de peixe', priceCents: 5000 };
    const four = await admin({ method: 'POST', url: '/api/admin/products', payload: { ...base, badges: ['MAIS_PEDIDO', 'SERVE_2', 'NOVIDADE', 'PICANTE'] } });
    expect(four.statusCode).toBe(400);
    expect(four.json().message).toMatch(/No máximo 3 selos/);
    expect((await admin({ method: 'POST', url: '/api/admin/products', payload: { ...base, badges: ['GRATIS'] } })).statusCode).toBe(400);
  });

  it('produto excluído sai dos destaques', async () => {
    const p = (
      await admin({ method: 'POST', url: '/api/admin/products', payload: { categoryId: cat, name: 'Provisório', priceCents: 100, featured: true, badges: ['NOVIDADE'] } })
    ).json() as Product;
    expect((await admin({ method: 'DELETE', url: `/api/admin/products/${p.id}` })).statusCode).toBe(204);
    const again = (
      await admin({ method: 'POST', url: '/api/admin/products', payload: { categoryId: cat, name: 'Outro', priceCents: 100 } })
    ).json() as Product;
    expect(again).toMatchObject({ featured: false, badges: [] });
  });
});
