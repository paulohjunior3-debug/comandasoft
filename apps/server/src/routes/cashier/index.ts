import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { lanAddresses } from '../../lib/network';
import { cashierBillRoutes } from './bills';
import { cashierClosedRoutes } from './closed';
import { cashierCounterRoutes } from './counter';
import { cashierCouvertRoutes } from './couvert';
import { cashierFinalizeRoutes } from './finalize';
import { cashierItemRoutes } from './items';
import { cashierPaymentRoutes } from './payments';
import { cashSessionRoutes } from './session';

/** Caixa (SPEC 5.7): caixa e gerente (admin também). */
export async function cashierRoutes(app: FastifyInstance, deps: AppDeps) {
  app.addHook('preHandler', deps.guards.requireRole('CAIXA', 'GERENTE'));
  await app.register((r) => cashSessionRoutes(r, deps), { prefix: '/session' });
  await app.register((r) => cashierBillRoutes(r, deps));
  await app.register((r) => cashierPaymentRoutes(r, deps), { prefix: '/payments' });
  await app.register((r) => cashierFinalizeRoutes(r, deps));
  await app.register((r) => cashierItemRoutes(r, deps));
  await app.register((r) => cashierCounterRoutes(r, deps));
  await app.register((r) => cashierCouvertRoutes(r, deps), { prefix: '/couvert' });
  await app.register((r) => cashierClosedRoutes(r, deps));
  /** IPs deste PC na rede, para o QR que leva os celulares da equipe à página /certificado. */
  app.get('/lan-addresses', async () => ({ addresses: lanAddresses() }));
}
