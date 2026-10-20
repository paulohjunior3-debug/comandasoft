import { DEFAULT_FISCAL_SETTINGS, type FiscalStatus, type ProductFiscalRow } from '@sistema-bar/shared';
import { eq } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import forge from 'node-forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fiscalConfig, fiscalDocuments, products } from '../src/db/schema';
import { importMenu } from '../src/lib/import-menu';
import { createSecretBox } from '../src/lib/secret-box';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

let ctx: TestContext;
let admin: Inject;
let caixa: Inject;
const CNPJ = '11222333000181';
const PFX_PASSWORD = 'senha-do-certificado';

/** Certificado A1 de mentira, no formato ICP-Brasil (CN "RAZÃO:CNPJ"). */
function makePfx({ days = 365, cn = `BAR TESTE LTDA:${CNPJ}` } = {}): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer([{ name: 'commonName', value: 'AC TESTE' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PFX_PASSWORD, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64');
}

const status = async (): Promise<FiscalStatus> => (await admin({ method: 'GET', url: '/api/admin/fiscal/status' })).json();

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await ctx.as('admin');
  caixa = await ctx.as('caixa');
  const cat = (await admin({ method: 'POST', url: '/api/admin/categories', payload: { name: 'Bebidas' } })).json().id;
  await admin({ method: 'POST', url: '/api/admin/products', payload: { categoryId: cat, name: 'Heineken', priceCents: 1500 } });
  await admin({ method: 'POST', url: '/api/admin/products', payload: { categoryId: cat, name: 'Água', priceCents: 500 } });
});
afterAll(() => ctx.close());

describe('fiscal: preparação da NFC-e', () => {
  it('começa sem nada pronto e diz o que falta', async () => {
    const s = await status();
    expect(s.settings).toEqual(DEFAULT_FISCAL_SETTINGS);
    expect(s.readiness.every((r) => !r.ok)).toBe(true);
    expect(s.productsMissingNcm).toBe(2);
    expect((await caixa({ method: 'GET', url: '/api/admin/fiscal/status' })).statusCode).toBe(403);
  });

  it('valida e salva os dados do emitente', async () => {
    const bad = await admin({ method: 'PUT', url: '/api/admin/fiscal/settings', payload: { ...DEFAULT_FISCAL_SETTINGS, cnpj: '11.222.333/0001-00' } });
    expect(bad.json().message).toBe('CNPJ inválido');
    const ok = await admin({
      method: 'PUT',
      url: '/api/admin/fiscal/settings',
      payload: {
        ...DEFAULT_FISCAL_SETTINGS,
        legalName: 'Bar Teste Ltda',
        cnpj: '11.222.333/0001-81',
        stateRegistration: '062.307.904/0081',
        street: 'Rua A',
        number: '10',
        district: 'Centro',
        city: 'Belo Horizonte',
        cityCode: '3106200',
        zip: '30110-000',
      },
    });
    expect(ok.statusCode).toBe(200);
    const s = await status();
    expect(s.settings).toMatchObject({ cnpj: CNPJ, stateRegistration: '0623079040081', zip: '30110000' });
    expect(s.readiness.find((r) => r.key === 'emitente')!.ok).toBe(true);
    expect(s.readiness.find((r) => r.key === 'endereco')!.ok).toBe(true);
  });

  it('CSC fica cifrado e nunca volta para a tela', async () => {
    await admin({ method: 'PUT', url: '/api/admin/fiscal/csc', payload: { cscId: '000001', cscToken: 'ABCDEF1234567890ABCDEF1234567890' } });
    const s = await status();
    expect(s).toMatchObject({ cscConfigured: true, cscId: '000001' });
    expect(JSON.stringify(s)).not.toContain('ABCDEF1234567890');
    const [row] = await ctx.db.select().from(fiscalConfig);
    expect(row!.cscTokenEnc).not.toContain('ABCDEF');
    expect(createSecretBox('c'.repeat(32)).open(row!.cscTokenEnc!).toString()).toBe('ABCDEF1234567890ABCDEF1234567890');
  });

  it('certificado A1: confere a senha e a validade, lê o CNPJ e guarda cifrado', async () => {
    const wrong = await admin({ method: 'POST', url: '/api/admin/fiscal/certificate', payload: { pfxBase64: makePfx(), password: 'errada' } });
    expect(wrong.json().message).toMatch(/senha incorreta/);
    const expired = await admin({ method: 'POST', url: '/api/admin/fiscal/certificate', payload: { pfxBase64: makePfx({ days: -1 }), password: PFX_PASSWORD } });
    expect(expired.json().message).toMatch(/já venceu/);

    const pfx = makePfx({ days: 20 });
    const res = await admin({ method: 'POST', url: '/api/admin/fiscal/certificate', payload: { pfxBase64: pfx, password: PFX_PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ subject: `BAR TESTE LTDA:${CNPJ}`, cnpj: CNPJ, daysLeft: 19 });

    const s = await status();
    expect(s.readiness.find((r) => r.key === 'certificado')!.ok).toBe(true);
    expect(s.readiness.find((r) => r.key === 'cnpj-certificado')!.ok).toBe(true);
    const [row] = await ctx.db.select().from(fiscalConfig);
    expect(row!.certPasswordEnc).not.toContain(PFX_PASSWORD);
    const box = createSecretBox('c'.repeat(32));
    expect(box.open(row!.certPfxEnc!).toString('base64')).toBe(pfx);
    expect(box.open(row!.certPasswordEnc!).toString()).toBe(PFX_PASSWORD);
  });

  it('dados fiscais dos produtos em lote e pela importação do cardápio', async () => {
    const rows: ProductFiscalRow[] = (await admin({ method: 'GET', url: '/api/admin/fiscal/products' })).json();
    const heineken = rows.find((p) => p.name === 'Heineken')!;
    const bad = await admin({ method: 'PUT', url: '/api/admin/fiscal/products', payload: { items: [{ id: heineken.id, ncm: '123', cfop: '', csosn: '', origin: '', cest: '' }] } });
    expect(bad.json().message).toBe('NCM deve ter 8 dígitos');
    const res = await admin({
      method: 'PUT',
      url: '/api/admin/fiscal/products',
      payload: { items: [{ id: heineken.id, ncm: '2203.00.00', cfop: '5405', csosn: '500', origin: '0', cest: '03.021.00' }] },
    });
    expect(res.json()).toEqual({ changed: 1 });
    const [saved] = await ctx.db.select().from(products).where(eq(products.id, heineken.id));
    expect(saved).toMatchObject({ ncm: '22030000', cfop: '5405', csosn: '500', origin: '0', cest: '0302100' });

    await importMenu(ctx.db, { categorias: [{ nome: 'Bebidas', produtos: [{ nome: 'Água', preco: '5,00', ncm: '22011000', cfop: '5102', csosn: '102' }] }] }, 'teste');
    const [agua] = await ctx.db.select().from(products).where(eq(products.name, 'Água'));
    expect(agua).toMatchObject({ ncm: '22011000', cfop: '5102', csosn: '102' });
    expect((await status()).productsMissingNcm).toBe(0);
  });

  it('XMLs do mês num .zip para o contador (só produção), com resumo', async () => {
    const at = new Date(Date.UTC(2026, 9, 10, 15));
    const base = { series: 1, environment: 'PRODUCAO', issuedAt: at };
    await ctx.db.insert(fiscalDocuments).values([
      { ...base, number: 1, accessKey: '3'.repeat(44), status: 'AUTORIZADA', totalCents: 4250, xml: '<nfeProc>1</nfeProc>', protocol: '131' },
      { ...base, number: 2, accessKey: '4'.repeat(44), status: 'CANCELADA', totalCents: 1000, xml: '<nfeProc>2</nfeProc>', cancelXml: '<procEvento>c</procEvento>', canceledAt: at, cancelReason: 'Erro de digitação' },
      { ...base, number: 3, accessKey: '5'.repeat(44), status: 'AUTORIZADA', totalCents: 999, xml: '<teste/>', environment: 'HOMOLOGACAO' },
    ]);
    const summary = (await admin({ method: 'GET', url: '/api/admin/fiscal/summary?month=2026-10' })).json();
    expect(summary).toEqual({ month: '2026-10', authorized: 1, canceled: 1, totalCents: 4250, canceledCents: 1000 });

    const res = await admin({ method: 'GET', url: '/api/admin/fiscal/export?month=2026-10' });
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain(`xml-nfce-${CNPJ}-2026-10.zip`);
    const files = unzipSync(new Uint8Array(res.rawPayload));
    expect(Object.keys(files).sort()).toEqual([`Cancelamentos/${'4'.repeat(44)}-canc.xml`, `NFCe/${'3'.repeat(44)}-nfce.xml`, `NFCe/${'4'.repeat(44)}-nfce.xml`, 'resumo.csv']);
    const resumo = strFromU8(files['resumo.csv']!);
    expect(resumo).toContain('Total autorizado (R$);42,50');
    expect(resumo).toContain('Erro de digitação');
    expect((await admin({ method: 'GET', url: '/api/admin/fiscal/export?month=2026-13' })).json().message).toBe('Mês inválido (use AAAA-MM).');
  });
});
