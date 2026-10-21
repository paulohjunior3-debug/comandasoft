import { installLicenseSchema, type LicenseRenewal, type LicenseStatus } from '@sistema-bar/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';

/** Administração › Licença: ver o estado, colar licença ou lease e renovar na hora. */
export async function adminLicenseRoutes(app: FastifyInstance, { license }: AppDeps) {
  app.get('/', async (): Promise<LicenseStatus> => license.status());

  app.post('/', async (request): Promise<LicenseStatus> => {
    const { token } = installLicenseSchema.parse(request.body);
    return license.install(token, request);
  });

  app.post('/renew', async (request): Promise<{ renewal: LicenseRenewal; status: LicenseStatus }> => {
    const renewal = await license.renew(request);
    return { renewal, status: await license.status() };
  });
}
