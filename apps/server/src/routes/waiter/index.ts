import type { MenuCategory } from '@sistema-bar/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { categories, products } from '../../db/schema';
import { waiterComandaRoutes } from './comandas';
import { waiterOrderRoutes } from './orders';
import { waiterTableRoutes } from './tables';

/** App do garçom (SPEC 5.3). Gerente e admin também podem lançar. */
export async function waiterRoutes(app: FastifyInstance, deps: AppDeps) {
  app.addHook('preHandler', deps.guards.requireRole('GARCOM', 'GERENTE'));

  /** Cardápio ativo agrupado por categoria, para lançar pedidos (e para o cache offline). */
  app.get('/menu', async (): Promise<MenuCategory[]> => {
    const rows = await deps.db
      .select({ category: categories, product: products })
      .from(products)
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .where(and(eq(products.active, true), eq(categories.active, true)))
      .orderBy(asc(categories.sortOrder), asc(categories.name), asc(products.name));

    const menu = new Map<string, MenuCategory>();
    for (const { category: c, product: p } of rows) {
      let entry = menu.get(c.id);
      if (!entry) {
        entry = { id: c.id, name: c.name, color: c.color, products: [] };
        menu.set(c.id, entry);
      }
      entry.products.push({ id: p.id, name: p.name, description: p.description, priceCents: p.priceCents, soldOut: p.soldOut });
    }
    return [...menu.values()];
  });

  await app.register((r) => waiterTableRoutes(r, deps), { prefix: '/tables' });
  await app.register((r) => waiterComandaRoutes(r, deps), { prefix: '/comandas' });
  await app.register((r) => waiterOrderRoutes(r, deps), { prefix: '/orders' });
}
