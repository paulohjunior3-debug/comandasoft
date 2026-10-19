import { userCreateSchema, userUpdateSchema, type AdminUser } from '@sistema-bar/shared';
import { and, asc, count, eq, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { hashPassword } from '../../auth/password';
import { refreshTokens, users } from '../../db/schema';
import { audit, redact } from '../../lib/audit';
import { HttpError, notFound } from '../../lib/errors';
import { idParams } from './params';

const toAdminUser = (u: typeof users.$inferSelect): AdminUser => ({
  id: u.id,
  name: u.name,
  login: u.login,
  role: u.role,
  active: u.active,
  hasPin: u.pinHash !== null,
  createdAt: u.createdAt.toISOString(),
});

// Usuários não são excluídos (aparecem na auditoria e nos pedidos): são desativados.
export async function userRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/', async () => {
    const rows = await db.select().from(users).orderBy(asc(users.name));
    return rows.map(toAdminUser);
  });

  app.post('/', async (request, reply) => {
    const { password, pin, ...data } = userCreateSchema.parse(request.body);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          ...data,
          passwordHash: await hashPassword(password),
          pinHash: pin ? await hashPassword(pin) : null,
        })
        .returning();
      await audit(tx, request, { action: 'USUARIO_CRIADO', entity: 'user', entityId: created!.id, after: redact(created!) });
      return created!;
    });
    return reply.code(201).send(toAdminUser(row));
  });

  app.put('/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const { password, pin, clearPin, ...data } = userUpdateSchema.parse(request.body);
    const [before] = await db.select().from(users).where(eq(users.id, id));
    if (!before) throw notFound('Usuário');

    const self = request.user!.id === id;
    if (self && (!data.active || data.role !== before.role)) {
      throw new HttpError(409, 'SELF_LOCKOUT', 'Você não pode desativar nem mudar o perfil do seu próprio usuário.');
    }
    const losesAdmin = before.role === 'ADMIN' && before.active && (data.role !== 'ADMIN' || !data.active);
    if (losesAdmin) {
      const [{ n }] = (await db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.role, 'ADMIN'), eq(users.active, true), ne(users.id, id)))) as [{ n: number }];
      if (n === 0) throw new HttpError(409, 'LAST_ADMIN', 'É preciso manter pelo menos um administrador ativo.');
    }

    const changes: Partial<typeof users.$inferInsert> = { ...data };
    if (password) changes.passwordHash = await hashPassword(password);
    if (pin) changes.pinHash = await hashPassword(pin);
    else if (clearPin) changes.pinHash = null;

    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(users).set(changes).where(eq(users.id, id)).returning();
      // Senha trocada ou usuário desativado: derruba as sessões abertas nos aparelhos.
      if (password || !data.active) {
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.userId, id), isNull(refreshTokens.revokedAt)));
      }
      await audit(tx, request, {
        action: password ? 'USUARIO_ALTERADO_SENHA' : 'USUARIO_ALTERADO',
        entity: 'user',
        entityId: id,
        before: redact(before),
        after: redact(updated!),
      });
      return updated!;
    });
    return toAdminUser(row);
  });
}
