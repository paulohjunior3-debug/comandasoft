/**
 * Servidor de licenças (Cloudflare Worker). Renova o lease de quem está ativo; o dono suspende e
 * reativa clientes pelo CLI (`pnpm licenca suspender <id>`). Implantação: servidor-licencas/LEIA-ME.md.
 *
 *   POST /renovar                         { licencaId, maquina, versao } → { lease }
 *   GET  /admin/clientes                  (Authorization: Bearer TOKEN_ADMIN)
 *   PUT  /admin/clientes/:id              { cliente, cnpj, maquina } (cadastra ou atualiza; fica ativo)
 *   POST /admin/clientes/:id/suspender    POST /admin/clientes/:id/reativar
 */
import { importPrivateKey, signToken } from './token';

/** O pedaço do KV do Cloudflare que o Worker usa (os testes passam um falso). */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

export interface WorkerEnv {
  LICENCAS: KvLike;
  /** Chave privada de renovação (PKCS#8 em base64url), gerada pelo `pnpm licenca chaves`. */
  CHAVE_RENOVACAO: string;
  TOKEN_ADMIN: string;
  DIAS_LEASE?: string;
}

export interface ClientRecord {
  id: string;
  cliente: string;
  cnpj: string;
  maquina: string | null;
  ativo: boolean;
  atualizadoEm: string;
  ultimaRenovacao: { em: string; versao: string | null } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const fail = (status: number, error: string, message: string) => json({ error, message }, status);

/** Comparação em tempo constante do token do dono. */
function sameSecret(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const keyOf = (id: string) => `cliente:${id}`;

async function getClient(env: WorkerEnv, id: string): Promise<ClientRecord | null> {
  const raw = await env.LICENCAS.get(keyOf(id));
  return raw ? (JSON.parse(raw) as ClientRecord) : null;
}

const putClient = (env: WorkerEnv, record: ClientRecord) => env.LICENCAS.put(keyOf(record.id), JSON.stringify(record));

async function renew(request: Request, env: WorkerEnv, now: Date): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { licencaId?: unknown; maquina?: unknown; versao?: unknown } | null;
  if (!body || typeof body.licencaId !== 'string') return fail(400, 'VALIDATION', 'Pedido de renovação inválido.');
  const record = await getClient(env, body.licencaId);
  if (!record) return fail(404, 'LICENCA_DESCONHECIDA', 'Licença não cadastrada no servidor de licenças.');
  if (!record.ativo) return fail(403, 'LICENCA_SUSPENSA', 'Licença suspensa. Fale com o suporte.');
  if (record.maquina && record.maquina !== body.maquina) {
    return fail(403, 'MAQUINA_DIFERENTE', 'A licença é de outro computador.');
  }
  const days = Number(env.DIAS_LEASE) || 15;
  const lease = await signToken(
    {
      tipo: 'lease',
      licencaId: record.id,
      maquina: record.maquina,
      emitidoEm: now.toISOString(),
      validoAte: new Date(now.getTime() + days * DAY_MS).toISOString(),
    },
    await importPrivateKey(env.CHAVE_RENOVACAO),
  );
  await putClient(env, {
    ...record,
    ultimaRenovacao: { em: now.toISOString(), versao: typeof body.versao === 'string' ? body.versao : null },
  });
  return json({ lease });
}

async function admin(request: Request, env: WorkerEnv, path: string[], now: Date): Promise<Response> {
  const auth = request.headers.get('authorization') ?? '';
  if (!sameSecret(auth.replace(/^Bearer /, ''), env.TOKEN_ADMIN)) return fail(401, 'UNAUTHENTICATED', 'Token do dono inválido.');

  if (path.length === 1 && request.method === 'GET') {
    const { keys } = await env.LICENCAS.list({ prefix: 'cliente:' });
    const records = await Promise.all(keys.map((k) => env.LICENCAS.get(k.name)));
    return json(records.filter((r): r is string => r !== null).map((r) => JSON.parse(r) as ClientRecord));
  }
  const id = path[1];
  if (!id) return fail(404, 'NOT_FOUND', 'Rota não encontrada.');

  if (path.length === 2 && request.method === 'PUT') {
    const body = (await request.json().catch(() => null)) as Partial<ClientRecord> | null;
    if (!body || typeof body.cliente !== 'string') return fail(400, 'VALIDATION', 'Informe o cliente.');
    const existing = await getClient(env, id);
    const record: ClientRecord = {
      id,
      cliente: body.cliente,
      cnpj: typeof body.cnpj === 'string' ? body.cnpj : '',
      maquina: typeof body.maquina === 'string' ? body.maquina : null,
      ativo: existing?.ativo ?? true,
      atualizadoEm: now.toISOString(),
      ultimaRenovacao: existing?.ultimaRenovacao ?? null,
    };
    await putClient(env, record);
    return json(record);
  }
  if (path.length === 3 && request.method === 'POST' && (path[2] === 'suspender' || path[2] === 'reativar')) {
    const record = await getClient(env, id);
    if (!record) return fail(404, 'NOT_FOUND', 'Cliente não encontrado.');
    const updated = { ...record, ativo: path[2] === 'reativar', atualizadoEm: now.toISOString() };
    await putClient(env, updated);
    return json(updated);
  }
  return fail(404, 'NOT_FOUND', 'Rota não encontrada.');
}

export async function handleRequest(request: Request, env: WorkerEnv, now = new Date()): Promise<Response> {
  const path = new URL(request.url).pathname.split('/').filter(Boolean);
  try {
    if (path.length === 1 && path[0] === 'renovar' && request.method === 'POST') return await renew(request, env, now);
    if (path[0] === 'admin' && path[1] === 'clientes') return await admin(request, env, path.slice(1), now);
    return fail(404, 'NOT_FOUND', 'Rota não encontrada.');
  } catch {
    return fail(500, 'INTERNAL', 'Erro no servidor de licenças.');
  }
}

export default { fetch: (request: Request, env: WorkerEnv) => handleRequest(request, env) };
