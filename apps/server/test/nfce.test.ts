import { createHash, createPublicKey, verify } from 'node:crypto';
import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { assembleNfe } from '../src/fiscal/nfce/assemble';
import { buildNfce, dhBrasilia, proportional, xmlText, type NfceInput } from '../src/fiscal/nfce/build';
import { HOMOLOGACAO_TEXTO } from '../src/fiscal/nfce/constants';
import { accessKey, keyCheckDigit } from '../src/fiscal/nfce/key';
import { sefazClient, tagValue, type Transport } from '../src/fiscal/nfce/sefaz';
import { openCertificate } from '../src/fiscal/nfce/sign';

/** Certificado de teste (autoassinado), no formato .pfx como o A1. */
function testPfx(password = 'senha') {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: 'BAR TESTE LTDA:34269717000155' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}

const input = (over: Partial<NfceInput> = {}): NfceInput => ({
  env: 'HOMOLOGACAO',
  series: 1,
  number: 74738,
  cNF: '12345678',
  issuedAt: new Date('2026-10-26T23:16:54Z'),
  emitter: {
    cnpj: '34269717000155',
    ie: '0034971640010',
    legalName: 'BAR E RESTAURANTE ESQUINA DA TILAPIA LTDA',
    street: 'R ROBERTO MARGONARI',
    number: '1435',
    complement: '',
    district: 'LUIZOTE DE FREITAS',
    cityCode: '3170206',
    city: 'UBERLANDIA',
    uf: 'MG',
    zip: '38414465',
    phone: '(34) 9643-8817',
    crt: 1,
  },
  items: [
    { code: '32', name: 'HEINEKEN 600ML', ncm: '22030000', cest: '0302100', cfop: '5405', unit: 'UND', qty: 3, totalCents: 5400, discountCents: 0, csosn: '500', origin: '0', pisCofinsCst: '07' },
    { code: '22', name: 'COSTELA TILÁPIA & FRITAS', ncm: '21069090', cest: null, cfop: '5102', unit: 'UND', qty: 1, totalCents: 4500, discountCents: 0, csosn: '102', origin: '0', pisCofinsCst: '07' },
  ],
  payments: [{ tPag: '17', amountCents: 9900 }],
  respTec: { cnpj: '11222333000181', contact: 'Paulo Faria', email: 'contato@exemplo.com.br', phone: '34999990000' },
  appVersion: 'SistemaBar 0.14.14',
  ...over,
});

describe('NFC-e: chave de acesso', () => {
  it('dígito verificador confere com uma nota real autorizada pela SEFAZ-MG', () => {
    const real = '31261034269717000155650010000747371239389914';
    expect(keyCheckDigit(real.slice(0, 43))).toBe(Number(real[43]));
    const { key } = accessKey({ cUF: '31', yearMonth: '2610', cnpj: '34269717000155', series: 1, number: 74737, tpEmis: 1, cNF: '23938991' });
    expect(key).toBe(real);
  });

  it('data e hora no fuso de Brasília', () => {
    expect(dhBrasilia(new Date('2026-10-22T00:16:54Z'))).toBe('2026-10-21T21:16:54-03:00');
  });
});

describe('NFC-e: XML', () => {
  it('monta a nota no formato da SEFAZ-MG (homologação troca o 1º item)', () => {
    const b = buildNfce(input());
    expect(b.accessKey).toMatch(/^3126103426971700015565001000074738\d{10}$/);
    expect(b.infNFe.startsWith(`<infNFe xmlns="http://www.portalfiscal.inf.br/nfe" Id="NFe${b.accessKey}" versao="4.00"><ide><cUF>31</cUF><cNF>12345678</cNF>`)).toBe(true);
    expect(b.infNFe).toContain('<tpAmb>2</tpAmb>');
    expect(b.infNFe).toContain(`<xProd>${HOMOLOGACAO_TEXTO}</xProd>`);
    expect(b.infNFe).toContain('<xProd>COSTELA TILÁPIA &amp; FRITAS</xProd>');
    expect(b.infNFe).toContain('<qCom>3.0000</qCom><vUnCom>18.0000000000</vUnCom><vProd>54.00</vProd>');
    expect(b.infNFe).toContain('<ICMSSN500><orig>0</orig><CSOSN>500</CSOSN></ICMSSN500>');
    expect(b.infNFe).toContain('<PISNT><CST>07</CST></PISNT>');
    expect(b.infNFe).toContain('<vNF>99.00</vNF>');
    expect(b.infNFe).toContain('<detPag><indPag>0</indPag><tPag>17</tPag><vPag>99.00</vPag></detPag>');
    expect(b.infNFe).toContain('<fone>3496438817</fone>');
    expect(b.infNFe).toContain('<infRespTec><CNPJ>11222333000181</CNPJ>');
    expect(b.infNFe).not.toMatch(/<(\w+)><\/\1>|<\w+\/>/); // sem tag vazia
    expect(b.totalCents).toBe(9900);
  });

  it('desconto rateado por item, cartão com o grupo <card>, CPF no destinatário', () => {
    const [d1, d2] = proportional(990, [5400, 4500]);
    const b = buildNfce(
      input({
        items: input().items.map((i, n) => ({ ...i, discountCents: n === 0 ? d1! : d2! })),
        payments: [
          { tPag: '01', amountCents: 3000 },
          { tPag: '04', amountCents: 5910 },
        ],
        cpf: '52998224725',
      }),
    );
    expect(d1! + d2!).toBe(990);
    expect(b.infNFe).toContain('<vDesc>9.90</vDesc><vII>');
    expect(b.infNFe).toContain('<vNF>89.10</vNF>');
    expect(b.infNFe).toContain('<tPag>04</tPag><vPag>59.10</vPag><card><tpIntegra>2</tpIntegra></card>');
    expect(b.infNFe).toContain(`<dest><CPF>52998224725</CPF><xNome>${HOMOLOGACAO_TEXTO}</xNome><indIEDest>9</indIEDest></dest>`);
  });

  it('recusa nota com pagamento menor que o total e CSOSN sem suporte', () => {
    expect(() => buildNfce(input({ payments: [{ tPag: '01', amountCents: 100 }] }))).toThrow(/menores que o total/);
    expect(() => buildNfce(input({ items: [{ ...input().items[0]!, csosn: '101' }] }))).toThrow(/CSOSN 101/);
    expect(xmlText('  a <b>  c  ')).toBe('a &lt;b&gt; c');
  });
});

describe('NFC-e: assinatura e QR Code', () => {
  it('assina o infNFe (RSA-SHA1, C14N) e a assinatura confere com a chave pública', () => {
    const cert = openCertificate(testPfx(), 'senha');
    const b = buildNfce(input());
    const { nfe, qrCode } = assembleNfe(b, 'HOMOLOGACAO', cert, { id: '000001', token: 'CSC-DE-TESTE' });

    const digest = tagValue(nfe, 'DigestValue')!;
    expect(digest).toBe(createHash('sha1').update(b.infNFe, 'utf8').digest('base64'));
    const signedInfo = nfe.match(/<SignedInfo>[\s\S]*<\/SignedInfo>/)![0].replace('<SignedInfo>', '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">');
    const ok = verify('RSA-SHA1', Buffer.from(signedInfo, 'utf8'), createPublicKey(cert.certPem), Buffer.from(tagValue(nfe, 'SignatureValue')!, 'base64'));
    expect(ok).toBe(true);
    expect(nfe).toContain(`<infNFe Id="NFe${b.accessKey}" versao="4.00">`);
    expect(nfe.indexOf('<infNFeSupl>')).toBeLessThan(nfe.indexOf('<Signature'));

    const base = `${b.accessKey}|2|2|1`;
    expect(qrCode).toBe(
      `https://hportalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=${base}|${createHash('sha1').update(`${base}CSC-DE-TESTE`).digest('hex')}`,
    );
  });
});

describe('NFC-e: webservice', () => {
  it('lê o status e o protocolo de autorização da resposta SOAP', async () => {
    const calls: { url: string; action: string; body: string }[] = [];
    const transport: Transport = async (url, action, body) => {
      calls.push({ url, action, body });
      if (url.endsWith('NFeStatusServico4')) {
        return '<soap:Envelope><soap:Body><nfeResultMsg><retConsStatServ versao="4.00"><tpAmb>2</tpAmb><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo></retConsStatServ></nfeResultMsg></soap:Body></soap:Envelope>';
      }
      return '<soap:Envelope><soap:Body><nfeResultMsg><retEnviNFe versao="4.00"><cStat>104</cStat><xMotivo>Lote processado</xMotivo><protNFe versao="4.00"><infProt><chNFe>X</chNFe><dhRecbto>2026-10-26T21:00:00-03:00</dhRecbto><nProt>131260000000001</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></retEnviNFe></nfeResultMsg></soap:Body></soap:Envelope>';
    };
    const client = sefazClient({ env: 'HOMOLOGACAO', uf: 'MG', cert: openCertificate(testPfx(), 'senha'), transport });
    expect(await client.status()).toMatchObject({ cStat: '107' });
    const r = await client.authorize('<NFe/>');
    expect(r).toMatchObject({ loteStat: '104', cStat: '100', nProt: '131260000000001' });
    expect(calls[0]!.url).toBe('https://hnfce.fazenda.mg.gov.br/nfce/services/NFeStatusServico4');
    expect(calls[0]!.body).toContain('<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><cUF>31</cUF>');
    expect(calls[1]!.action).toBe('http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote');
    expect(calls[1]!.body).toContain('<indSinc>1</indSinc><NFe/>');
  });
});
