import type { LicenseBannerInfo } from '@sistema-bar/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';

/** Estado resumido da licença para as faixas de aviso (qualquer perfil logado). */
export async function licenseRoutes(app: FastifyInstance, { guards, license }: AppDeps) {
  app.addHook('preHandler', guards.authenticate);
  app.get('/status', async (): Promise<LicenseBannerInfo> => license.banner());
}
