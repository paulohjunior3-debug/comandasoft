import { createHash, randomBytes } from 'node:crypto';
import { roleSchema, type AuthUser } from '@sistema-bar/shared';
import { jwtVerify, SignJWT } from 'jose';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Leitura da comanda pelo QR da mesa: curta, só daquela comanda (SPEC 5.6). */
export const QR_TOKEN_TTL_SECONDS = 2 * 60 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createTokenService(secret: string) {
  const key = new TextEncoder().encode(secret);

  return {
    signAccess(user: AuthUser): Promise<string> {
      return new SignJWT({ name: user.name, login: user.login, role: user.role })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.id)
        .setIssuedAt()
        .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
        .sign(key);
    },

    signQr(comandaId: string): Promise<string> {
      return new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience('qr')
        .setSubject(comandaId)
        .setIssuedAt()
        .setExpirationTime(`${QR_TOKEN_TTL_SECONDS}s`)
        .sign(key);
    },

    /** Devolve o id da comanda liberada pelo PIN. Token de funcionário não serve aqui (audience). */
    async verifyQr(token: string): Promise<string> {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'], audience: 'qr' });
      return String(payload.sub);
    },

    async verifyAccess(token: string): Promise<AuthUser> {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
      return {
        id: String(payload.sub),
        name: String(payload.name),
        login: String(payload.login),
        role: roleSchema.parse(payload.role),
      };
    },
  };
}

export type TokenService = ReturnType<typeof createTokenService>;

/** Refresh token opaco: só o hash fica no banco. */
export function newRefreshToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
