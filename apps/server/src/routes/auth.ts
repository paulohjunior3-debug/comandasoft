import { loginRequestSchema, type AuthResponse, type AuthUser } from '@sistema-bar/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app';
import { burnPasswordCheck, verifyPassword } from '../auth/password';
import { hashRefreshToken, newRefreshToken, REFRESH_TOKEN_TTL_MS } from '../auth/tokens';
import { auditLogs, refreshTokens, users } from '../db/schema';

export const REFRESH_COOKIE = 'sb_refresh';
const COOKIE_PATH = '/api/auth';

const toAuthUser = (u: typeof users.$inferSelect): AuthUser => ({
  id: u.id,
  name: u.name,
  login: u.login,
  role: u.role,
});

export async function authRoutes(app: FastifyInstance, { db, tokens, guards }: AppDeps) {
  async function issueSession(request: FastifyRequest, reply: FastifyReply, user: AuthUser) {
    const { token, tokenHash } = newRefreshToken();
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      userAgent: request.headers['user-agent']?.slice(0, 255),
    });
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: REFRESH_TOKEN_TTL_MS / 1000,
    });
    const body: AuthResponse = { accessToken: await tokens.signAccess(user), user };
    return body;
  }

  const expired = (reply: FastifyReply, message = 'Sessão expirada.') => {
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
    return reply.code(401).send({ error: 'UNAUTHENTICATED', message });
  };

  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { login, password } = loginRequestSchema.parse(request.body);
      const [user] = await db.select().from(users).where(eq(users.login, login.toLowerCase()));

      if (!user || !user.active) {
        await burnPasswordCheck(password);
        return expired(reply, 'Usuário ou senha inválidos.');
      }
      if (!(await verifyPassword(user.passwordHash, password))) {
        await db.insert(auditLogs).values({ userId: user.id, action: 'LOGIN_FALHOU', ip: request.ip });
        return expired(reply, 'Usuário ou senha inválidos.');
      }

      await db.insert(auditLogs).values({ userId: user.id, action: 'LOGIN', ip: request.ip });
      return issueSession(request, reply, toAuthUser(user));
    },
  );

  app.post(
    '/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const token = request.cookies[REFRESH_COOKIE];
      if (!token) return expired(reply);

      const [stored] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashRefreshToken(token)));
      if (!stored || stored.expiresAt <= new Date()) return expired(reply);

      if (stored.revokedAt) {
        // Token já usado sendo reapresentado: possível roubo. Derruba todas as sessões do usuário.
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.userId, stored.userId), isNull(refreshTokens.revokedAt)));
        await db
          .insert(auditLogs)
          .values({ userId: stored.userId, action: 'REFRESH_REUTILIZADO', ip: request.ip });
        return expired(reply);
      }

      const [user] = await db.select().from(users).where(eq(users.id, stored.userId));
      if (!user || !user.active) return expired(reply);

      // Rotação: cada refresh token vale uma única vez. O WHERE evita corrida entre duas abas.
      const rotated = await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(refreshTokens.id, stored.id),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, new Date()),
          ),
        )
        .returning({ id: refreshTokens.id });
      if (rotated.length === 0) return expired(reply);

      return issueSession(request, reply, toAuthUser(user));
    },
  );

  app.post('/logout', async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (token) {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.tokenHash, hashRefreshToken(token)), isNull(refreshTokens.revokedAt)));
    }
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: guards.authenticate }, async (request) => ({ user: request.user! }));
}
