import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { migrationsFolder, type Db } from '../src/db/client';
import * as schema from '../src/db/schema';
import { REFRESH_COOKIE } from '../src/routes/auth';

let app: FastifyInstance;
let pg: PGlite;

function refreshCookieOf(res: { cookies: { name: string; value: string }[] }) {
  return res.cookies.find((c) => c.name === REFRESH_COOKIE)?.value;
}

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg, { schema, casing: 'snake_case' });
  await migrate(db, { migrationsFolder });
  await db.insert(schema.users).values([
    { name: 'Maria', login: 'maria', passwordHash: await hashPassword('senha-certa'), role: 'GARCOM' },
    { name: 'Inativo', login: 'inativo', passwordHash: await hashPassword('senha-certa'), role: 'CAIXA', active: false },
  ]);
  app = await buildApp({ db: db as Db, jwtSecret: 'x'.repeat(32), webDist: false });
});

afterAll(async () => {
  await app.close();
  await pg.close();
});

const login = (login: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password } });

describe('auth', () => {
  it('health responde com o banco ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
  });

  it('login válido devolve access token, usuário e cookie de refresh httpOnly', async () => {
    const res = await login('Maria', 'senha-certa');
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ login: 'maria', role: 'GARCOM' });
    const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/api/auth' });
  });

  it('senha errada, usuário inexistente e inativo dão 401 com a mesma mensagem', async () => {
    for (const res of [await login('maria', 'errada'), await login('ninguem', 'x'), await login('inativo', 'senha-certa')]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toBe('Usuário ou senha inválidos.');
    }
  });

  it('corpo inválido dá 400 com mensagem em português', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION');
  });

  it('/me exige token válido', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    const bad = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: 'Bearer lixo' } });
    expect(bad.statusCode).toBe(401);

    const { accessToken } = (await login('maria', 'senha-certa')).json();
    const ok = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${accessToken}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.name).toBe('Maria');
  });

  it('refresh rotaciona o token; reapresentar o antigo derruba todas as sessões', async () => {
    const first = refreshCookieOf(await login('maria', 'senha-certa'))!;

    const r1 = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { [REFRESH_COOKIE]: first } });
    expect(r1.statusCode).toBe(200);
    const second = refreshCookieOf(r1)!;
    expect(second).not.toBe(first);

    const reuse = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { [REFRESH_COOKIE]: first } });
    expect(reuse.statusCode).toBe(401);

    const afterTheft = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { [REFRESH_COOKIE]: second } });
    expect(afterTheft.statusCode).toBe(401);
  });

  it('logout revoga o refresh token', async () => {
    const token = refreshCookieOf(await login('maria', 'senha-certa'))!;
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { [REFRESH_COOKIE]: token } });
    expect(out.statusCode).toBe(204);
    const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { [REFRESH_COOKIE]: token } });
    expect(r.statusCode).toBe(401);
  });

  it('rota desconhecida da API dá 404 em JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nao-existe' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');
  });
});
