import {
  computeLicenseState,
  LICENSE_ERRORS,
  LICENSE_TIMING,
  leasePayloadSchema,
  licenseMessage,
  licensePayloadSchema,
  type LeasePayload,
  type LicenseBannerInfo,
  type LicensePayload,
  type LicenseRenewal,
  type LicenseStatus,
} from '@sistema-bar/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/client';
import { auditLogs, cashSessions, settings } from '../db/schema';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';
import { loadEmbeddedKeys, type LicenseKeys } from './keys';
import { readMachineId } from './machine';
import { peekToken, verifyToken } from './token';

const KEY = 'licenca';
const HOUR_MS = 60 * 60 * 1000;
const RENEW_EVERY_MS = 6 * HOUR_MS;
const CLOCK_EVERY_MS = 10 * 60 * 1000;

/** O que fica gravado em settings['licenca']. */
interface Stored {
  license: string | null;
  lease: string | null;
  /** Maior horário já visto: atrasar o relógio do Windows não devolve dias. */
  maxSeenAt: string;
  trialStartedAt: string;
  lastRenewal: LicenseRenewal | null;
}

export interface LicenseServiceOptions {
  db: Db;
  /** Bloqueia de verdade (servidor instalado). No desenvolvimento só mostra o estado. */
  enforce: boolean;
  keys?: LicenseKeys | Promise<LicenseKeys>;
  now?: () => Date;
  machineId?: () => Promise<string | null>;
  fetch?: typeof fetch;
  version?: string;
  log?: { warn: (msg: string) => void };
}

export type LicenseService = ReturnType<typeof createLicenseService>;

export function createLicenseService({
  db,
  enforce,
  keys = loadEmbeddedKeys(),
  now = () => new Date(),
  machineId = readMachineId,
  fetch: doFetch = fetch,
  version = 'dev',
  log,
}: LicenseServiceOptions) {
  const keysReady = Promise.resolve(keys);
  let machine: Promise<string | null> | null = null;
  const machineOf = () => (machine ??= machineId());
  const verified = new Map<string, unknown>();
  let renewing: Promise<LicenseRenewal> | null = null;
  const timers: NodeJS.Timeout[] = [];

  async function load(): Promise<Stored> {
    const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
    if (row) return row.valueJson as Stored;
    // Primeira subida: começa a avaliação.
    const first: Stored = {
      license: null,
      lease: null,
      maxSeenAt: now().toISOString(),
      trialStartedAt: now().toISOString(),
      lastRenewal: null,
    };
    await db.insert(settings).values({ key: KEY, valueJson: first }).onConflictDoNothing();
    const [again] = await db.select().from(settings).where(eq(settings.key, KEY));
    return again!.valueJson as Stored;
  }

  async function save(change: Partial<Stored>): Promise<Stored> {
    const value = { ...(await load()), ...change };
    await db.update(settings).set({ valueJson: value, updatedAt: new Date() }).where(eq(settings.key, KEY));
    return value;
  }

  /** Hora efetiva: o maior entre o relógio e o maior horário já visto (que sobe junto). */
  async function effectiveNow(stored: Stored): Promise<Date> {
    const real = now();
    const seen = new Date(stored.maxSeenAt);
    if (real.getTime() > seen.getTime() + 60_000) {
      await save({ maxSeenAt: real.toISOString() });
      return real;
    }
    return real > seen ? real : seen;
  }

  async function verify(token: string, kind: 'licenca' | 'lease'): Promise<LicensePayload | LeasePayload | null> {
    const cacheKey = `${kind}:${token}`;
    if (!verified.has(cacheKey)) {
      const k = await keysReady;
      // Lease: chave de renovação (Worker/CLI) ou a raiz; licença: só a raiz.
      const payload = await verifyToken(token, kind === 'licenca' ? k.root : [...k.renewal, ...k.root]);
      const parsed = (kind === 'licenca' ? licensePayloadSchema : leasePayloadSchema).safeParse(payload);
      verified.set(cacheKey, parsed.success ? parsed.data : null);
    }
    return verified.get(cacheKey) as LicensePayload | LeasePayload | null;
  }

  async function current(stored: Stored) {
    const license = stored.license ? ((await verify(stored.license, 'licenca')) as LicensePayload | null) : null;
    const rawLease = stored.lease ? ((await verify(stored.lease, 'lease')) as LeasePayload | null) : null;
    const lease = license && rawLease?.licencaId === license.id ? rawLease : null;
    return { license, lease };
  }

  async function status(): Promise<LicenseStatus> {
    const stored = await load();
    const at = await effectiveNow(stored);
    const { license, lease } = await current(stored);
    const machineId = await machineOf();
    const computed = computeLicenseState({
      license,
      lease,
      trialStartedAt: new Date(stored.trialStartedAt),
      machineId,
      now: at,
    });
    const mode = license ? 'LICENCIADA' : 'AVALIACAO';
    const support = license?.suporte ?? null;
    return {
      state: computed.state,
      mode,
      message: licenseMessage({ ...computed, mode }, support),
      licenseId: license?.id ?? null,
      customer: license?.cliente ?? null,
      cnpj: license?.cnpj ?? null,
      features: license?.recursos ?? [],
      expiresAt: computed.expiresAt?.toISOString() ?? null,
      blocksAt: computed.blocksAt?.toISOString() ?? null,
      daysLeft: computed.daysLeft,
      machineId,
      machineBound: license?.maquina != null,
      autoRenew: license?.renovacao != null,
      lastRenewal: stored.lastRenewal,
      support,
      enforced: enforce,
    };
  }

  /** Para as faixas: no desenvolvimento não incomoda ninguém. */
  async function banner(): Promise<LicenseBannerInfo> {
    const s = await status();
    if (!enforce) return { state: 'VALIDA', mode: s.mode, message: null, daysLeft: s.daysLeft, support: s.support };
    return { state: s.state, mode: s.mode, message: s.message, daysLeft: s.daysLeft, support: s.support };
  }

  /**
   * Bloqueio: só abrir caixa (CAIXA) e abrir comanda/lançar pedido (VENDA). Venda continua
   * enquanto houver um caixa aberto há menos de 24 h: nunca para a casa no meio do movimento.
   */
  async function assertCanOperate(kind: 'CAIXA' | 'VENDA') {
    if (!enforce) return;
    const s = await status();
    if (s.state !== 'BLOQUEADA') return;
    if (kind === 'VENDA') {
      const since = new Date((await effectiveNow(await load())).getTime() - LICENSE_TIMING.openSessionHours * HOUR_MS);
      const [open] = await db
        .select({ id: cashSessions.id })
        .from(cashSessions)
        .where(and(isNull(cashSessions.closedAt), gt(cashSessions.openedAt, since)))
        .limit(1);
      if (open) return;
    }
    throw new HttpError(403, LICENSE_ERRORS.BLOCKED, s.message ?? 'Licença vencida.');
  }

  const invalid = (message: string) => new HttpError(400, LICENSE_ERRORS.INVALID, message);

  /** Guarda um lease mais novo da licença instalada. O horário assinado corrige o relógio. */
  async function acceptLease(token: string, stored: Stored): Promise<LeasePayload> {
    const lease = (await verify(token, 'lease')) as LeasePayload | null;
    if (!lease) throw invalid('Assinatura do lease inválida. Confira se o texto foi copiado inteiro.');
    const { license, lease: existing } = await current(stored);
    if (!license) throw invalid('Instale a licença antes do lease.');
    if (lease.licencaId !== license.id) throw invalid('Este lease é de outra licença.');
    if (lease.maquina !== null && lease.maquina !== (await machineOf())) throw invalid('Este lease é de outro computador.');
    const laterEnd = !existing || new Date(lease.validoAte) > new Date(existing.validoAte);
    const laterIssue = !existing || new Date(lease.emitidoEm) > new Date(existing.emitidoEm);
    if (!laterEnd && !laterIssue) throw invalid('Este lease não é mais novo que o instalado.');
    // Fica o que vence por último. O horário de quem assinou vale mais que o do Windows: um lease
    // emitido depois corrige o relógio adiantado por engano (maior horário visto).
    await save({ ...(laterEnd ? { lease: token } : {}), ...(laterIssue ? { maxSeenAt: lease.emitidoEm } : {}) });
    return lease;
  }

  async function auditSystem(action: string, after: unknown) {
    await db.insert(auditLogs).values({ userId: null, action, entity: 'licenca', afterJson: after });
  }

  /** Tela Admin › Licença: aceita tanto a licença quanto um lease colado. */
  async function install(token: string, request: FastifyRequest): Promise<LicenseStatus> {
    const text = token.trim().replace(/\s+/g, '');
    const peek = peekToken(text) as { tipo?: unknown } | null;
    const stored = await load();
    if (peek?.tipo === 'lease') {
      const lease = await acceptLease(text, stored);
      await audit(db, request, { action: 'LICENCA_LEASE_INSTALADO', entity: 'licenca', entityId: lease.licencaId, after: lease });
      return status();
    }
    if (peek?.tipo !== 'licenca') throw invalid('Texto de licença inválido. Ele começa com "SB1." e deve ser colado inteiro.');
    const license = (await verify(text, 'licenca')) as LicensePayload | null;
    if (!license) throw invalid('Assinatura da licença inválida. Confira se o texto foi copiado inteiro.');
    const machineId = await machineOf();
    if (license.maquina !== null && license.maquina !== machineId) {
      throw invalid(`Esta licença é do computador ${license.maquina}; este é ${machineId ?? 'desconhecido'}.`);
    }
    const before = (await current(stored)).license;
    await save({ license: text, lease: before?.id === license.id ? stored.lease : null, lastRenewal: null });
    await audit(db, request, {
      action: 'LICENCA_INSTALADA',
      entity: 'licenca',
      entityId: license.id,
      before: before ? { id: before.id, cliente: before.cliente } : null,
      after: license,
    });
    if (license.renovacao) void renew().catch(() => {});
    return status();
  }

  async function doRenew(request?: FastifyRequest): Promise<LicenseRenewal> {
    const stored = await load();
    const { license } = await current(stored);
    if (!license?.renovacao) {
      return { at: now().toISOString(), ok: false, message: 'Esta licença não usa renovação automática.' };
    }
    let result: LicenseRenewal;
    let refused = false;
    try {
      const res = await doFetch(`${license.renovacao.replace(/\/+$/, '')}/renovar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ licencaId: license.id, maquina: await machineOf(), versao: version }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { lease?: string; message?: string };
      if (res.ok && body.lease) {
        try {
          await acceptLease(body.lease, stored);
          result = { at: now().toISOString(), ok: true, message: null };
        } catch (err) {
          // Lease igual ao instalado (renovou duas vezes no mesmo instante) não é erro.
          const same = err instanceof HttpError && err.message.includes('não é mais novo');
          result = { at: now().toISOString(), ok: same, message: same ? null : (err as Error).message };
        }
      } else if (res.status >= 400 && res.status < 500) {
        refused = true;
        result = { at: now().toISOString(), ok: false, message: body.message ?? `Renovação recusada (${res.status}).` };
      } else {
        result = { at: now().toISOString(), ok: false, message: `Servidor de licenças com erro (${res.status}).` };
      }
    } catch {
      result = { at: now().toISOString(), ok: false, message: 'Sem conexão com o servidor de licenças.' };
    }
    const previous = (await load()).lastRenewal;
    await save({ lastRenewal: result });
    // Recusa vai para a auditoria quando muda (não a cada 6 h) ou quando alguém clicou.
    if (refused && (request || previous?.ok !== false || previous.message !== result.message)) {
      const entry = { action: 'LICENCA_RENOVACAO_RECUSADA', entity: 'licenca', entityId: license.id, after: result };
      if (request) await audit(db, request, entry);
      else await auditSystem(entry.action, result);
    }
    if (!result.ok) log?.warn(`Licença: ${result.message}`);
    return result;
  }

  /** Uma renovação por vez (o timer e o botão "Renovar agora" podem coincidir). */
  function renew(request?: FastifyRequest): Promise<LicenseRenewal> {
    renewing ??= doRenew(request).finally(() => {
      renewing = null;
    });
    return renewing;
  }

  return {
    status,
    banner,
    assertCanOperate,
    install,
    renew,
    /** Servidor instalado: renova ao subir e a cada 6 h; o relógio é registrado a cada 10 min. */
    start() {
      void renew().catch(() => {});
      timers.push(setInterval(() => void renew().catch(() => {}), RENEW_EVERY_MS).unref());
      timers.push(setInterval(() => void status().catch(() => {}), CLOCK_EVERY_MS).unref());
    },
    stop() {
      for (const t of timers.splice(0)) clearInterval(t);
    },
  };
}
