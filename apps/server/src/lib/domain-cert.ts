import * as acme from 'acme-client';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lanAddresses } from './network';

/**
 * Endereço próprio (ex.: sistema.esquinadatilapia.com.br) com certificado da Let's Encrypt: os
 * celulares confiam sem instalar o nosso certificado (o PWA instala direto no Android).
 *
 * O DNS fica na Cloudflare: o servidor mantém o registro A apontando para o IP deste PC na rede
 * local (muda sozinho se o IP mudar) e prova à Let's Encrypt que é dono do nome criando um
 * registro TXT (desafio dns-01). Nada entra pela internet: o celular fala direto com o PC na
 * rede do bar; a internet só serve para o celular descobrir o IP e para renovar o certificado.
 */

const DAY = 86_400_000;
/** Renova quando faltar menos que isso (o certificado vale 90 dias). */
export const RENEW_BEFORE_DAYS = 30;

type FetchFn = typeof fetch;
type Log = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

/** API de DNS da Cloudflare (token com permissão Zone > DNS > Edit). */
export function cloudflareDns(token: string, fetchFn: FetchFn = fetch) {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchFn(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { message: string }[] } | null;
    if (!res.ok || !json?.success) {
      const msg = json?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      throw new Error(`Cloudflare recusou (${method} ${path.split('?')[0]}): ${msg}`);
    }
    return json.result as T;
  };
  type Zone = { id: string; name: string };
  type Rec = { id: string; type: string; name: string; content: string };
  return {
    /** Zona (domínio comprado) que contém o nome: sistema.exemplo.com.br → exemplo.com.br. */
    async zoneFor(hostname: string): Promise<Zone> {
      const zones = await call<Zone[]>('GET', '/zones?per_page=50');
      const zone = zones.filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
      if (!zone) throw new Error(`O domínio de ${hostname} não está nesta conta da Cloudflare (ou o token não dá acesso a ele).`);
      return zone;
    },
    /** Cria ou atualiza o registro A (sem o proxy laranja: o IP é da rede local). Devolve se mudou. */
    async upsertA(zoneId: string, name: string, ip: string): Promise<boolean> {
      const [rec] = await call<Rec[]>('GET', `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`);
      if (rec?.content === ip) return false;
      const body = { type: 'A', name, content: ip, ttl: 60, proxied: false, comment: 'Sistema Bar: IP do servidor na rede local' };
      if (rec) await call('PUT', `/zones/${zoneId}/dns_records/${rec.id}`, body);
      else await call('POST', `/zones/${zoneId}/dns_records`, body);
      return true;
    },
    async createTxt(zoneId: string, name: string, content: string): Promise<string> {
      return (await call<Rec>('POST', `/zones/${zoneId}/dns_records`, { type: 'TXT', name, content, ttl: 60 })).id;
    },
    async deleteRecord(zoneId: string, id: string): Promise<void> {
      await call('DELETE', `/zones/${zoneId}/dns_records/${id}`);
    },
  };
}
export type CloudflareDns = ReturnType<typeof cloudflareDns>;

export interface StoredCert {
  cert: string;
  key: string;
  notAfter: Date;
}

const files = (dir: string) => ({ cert: join(dir, 'certificado.pem'), key: join(dir, 'chave.pem'), account: join(dir, 'conta-acme.pem') });

/** Certificado já tirado (se existir e for deste nome). */
export function loadDomainCert(dir: string, hostname: string): StoredCert | null {
  const f = files(dir);
  if (!existsSync(f.cert) || !existsSync(f.key)) return null;
  const cert = readFileSync(f.cert, 'utf8');
  try {
    const info = acme.crypto.readCertificateInfo(cert);
    const names = [info.domains.commonName, ...info.domains.altNames];
    if (!names.includes(hostname)) return null;
    return { cert, key: readFileSync(f.key, 'utf8'), notAfter: info.notAfter };
  } catch {
    return null;
  }
}

export const needsRenewal = (c: StoredCert | null, now = new Date()) => !c || c.notAfter.getTime() - now.getTime() < RENEW_BEFORE_DAYS * DAY;

/** Tira (ou renova) o certificado pela Let's Encrypt com o desafio dns-01 na Cloudflare. */
export async function issueDomainCert(opts: {
  hostname: string;
  dir: string;
  dns: CloudflareDns;
  email?: string;
  staging?: boolean;
  /** Espera depois de criar o TXT (a Cloudflare publica em segundos). */
  propagationMs?: number;
  log: Log;
}): Promise<StoredCert> {
  const { hostname, dir, dns, log } = opts;
  mkdirSync(dir, { recursive: true });
  const f = files(dir);
  let accountKey: Buffer;
  if (existsSync(f.account)) accountKey = readFileSync(f.account);
  else {
    accountKey = await acme.crypto.createPrivateKey();
    writeFileSync(f.account, accountKey);
  }
  const client = new acme.Client({
    directoryUrl: opts.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
    accountKey,
  });
  const zone = await dns.zoneFor(hostname);
  const [key, csr] = await acme.crypto.createCsr({ commonName: hostname });
  const created = new Map<string, string>();
  const cert = await client.auto({
    csr,
    email: opts.email,
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],
    // A Let's Encrypt consulta direto os servidores da Cloudflare; a conferência local poderia
    // esbarrar no cache do DNS do roteador.
    skipChallengeVerification: true,
    challengeCreateFn: async (authz, _challenge, keyAuthorization) => {
      const name = `_acme-challenge.${authz.identifier.value}`;
      created.set(keyAuthorization, await dns.createTxt(zone.id, name, keyAuthorization));
      await new Promise((r) => setTimeout(r, opts.propagationMs ?? 15_000));
    },
    challengeRemoveFn: async (_authz, _challenge, keyAuthorization) => {
      const id = created.get(keyAuthorization);
      if (id) await dns.deleteRecord(zone.id, id).catch((err) => log.warn(`Não apaguei o TXT do desafio: ${(err as Error).message}`));
    },
  });
  writeFileSync(f.key, key);
  writeFileSync(f.cert, cert);
  const info = acme.crypto.readCertificateInfo(cert);
  return { cert, key: key.toString(), notAfter: info.notAfter };
}

/**
 * Mantém o endereço próprio funcionando: aponta o DNS para o IP atual, tira o certificado se não
 * houver e renova antes de vencer. Roda ao iniciar e a cada `everyMs`; nunca derruba o servidor
 * (sem internet, tenta de novo na próxima rodada e o certificado atual continua valendo).
 */
export function startDomainCert(opts: {
  hostname: string;
  token: string;
  dir: string;
  email?: string;
  staging?: boolean;
  log: Log;
  onCert: (c: StoredCert) => void;
  everyMs?: number;
  fetchFn?: FetchFn;
  issue?: typeof issueDomainCert;
  addresses?: () => string[];
}) {
  const dns = cloudflareDns(opts.token, opts.fetchFn);
  const issue = opts.issue ?? issueDomainCert;
  const addresses = opts.addresses ?? lanAddresses;
  let current = loadDomainCert(opts.dir, opts.hostname);
  if (current) opts.onCert(current);

  const round = async () => {
    try {
      const ip = addresses()[0];
      if (ip) {
        const zone = await dns.zoneFor(opts.hostname);
        if (await dns.upsertA(zone.id, opts.hostname, ip)) opts.log.info(`Endereço ${opts.hostname} agora aponta para ${ip}`);
      }
      if (needsRenewal(current)) {
        opts.log.info(`Pedindo certificado da Let's Encrypt para ${opts.hostname}…`);
        current = await issue({ hostname: opts.hostname, dir: opts.dir, dns, email: opts.email, staging: opts.staging, log: opts.log });
        opts.onCert(current);
        opts.log.info(`Certificado de ${opts.hostname} válido até ${current.notAfter.toISOString().slice(0, 10)}`);
      }
    } catch (err) {
      opts.log.error(`Endereço próprio (${opts.hostname}): ${(err as Error).message}`);
    }
  };
  const done = round();
  const timer = setInterval(() => void round(), opts.everyMs ?? 6 * 3_600_000);
  timer.unref();
  return { ready: done, stop: () => clearInterval(timer), round };
}
