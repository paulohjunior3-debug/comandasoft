import type { PublicTableInfo } from '@sistema-bar/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPublicApp } from '../src/public-app';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let pub: FastifyInstance;
let admin: Inject;
let caixa: Inject;
let product: Record<string, unknown> & { id: string };
let qr: string;
// PNG de 1×1 pixel.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

beforeAll(async () => {
  ctx = await createTestContext();
  pub = await buildPublicApp({ db: ctx.db, jwtSecret: 'x'.repeat(32), webDist: false });
  admin = await ctx.as('admin');
  caixa = await ctx.as('caixa');
  const cat = (await admin({ method: 'POST', url: '/api/admin/categories', payload: { name: 'Porções' } })).json().id;
  product = (await admin({ method: 'POST', url: '/api/admin/products', payload: { categoryId: cat, name: 'Batata frita', priceCents: 3290 } })).json();
  qr = ((await admin({ method: 'POST', url: '/api/admin/tables/bulk', payload: { from: 1, to: 1 } })).json().created as { qrToken: string }[])[0]!.qrToken;
});
afterAll(async () => {
  await pub.close();
  await ctx.close();
});

describe('foto do produto', () => {
  it('só o admin envia, e só imagem', async () => {
    const url = `/api/admin/products/${product.id}/image`;
    expect((await caixa({ method: 'PUT', url, payload: { dataUrl: `data:image/png;base64,${PNG}` } })).statusCode).toBe(403);
    const bad = await admin({ method: 'PUT', url, payload: { dataUrl: 'data:text/html;base64,PGgxPg==' } });
    expect(bad.json().message).toBe('Envie uma imagem JPG, PNG ou WebP.');
  });

  it('guarda, entrega em /fotos nos dois servidores e aparece no cardápio do cliente', async () => {
    const res = await admin({ method: 'PUT', url: `/api/admin/products/${product.id}/image`, payload: { dataUrl: `data:image/png;base64,${PNG}` } });
    expect(res.statusCode).toBe(200);
    const { imageUrl } = res.json() as { imageUrl: string };
    expect(imageUrl).toMatch(new RegExp(`^/fotos/${product.id}\\?v=\\d+$`));

    for (const app of [ctx.app, pub]) {
      const img = await app.inject({ method: 'GET', url: imageUrl });
      expect(img.statusCode).toBe(200);
      expect(img.headers['content-type']).toBe('image/png');
      expect(img.headers['cache-control']).toContain('immutable');
      expect(img.rawPayload.equals(Buffer.from(PNG, 'base64'))).toBe(true);
      const again = await app.inject({ method: 'GET', url: imageUrl, headers: { 'if-none-match': String(img.headers.etag) } });
      expect(again.statusCode).toBe(304);
    }

    const menu: PublicTableInfo = (await pub.inject({ method: 'GET', url: `/api/public/m/${qr}` })).json();
    expect(menu.menu[0]!.products[0]!.imageUrl).toBe(imageUrl);
  });

  it('editar o produto pelo formulário não apaga a foto', async () => {
    const before = (await admin({ method: 'GET', url: '/api/admin/products' })).json()[0];
    const { id: _id, imageUrl: _img, ...form } = before;
    await admin({ method: 'PUT', url: `/api/admin/products/${product.id}`, payload: { ...form, priceCents: 3490 } });
    const after = (await admin({ method: 'GET', url: '/api/admin/products' })).json()[0];
    expect(after.priceCents).toBe(3490);
    expect(after.imageUrl).toBe(before.imageUrl);
  });

  it('remover a foto tira do cardápio e da entrega', async () => {
    const { imageUrl } = (await admin({ method: 'GET', url: '/api/admin/products' })).json()[0];
    expect((await admin({ method: 'DELETE', url: `/api/admin/products/${product.id}/image` })).statusCode).toBe(204);
    expect((await pub.inject({ method: 'GET', url: imageUrl })).statusCode).toBe(404);
    expect((await admin({ method: 'GET', url: '/api/admin/products' })).json()[0].imageUrl).toBeNull();
  });
});
