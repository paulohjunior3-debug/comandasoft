import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { auditRoutes } from './audit';
import { categoryRoutes } from './categories';
import { fiscalRoutes } from './fiscal';
import { adminLicenseRoutes } from './license';
import { printerRoutes } from './printers';
import { productRoutes } from './products';
import { registerRoutes } from './registers';
import { reportRoutes } from './reports';
import { settingsRoutes } from './settings';
import { tableRoutes } from './tables';
import { userRoutes } from './users';

/** Painel administrativo: somente perfil ADMIN (SPEC 4). */
export async function adminRoutes(app: FastifyInstance, deps: AppDeps) {
  app.addHook('preHandler', deps.guards.requireRole());

  await app.register((r) => categoryRoutes(r, deps), { prefix: '/categories' });
  await app.register((r) => productRoutes(r, deps), { prefix: '/products' });
  await app.register((r) => tableRoutes(r, deps), { prefix: '/tables' });
  await app.register((r) => printerRoutes(r, deps), { prefix: '/printers' });
  await app.register((r) => userRoutes(r, deps), { prefix: '/users' });
  await app.register((r) => registerRoutes(r, deps), { prefix: '/registers' });
  await app.register((r) => settingsRoutes(r, deps), { prefix: '/settings' });
  await app.register((r) => reportRoutes(r, deps), { prefix: '/reports' });
  await app.register((r) => auditRoutes(r, deps), { prefix: '/audit' });
  await app.register((r) => fiscalRoutes(r, deps), { prefix: '/fiscal' });
  await app.register((r) => adminLicenseRoutes(r, deps), { prefix: '/license' });
}
