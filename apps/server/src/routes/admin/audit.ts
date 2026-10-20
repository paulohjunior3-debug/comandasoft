import { AUDIT_ACTIONS, auditActionsOf, auditQuerySchema, localDayRange, type AuditOptions, type AuditPage } from '@sistema-bar/shared';
import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { auditLogs, users } from '../../db/schema';

/**
 * Consulta da auditoria (SPEC 5.10), só leitura: o registro é imutável, não há rota que altere
 * ou apague. Filtros por período, usuário, grupo/ação, ações sensíveis e texto livre.
 */
export async function auditRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/', async (request): Promise<AuditPage> => {
    const q = auditQuerySchema.parse(request.query);
    const { start, end } = localDayRange(q.from, q.to);
    const where: (SQL | undefined)[] = [gte(auditLogs.at, start), lt(auditLogs.at, end)];
    if (q.userId) where.push(eq(auditLogs.userId, q.userId));
    if (q.action) where.push(eq(auditLogs.action, q.action));
    else if (q.group) where.push(inArray(auditLogs.action, auditActionsOf(q.group)));
    if (q.sensitive) {
      where.push(inArray(auditLogs.action, Object.entries(AUDIT_ACTIONS).filter(([, a]) => a.sensitive).map(([k]) => k)));
    }
    if (q.q) {
      const like = `%${q.q.replace(/[\%_]/g, (c) => `\${c}`)}%`;
      where.push(
        sql`(coalesce(${auditLogs.beforeJson}::text, '') || ' ' || coalesce(${auditLogs.afterJson}::text, '') || ' ' || coalesce(${auditLogs.entityId}, '') || ' ' || coalesce(${users.name}, '')) ilike ${like}`,
      );
    }
    if (q.before) {
      const [cursor] = await db.select({ at: auditLogs.at }).from(auditLogs).where(eq(auditLogs.id, q.before));
      if (cursor) where.push(or(lt(auditLogs.at, cursor.at), and(eq(auditLogs.at, cursor.at), lt(auditLogs.id, q.before))));
    }

    const rows = await db
      .select({ log: auditLogs, userName: users.name, userRole: users.role })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .where(and(...where))
      .orderBy(desc(auditLogs.at), desc(auditLogs.id))
      .limit(q.limit + 1);

    const page = rows.slice(0, q.limit);
    return {
      entries: page.map(({ log, userName, userRole }) => ({
        id: log.id,
        at: log.at.toISOString(),
        userId: log.userId,
        userName,
        userRole,
        action: log.action,
        entity: log.entity,
        entityId: log.entityId,
        before: log.beforeJson,
        after: log.afterJson,
        ip: log.ip,
      })),
      nextBefore: rows.length > q.limit ? page.at(-1)!.log.id : null,
    };
  });

  app.get('/options', async (): Promise<AuditOptions> => {
    const [people, actions] = await Promise.all([
      db.select({ id: users.id, name: users.name, role: users.role, active: users.active }).from(users).orderBy(asc(users.name)),
      db.selectDistinct({ action: auditLogs.action }).from(auditLogs).orderBy(asc(auditLogs.action)),
    ]);
    return { users: people, actions: actions.map((a) => a.action) };
  });
}
