import type { MenuCategory } from '@sistema-bar/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { loadMenu } from '../../lib/menu';
import { waiterComandaRoutes } from './comandas';
import { waiterOrderRoutes } from './orders';
import { waiterTableRoutes } from './tables';

/** App do garçom (SPEC 5.3). Gerente e admin também podem lançar. */
export async function waiterRoutes(app: FastifyInstance, deps: AppDeps) {
  app.addHook('preHandler', deps.guards.requireRole('GARCOM', 'GERENTE'));

  /** Cardápio ativo agrupado por categoria, para lançar pedidos (e para o cache offline). */
  app.get('/menu', async (): Promise<MenuCategory[]> => loadMenu(deps.db));

  await app.register((r) => waiterTableRoutes(r, deps), { prefix: '/tables' });
  await app.register((r) => waiterComandaRoutes(r, deps), { prefix: '/comandas' });
  await app.register((r) => waiterOrderRoutes(r, deps), { prefix: '/orders' });
}
