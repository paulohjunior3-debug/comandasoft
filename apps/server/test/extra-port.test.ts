import { createServer } from 'node:net';
import { request } from 'node:https';
import Fastify from 'fastify';
import forge from 'node-forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listenExtraHttps } from '../src/lib/extra-port';

function selfSigned() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  cert.setSubject([{ name: 'commonName', value: 'Sistema Bar' }]);
  cert.setIssuer([{ name: 'commonName', value: 'Sistema Bar' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

const get = (port: number, path: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end();
  });

const tls = selfSigned();
const app = Fastify({ https: tls });
app.get('/api/health', async () => ({ status: 'ok' }));

beforeAll(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => app.close());

describe('porta HTTPS extra (443)', () => {
  it('responde o mesmo sistema, com as mesmas rotas', async () => {
    const extra = await listenExtraHttps(app, tls, 0, '127.0.0.1');
    expect(extra).not.toBeNull();
    const port = (extra!.address() as { port: number }).port;
    const r = await get(port, '/api/health');
    expect(r).toEqual({ status: 200, body: '{"status":"ok"}' });
    expect((await get(port, '/nada')).status).toBe(404);
    extra!.close();
  });

  it('porta ocupada: avisa e segue sem ela', async () => {
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    const port = (busy.address() as { port: number }).port;
    expect(await listenExtraHttps(app, tls, port, '127.0.0.1')).toBeNull();
    busy.close();
  });
});
