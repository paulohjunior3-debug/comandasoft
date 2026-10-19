import { settingsSchema } from '@sistema-bar/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { audit } from '../../lib/audit';
import { getSettings, saveSettings } from '../../lib/settings';

export async function settingsRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/', async () => getSettings(db));

  app.put('/', async (request) => {
    const value = settingsSchema.parse(request.body);
    const before = await getSettings(db);
    await db.transaction(async (tx) => {
      await saveSettings(tx, value);
      const action =
        before.serviceFeeEnabled !== value.serviceFeeEnabled
          ? value.serviceFeeEnabled
            ? 'TAXA_SERVICO_LIGADA'
            : 'TAXA_SERVICO_DESLIGADA'
          : 'CONFIGURACOES_ALTERADAS';
      await audit(tx, request, { action, entity: 'settings', before, after: value });
    });
    return value;
  });
}
