import type { AuthUser, Role } from '@sistema-bar/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TokenService } from './tokens';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function createGuards(tokens: TokenService) {
  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
      return reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'Faça login para continuar.' });
    }
    try {
      request.user = await tokens.verifyAccess(token);
    } catch {
      return reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'Sessão expirada.' });
    }
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
