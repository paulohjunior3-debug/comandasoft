import type { AuthUser, Role } from '@sistema-bar/shared';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client';
import { users } from '../db/schema';
import type { TokenService } from './tokens';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function createGuards(tokens: TokenService, db: Db) {
  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
      return reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'Faça login para continuar.' });
    }
    let claims: AuthUser;
    try {
      claims = await tokens.verifyAccess(token);
    } catch {
      return reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'Sessão expirada.' });
    }
    // Perfil e status vêm do banco a cada requisição: desativar ou rebaixar alguém vale na hora,
    // sem esperar o token de acesso expirar.
    const [current] = await db
      .select({ id: users.id, name: users.name, login: users.login, role: users.role, active: users.active })
      .from(users)
      .where(eq(users.id, claims.id));
    if (!current?.active) {
      return reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'Sessão expirada.' });
    }
    request.user = { id: current.id, name: current.name, login: current.login, role: current.role };
  }

  /** Admin sempre passa; os demais perfis precisam estar na lista. */
  function requireRole(...roles: Role[]) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      await authenticate(request, reply);
      if (reply.sent) return;
      const role = request.user!.role;
      if (role !== 'ADMIN' && !roles.includes(role)) {
        return reply.code(403).send({ error: 'FORBIDDEN', message: 'Sem permissão para esta ação.' });
      }
    };
  }

  return { authenticate, requireRole };
}

export type Guards = ReturnType<typeof createGuards>;
