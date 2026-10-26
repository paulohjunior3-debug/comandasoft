import { randomUUID } from 'node:crypto';
import type { FiscalDocumentRow, FiscalStatus, NfceEmitResult } from '@sistema-bar/shared';
import { eq } from 'drizzle-orm';
import forge from 'node-forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fiscalDocuments } from '../src/db/schema';
import { SefazCommError, type Transport } from '../src/fiscal/nfce/sefaz';
import { createTestContext, type TestContext } from './helpers';

type Inject = Awaited<ReturnType<TestContext['as']>>;

const CNPJ = '11222333000181';
let ctx: TestContext;
let admin: Inject;
let caixa: Inject;
let garcom: Inject;
/** lost = a SEFAZ autorizou mas a resposta não voltou. */
let mode: 'ok' | 'reject' | 'down' | 'lost' = 'ok';
const authorizedAtSefaz = new Set<string>();
const sent: { url: string; body: string }[] = [];
const ids = {} as Record<'register' | 'mesa' | 'cerveja' | 'semNcm', string>;

const fakeSefaz: Transport = async (url, _action, body) => {
  sent.push({ url, body });
  if (mode === 'down') throw new SefazCommError('Tempo esgotado esperando a SEFAZ.');
  if (url.endsWith('NFeConsultaProtocolo4')) {
    const key = body.match(/<chNFe>(\d{44})<\/chNFe>/)![1]!;
    if (!authorizedAtSefaz.has(key)) return '<Envelope><Body><retConsSitNFe><cStat>217</cStat><xMotivo>Rejeicao: NF-e nao consta na base de dados da SEFAZ</xMotivo></retConsSitNFe></Body></Envelope>';
    return `<Envelope><Body><retConsSitNFe><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo><protNFe versao="4.00"><infProt><chNFe>${key}</chNFe><dhRecbto>2026-10-26T21:05:00-03:00</dhRecbto><nProt>231260000000099</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></retConsSitNFe></Body></Envelope>`;
  }
  if (url.endsWith('NFeStatusServico4')) return '<Envelope><Body><retConsStatServ><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo></retConsStatServ></Body></Envelope>';
  const key = body.match(/Id="NFe(\d{44})"/)![1]!;
  if (mode === 'lost') {
    authorizedAtSefaz.add(key);
    throw new SefazCommError('Conexão caiu esperando a resposta da SEFAZ.');
  }
  if (mode === 'ok') authorizedAtSefaz.add(key);
  if (mode === 'reject') {
    return `<Envelope><Body><retEnviNFe><cStat>104</cStat><xMotivo>Lote processado</xMotivo><protNFe versao="4.00"><infProt><chNFe>${key}</chNFe><cStat>778</cStat><xMotivo>Rejeicao: Informado NCM inexistente</xMotivo></infProt></protNFe></retEnviNFe></Body></Envelope>`;
  }
  return `<Envelope><Body><retEnviNFe><cStat>104</cStat><xMotivo>Lote processado</xMotivo><protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><chNFe>${key}</chNFe><dhRecbto>2026-10-26T21:00:00-03:00</dhRecbto><nProt>231260000000001</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></retEnviNFe></Body></Envelope>`;
};

function testPfx() {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 30 * 86_400_000);
  const attrs = [{ name: 'commonName', value: `BAR TESTE LTDA:${CNPJ}` }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'senha', { algorithm: '3des' })).getBytes(), 'binary').toString('base64');
}

const sell = async (productId: string, qty: number, method = 'PIX') => {
  const c = (
    await garcom({ method: 'POST', url: '/api/waiter/comandas', payload: { clientUuid: randomUUID(), tableId: ids.mesa, customerName: `C${randomUUID().slice(0, 4)}`, phone: '(34) 99999-0000' } })
  ).json().id as string;
  await garcom({
    method: 'POST',
    url: '/api/waiter/orders',
    payload: { clientUuid: randomUUID(), tableId: ids.mesa, comandaIds: [c], items: [{ productId, qty }], createdAtDevice: new Date().toISOString() },
  });
  const bill = (await caixa({ method: 'POST', url: '/api/cashier/bill', payload: { comandaIds: [c] } })).json();
  await caixa({
    method: 'POST',
    url: '/api/cashier/payments',
    payload: { clientUuid: randomUUID(), registerId: ids.register, comandaIds: [c], method, amountCents: bill.totals.remainingCents, payerName: 'X' },
  });
  return c;
};
const askNote = async (comandaId: string) =>
  (await caixa({ method: 'POST', url: '/api/cashier/fiscal-requests', payload: { registerId: ids.register, comandaIds: [comandaId], cpfOnNote: false } })).json();

beforeAll(async () => {
  ctx = await createTestContext({ sefazTransport: fakeSefaz });
  admin = await ctx.as('admin');
  caixa = await ctx.as('caixa');
  garcom = await ctx.as('garcom');
  const post = async (url: string, payload: object) => (await admin({ method: 'POST', url, payload })).json();

  const printer = (await post('/api/admin/printers', { name: 'Caixa', windowsName: 'EPSON', sectorLabel: 'CAIXA' })).id;
  const settings = (await admin({ method: 'GET', url: '/api/admin/settings' })).json();
  await admin({ method: 'PUT', url: '/api/admin/settings', payload: { ...settings, cashierPrinterId: printer, serviceFeeEnabled: true } });
  const cat = (await post('/api/admin/categories', { name: 'Bebidas' })).id;
  ids.cerveja = (await post('/api/admin/products', { categoryId: cat, name: 'Heineken 600ml', priceCents: 1800 })).id;
  ids.semNcm = (await post('/api/admin/products', { categoryId: cat, name: 'Suco', priceCents: 900 })).id;
  await admin({ method: 'PUT', url: '/api/admin/fiscal/products', payload: { items: [{ id: ids.cerveja, ncm: '22030000', cfop: '5405', csosn: '500', origin: '0', cest: '0302100' }] } });
  ids.mesa = (await post('/api/admin/tables', { number: 9 })).id;
  ids.register = (await post('/api/admin/registers', { name: 'Caixa 1' })).id;
  await caixa({ method: 'POST', url: '/api/cashier/session/open', payload: { registerId: ids.register, openingFloatCents: 0 } });

  const fiscal = (await admin({ method: 'GET', url: '/api/admin/fiscal/status' })).json() as FiscalStatus;
  await admin({
    method: 'PUT',
    url: '/api/admin/fiscal/settings',
    payload: {
      ...fiscal.settings,
      legalName: 'BAR TESTE LTDA',
      cnpj: CNPJ,
      stateRegistration: '0034971640010',
      street: 'R TESTE',
      number: '10',
      district: 'CENTRO',
      city: 'UBERLANDIA',
      cityCode: '3170206',
      uf: 'MG',
      zip: '38400000',
      environment: 'HOMOLOGACAO',
      emissionEnabled: true,
      respTecCnpj: CNPJ,
      respTecContact: 'Suporte',
      respTecEmail: 'suporte@exemplo.com.br',
      respTecPhone: '34999990000',
    },
  });
  await admin({ method: 'PUT', url: '/api/admin/fiscal/csc', payload: { environment: 'HOMOLOGACAO', cscId: '000001', cscToken: 'CSC-DE-HOMOLOGACAO-123' } });
  const up = await admin({ method: 'POST', url: '/api/admin/fiscal/certificate', payload: { pfxBase64: testPfx(), password: 'senha' } });
  expect(up.statusCode).toBe(200);
});
afterAll(() => ctx.close());

describe('NFC-e direto com a SEFAZ (homologação)', () => {
  it('a tela Fiscal mostra o CSC de homologação e o teste de comunicação', async () => {
    const status = (await admin({ method: 'GET', url: '/api/admin/fiscal/status' })).json() as FiscalStatus;
    expect(status).toMatchObject({ cscHomConfigured: true, cscHomId: '000001', cscConfigured: false });
    expect(status.readiness.find((r) => r.key === 'csc')!.ok).toBe(true);
    const r = (await admin({ method: 'POST', url: '/api/admin/fiscal/sefaz-status' })).json();
    expect(r).toMatchObject({ environment: 'HOMOLOGACAO', ok: true, cStat: '107' });
    expect(sent.at(-1)!.url).toBe('https://hnfce.fazenda.mg.gov.br/nfce/services/NFeStatusServico4');
  });

  it('pedido de cupom fiscal no caixa emite a NFC-e, grava o XML com o protocolo e imprime o DANFE', async () => {
    const c = await sell(ids.cerveja, 3);
    const r = await askNote(c);
    expect(r).toMatchObject({ status: 'AUTORIZADA', number: 1 });
    const body = sent.at(-1)!.body;
    expect(body).toContain('<indSinc>1</indSinc><NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe');
    expect(body).toContain('<tpAmb>2</tpAmb>');
    expect(body).toContain('NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL');
    expect(body).toContain('<vNF>54.00</vNF>'); // só os itens: a taxa de serviço não entra na nota
    expect(body).toContain('<tPag>20</tPag><vPag>54.00</vPag>');
    expect(body).toContain('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">');

    const [doc] = await ctx.db.select().from(fiscalDocuments).where(eq(fiscalDocuments.accessKey, r.accessKey));
    expect(doc).toMatchObject({ status: 'AUTORIZADA', environment: 'HOMOLOGACAO', number: 1, totalCents: 5400, protocol: '231260000000001' });
    expect(doc!.xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?><nfeProc versao="4.00"/);
    expect(doc!.xml).toContain('<cStat>100</cStat>');

    ctx.printed.length = 0;
    await ctx.app.printWorker.runOnce();
    const danfe = ctx.printed.find((p) => p.preview.includes('DANFE NFC-e'))!;
    expect(danfe.preview).toContain('HOMOLOGA');
    expect(danfe.preview).toContain('Protocolo de autorização: 231260000000001');
    expect(danfe.preview).toContain('QR CODE');
    const list = (await admin({ method: 'GET', url: '/api/admin/fiscal/documents' })).json() as FiscalDocumentRow[];
    expect(list[0]).toMatchObject({ number: 1, status: 'AUTORIZADA' });
  });

  it('rejeição da SEFAZ volta com o motivo e devolve o número para a próxima nota', async () => {
    mode = 'reject';
    const r = await askNote(await sell(ids.cerveja, 1));
    expect(r.status).toBe('REJEITADA');
    expect(r.message).toMatch(/778 - Rejeicao: Informado NCM inexistente/);
    mode = 'ok';
    const ok = await askNote(await sell(ids.cerveja, 1));
    expect(ok).toMatchObject({ status: 'AUTORIZADA', number: 2 });
  });

  it('sem comunicação: avisa, guarda a nota e no novo pedido reenvia com o mesmo número', async () => {
    mode = 'down';
    const c = await sell(ids.cerveja, 1, 'DINHEIRO');
    const r = await askNote(c);
    expect(r).toMatchObject({ status: 'ERRO_COMUNICACAO', number: 3 });
    expect(r.message).toMatch(/Tempo esgotado/);
    const pending = (await admin({ method: 'GET', url: '/api/admin/fiscal/pending' })).json();
    expect(pending).toMatchObject([{ number: 3, environment: 'HOMOLOGACAO', totalCents: 1800 }]);
    mode = 'ok';
    // Consulta (217: não recebeu) e reenvia a mesma nota 3.
    const again = await askNote(c);
    expect(again).toMatchObject({ status: 'AUTORIZADA', number: 3 });
    expect(sent.at(-2)!.url).toMatch(/NFeConsultaProtocolo4$/);
    expect((await admin({ method: 'GET', url: '/api/admin/fiscal/pending' })).json()).toEqual([]);
    // A mesma conta não ganha uma segunda nota.
    const dup = await askNote(c);
    expect(dup).toMatchObject({ status: 'REJEITADA' });
    expect(dup.message).toMatch(/já tem a NFC-e 3/);
  });

  it('autorizada mas a resposta se perdeu: a consulta recupera o protocolo sem reenviar', async () => {
    mode = 'lost';
    const c = await sell(ids.cerveja, 2);
    expect((await askNote(c)).status).toBe('ERRO_COMUNICACAO');
    mode = 'ok';
    const before = sent.length;
    const res = (await admin({ method: 'POST', url: '/api/admin/fiscal/pending/resolve' })).json();
    expect(res).toMatchObject([{ status: 'AUTORIZADA', number: 4 }]);
    expect(sent.length).toBe(before + 1); // só a consulta
    const [doc] = await ctx.db.select().from(fiscalDocuments).where(eq(fiscalDocuments.number, 4));
    expect(doc).toMatchObject({ protocol: '231260000000099', totalCents: 3600 });
    expect(doc!.xml).toContain('<nProt>231260000000099</nProt>');
  });

  it('caixa em modo automático emite a nota ao quitar a conta', async () => {
    await admin({ method: 'PUT', url: `/api/admin/registers/${ids.register}`, payload: { name: 'Caixa 1', fiscalMode: 'AUTOMATICO' } });
    const c = (
      await garcom({ method: 'POST', url: '/api/waiter/comandas', payload: { clientUuid: randomUUID(), tableId: ids.mesa, customerName: 'Auto', phone: '(34) 99999-0001' } })
    ).json().id as string;
    await garcom({ method: 'POST', url: '/api/waiter/orders', payload: { clientUuid: randomUUID(), tableId: ids.mesa, comandaIds: [c], items: [{ productId: ids.cerveja, qty: 1 }], createdAtDevice: new Date().toISOString() } });
    const bill = (await caixa({ method: 'POST', url: '/api/cashier/bill', payload: { comandaIds: [c] } })).json();
    const pay = await caixa({
      method: 'POST',
      url: '/api/cashier/payments',
      payload: { clientUuid: randomUUID(), registerId: ids.register, comandaIds: [c], method: 'DEBITO', amountCents: bill.totals.remainingCents, payerName: 'X' },
    });
    expect(pay.json()).toMatchObject({ fiscalRequested: true, fiscal: { status: 'AUTORIZADA', number: 5 } });
    expect(sent.at(-1)!.body).toContain('<tPag>04</tPag>');
    await admin({ method: 'PUT', url: `/api/admin/registers/${ids.register}`, payload: { name: 'Caixa 1', fiscalMode: 'PERGUNTAR' } });
  });

  it('produto sem NCM: não envia e diz qual produto falta', async () => {
    const before = sent.length;
    const r = await askNote(await sell(ids.semNcm, 1));
    expect(r.status).toBe('REJEITADA');
    expect(r.message).toMatch(/sem NCM: Suco/);
    expect(sent.length).toBe(before);
  });

  it('nota de teste pela tela Fiscal (só em homologação)', async () => {
    const r = (await admin({ method: 'POST', url: '/api/admin/fiscal/test-note' })).json() as NfceEmitResult;
    expect(r).toMatchObject({ status: 'AUTORIZADA', environment: 'HOMOLOGACAO' });
    expect(r.number).toBe(6);
  });
});
