import { formatBRL, formatLocalTime, startCouvertSchema, stopCouvertSchema, type CouvertWindow } from '@sistema-bar/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { couvertWindows } from '../../db/schema';
import { audit } from '../../lib/audit';
import { authorizeManager } from '../../lib/authorize';
import { couvertWindowsOf, getDayRules } from '../../lib/day-rules';
import { HttpError } from '../../lib/errors';
import { getSettings } from '../../lib/settings';

/**
 * Couvert por show: o gerente inicia quando o show começa e encerra quando acaba (quantas vezes
 * precisar no dia). Quem abre comanda com o couvert ativo paga; quem já estava paga se continuar
 * na mesa 15 min depois do início. Perfil Caixa precisa do PIN de gerente/admin.
 */
export async function cashierCouvertRoutes(app: FastifyInstance, { db }: AppDeps) {
  async function today() {
    const rules = await getDayRules(db);
    if (!rules) throw new HttpError(409, 'NO_OPEN_SESSION', 'Abra o caixa antes de iniciar o couvert.');
    return rules;
  }

  app.get('/', async () => {
    const rules = await getDayRules(db);
    const settings = await getSettings(db);
    const windows: CouvertWindow[] = rules ? rules.couvertWindows : [];
    return {
      businessDate: rules?.businessDate ?? null,
      windows,
      active: windows.find((w) => !w.endAt && Date.parse(w.startAt) <= Date.now()) ?? null,
      scheduled: windows.find((w) => !w.endAt && Date.parse(w.startAt) > Date.now()) ?? null,
      defaultCents: settings.couvertCents,
      mode: settings.couvertMode,
    };
  });

  app.post('/start', async (request) => {
    const { amountCents, authorizerPin } = startCouvertSchema.parse(request.body);
    const rules = await today();
    const open = rules.couvertWindows.find((w) => !w.endAt);
    if (open) {
      throw new HttpError(
        409,
        'COUVERT_ACTIVE',
        Date.parse(open.startAt) > Date.now()
          ? `Já há um couvert programado para ${formatLocalTime(open.startAt)}. Encerre-o antes de iniciar outro.`
          : `O couvert já está ativo desde ${formatLocalTime(open.startAt)}.`,
      );
    }
    const authorizer = await authorizeManager(db, request, authorizerPin);
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(couvertWindows).values({ businessDate: rules.businessDate, amountCents, startAt: now, startedBy: request.user!.id });
      await audit(tx, request, {
        action: 'COUVERT_INICIADO',
        entity: 'couvert',
        after: { amountCents, desde: formatLocalTime(now), authorizedBy: authorizer.name },
      });
    });
    return { windows: await couvertWindowsOf(db, rules.businessDate) };
  });

  app.post('/stop', async (request) => {
    const { authorizerPin } = stopCouvertSchema.parse(request.body ?? {});
    const rules = await today();
    const open = rules.couvertWindows.find((w) => !w.endAt);
    if (!open) throw new HttpError(409, 'COUVERT_NOT_ACTIVE', 'Não há couvert ativo para encerrar.');
    const authorizer = await authorizeManager(db, request, authorizerPin);
    const now = new Date();
    // Programado e ainda não começou: encerrar = cancelar (fim = início, não cobra ninguém).
    const end = Date.parse(open.startAt) > now.getTime() ? new Date(open.startAt) : now;
    await db.transaction(async (tx) => {
      await tx
        .update(couvertWindows)
        .set({ endAt: end, endedBy: request.user!.id })
        .where(and(eq(couvertWindows.id, open.id), isNull(couvertWindows.endAt)));
      await audit(tx, request, {
        action: 'COUVERT_ENCERRADO',
        entity: 'couvert',
        after: { amountCents: open.amountCents, valor: formatBRL(open.amountCents), de: formatLocalTime(open.startAt), ate: formatLocalTime(end), authorizedBy: authorizer.name },
      });
    });
    return { windows: await couvertWindowsOf(db, rules.businessDate) };
  });
}
