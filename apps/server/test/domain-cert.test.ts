import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect, createSecureContext, type SecureContext } from 'node:tls';
import Fastify from 'fastify';
import { join } from 'node:path';
import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { cloudflareDns, loadDomainCert, needsRenewal, startDomainCert, type StoredCert } from '../src/lib/domain-cert';

const HOST = 'sistema.esquinadatilapia.com.br';
const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** Cloudflare de mentira: zonas e registros em memória. */
function fakeCloudflare() {
  const records: { id: string; type: string; name: string; content: string; proxied?: boolean }[] = [];
  const calls: string[] = [];
  let n = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${u.pathname}`);
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if ((init?.headers as Record<string, string>).authorization !== 'Bearer tok') {
      return new Response(JSON.stringify({ success: false, errors: [{ message: 'Invalid API Token' }] }), { status: 403 });
    }
    if (u.pathname === '/client/v4/zones') return ok([{ id: 'z1', name: 'esquinadatilapia.com.br' }, { id: 'z2', name: 'outro.com.br' }]);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const m = u.pathname.match(/\/zones\/z1\/dns_records(?:\/(.+))?$/);
    if (!m) return new Response('{}', { status: 404 });
    if (method === 'GET') return ok(records.filter((r) => r.type === u.searchParams.get('type') && r.name === u.searchParams.get('name')));
    if (method === 'POST') {
      const rec = { id: `r${++n}`, ...body };
      records.push(rec);
      return ok(rec);
    }
    const i = records.findIndex((r) => r.id === m[1]);
    if (method === 'PUT') records[i] = { id: m[1]!, ...body };
    if (method === 'DELETE') records.splice(i, 1);
    return ok({ id: m[1] });
  }) as typeof fetch;
  return { fetchFn, records, calls };
}

function selfSigned(cn: string, days: number) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + days * 86_400_000);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer([{ name: 'commonName', value: cn }]);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: cn }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

describe('DNS na Cloudflare', () => {
  it('acha a zona do nome e cria/atualiza o registro A sem proxy', async () => {
    const cf = fakeCloudflare();
    const dns = cloudflareDns('tok', cf.fetchFn);
    const zone = await dns.zoneFor(HOST);
    expect(zone.id).toBe('z1');
    expect(await dns.upsertA(zone.id, HOST, '192.168.0.10')).toBe(true);
    expect(await dns.upsertA(zone.id, HOST, '192.168.0.10')).toBe(false);
    expect(await dns.upsertA(zone.id, HOST, '192.168.1.20')).toBe(true);
    expect(cf.records).toMatchObject([{ type: 'A', name: HOST, content: '192.168.1.20', proxied: false }]);
    await expect(dns.zoneFor('sistema.naotenho.com.br')).rejects.toThrow(/não está nesta conta/);
  });

  it('token errado vira mensagem clara', async () => {
    await expect(cloudflareDns('errado', fakeCloudflare().fetchFn).zoneFor(HOST)).rejects.toThrow(/Invalid API Token/);
  });
});

describe('certificado do endereço próprio', () => {
  it('lê o certificado salvo e decide a renovação (menos de 30 dias)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-dom-'));
    expect(loadDomainCert(dir, HOST)).toBeNull();
    const c = selfSigned(HOST, 60);
    writeFileSync(join(dir, 'certificado.pem'), c.cert);
    writeFileSync(join(dir, 'chave.pem'), c.key);
    const stored = loadDomainCert(dir, HOST)!;
    expect(stored.notAfter.getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    expect(needsRenewal(stored)).toBe(false);
    expect(needsRenewal(stored, new Date(Date.now() + 40 * 86_400_000))).toBe(true);
    // Certificado de outro nome não serve.
    expect(loadDomainCert(dir, 'outro.esquinadatilapia.com.br')).toBeNull();
  });

  it('ao iniciar: aponta o DNS para o IP da rede e tira o certificado; com ele válido, não pede de novo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-dom-'));
    const cf = fakeCloudflare();
    const issued: string[] = [];
    const got: StoredCert[] = [];
    let ip = '192.168.0.10';
    const issue = async ({ hostname }: { hostname: string }) => {
      issued.push(hostname);
      const c = selfSigned(hostname, 90);
      return { ...c, notAfter: new Date(Date.now() + 90 * 86_400_000) };
    };
    const w = startDomainCert({ hostname: HOST, token: 'tok', dir, log: silent, onCert: (c) => got.push(c), fetchFn: cf.fetchFn, issue, addresses: () => [ip] });
    await w.ready;
    expect(issued).toEqual([HOST]);
    expect(got).toHaveLength(1);
    expect(cf.records).toMatchObject([{ type: 'A', content: '192.168.0.10' }]);

    ip = '192.168.1.20'; // levou o notebook para outra rede
    await w.round();
    expect(issued).toHaveLength(1);
    expect(cf.records).toMatchObject([{ type: 'A', content: '192.168.1.20' }]);
    w.stop();
  });

  it('sem internet: registra o erro e não derruba nada', async () => {
    const errors: string[] = [];
    const w = startDomainCert({
      hostname: HOST,
      token: 'tok',
      dir: mkdtempSync(join(tmpdir(), 'sb-dom-')),
      log: { ...silent, error: (m) => errors.push(m) },
      onCert: () => {},
      fetchFn: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
      addresses: () => ['192.168.0.10'],
    });
    await w.ready;
    expect(errors[0]).toMatch(/fetch failed/);
    w.stop();
  });
});

describe('servidor HTTPS com os dois certificados', () => {
  it('pelo nome entrega o certificado do domínio; pelo IP, o do sistema', async () => {
    const sistema = selfSigned('Sistema Bar', 365);
    const dominio = selfSigned(HOST, 90);
    let ctx: SecureContext | null = null;
    const app = Fastify({
      https: {
        cert: sistema.cert,
        key: sistema.key,
        SNICallback: (name: string, cb: (err: Error | null, c?: SecureContext) => void) => cb(null, ctx && name === HOST ? ctx : undefined),
      },
    });
    app.get('/', async () => 'ok');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const subject = (servername?: string) =>
      new Promise<string>((resolve, reject) => {
        const s = connect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false }, () => {
          resolve(String(s.getPeerCertificate().subject.CN));
          s.end();
        });
        s.on('error', reject);
      });
    expect(await subject(HOST)).toBe('Sistema Bar'); // ainda sem o certificado do domínio
    ctx = createSecureContext({ cert: dominio.cert, key: dominio.key }); // chegou (sem reiniciar)
    expect(await subject(HOST)).toBe(HOST);
    expect(await subject()).toBe('Sistema Bar');
    await app.close();
  });
});
