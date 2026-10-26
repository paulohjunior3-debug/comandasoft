import { request as httpsRequest } from 'node:https';
import { CUF, NFE_NS, SERVICES, serviceUrl, tpAmbOf, type Ambiente, type Service } from './constants';
import type { OpenedCertificate } from './sign';

/**
 * Cliente SOAP 1.2 dos webservices da NFC-e (SEFAZ-MG), com o certificado A1 no TLS (mTLS).
 * Erro de comunicação (rede, tempo esgotado) vira SefazCommError; resposta da SEFAZ (mesmo
 * rejeição) volta normal para quem chamou decidir. O Softcom misturava os dois casos e caía em
 * contingência em rejeição: foi assim que acumulou notas nunca autorizadas.
 */
export class SefazCommError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SefazCommError';
  }
}

export type Transport = (url: string, action: string, body: string, cert: OpenedCertificate, timeoutMs: number) => Promise<string>;

/** Transporte real: HTTPS com o certificado do cliente. */
export const httpsTransport: Transport = (url, action, body, cert, timeoutMs) => {
  const attempt = (strict: boolean) =>
    new Promise<string>((resolve, reject) => {
      const u = new URL(url);
      const req = httpsRequest(
        {
          hostname: u.hostname,
          path: u.pathname,
          method: 'POST',
          key: cert.keyPem,
          cert: [cert.certPem, ...cert.chainPem].join('\n'),
          // A cadeia ICP-Brasil da SEFAZ nem sempre está no Windows/Node; sem ela, tenta de novo sem conferir.
          rejectUnauthorized: strict,
          minVersion: 'TLSv1.2',
          headers: {
            'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"`,
            'Content-Length': Buffer.byteLength(body, 'utf8'),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 500) >= 500 && !/<(?:\w+:)?Envelope/.test(text)) {
              reject(new SefazCommError(`SEFAZ respondeu HTTP ${res.statusCode}.`));
            } else resolve(text);
          });
        },
      );
      req.on('timeout', () => req.destroy(new SefazCommError('Tempo esgotado esperando a SEFAZ.')));
      req.on('error', (err: NodeJS.ErrnoException) => reject(err));
      req.end(body, 'utf8');
    });
  return attempt(true).catch((err: NodeJS.ErrnoException) => {
    const tlsTrust = /certificate|self.signed|issuer/i.test(`${err.code ?? ''} ${err.message}`);
    if (tlsTrust) return attempt(false);
    throw err instanceof SefazCommError ? err : new SefazCommError(`Sem comunicação com a SEFAZ: ${err.message}`);
  }).catch((err: unknown) => {
    throw err instanceof SefazCommError ? err : new SefazCommError(`Sem comunicação com a SEFAZ: ${(err as Error).message}`);
  });
};

function envelope(service: Service, content: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>' +
    `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/${SERVICES[service].wsdl}">${content}</nfeDadosMsg>` +
    '</soap12:Body></soap12:Envelope>'
  );
}

/** Primeira ocorrência de uma tag (ignora prefixo de namespace). */
export function tagValue(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? m[1]!.trim() : null;
}

/** Bloco inteiro de uma tag (com a própria tag). */
export function tagBlock(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>[\\s\\S]*?</(?:\\w+:)?${name}>`));
  return m ? m[0] : null;
}

export interface SefazClientOptions {
  env: Ambiente;
  uf: string;
  cert: OpenedCertificate;
  transport?: Transport;
  timeoutMs?: number;
}

export function sefazClient({ env, uf, cert, transport = httpsTransport, timeoutMs = 15_000 }: SefazClientOptions) {
  const call = (service: Service, content: string) =>
    transport(serviceUrl(env, service), `http://www.portalfiscal.inf.br/nfe/wsdl/${SERVICES[service].wsdl}/${SERVICES[service].action}`, envelope(service, content), cert, timeoutMs);
  const tpAmb = tpAmbOf(env);

  return {
    /** Status do serviço (107 = em operação). */
    async status() {
      const xml = await call('status', `<consStatServ xmlns="${NFE_NS}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><cUF>${CUF[uf]}</cUF><xServ>STATUS</xServ></consStatServ>`);
      return { cStat: tagValue(xml, 'cStat'), xMotivo: tagValue(xml, 'xMotivo'), dhRecbto: tagValue(xml, 'dhRecbto'), raw: xml };
    },

    /**
     * Autorização síncrona de uma NFC-e (lote de uma nota). Devolve o protNFe quando a SEFAZ
     * processou a nota (100 autorizada, ou o código da rejeição).
     */
    async authorize(signedNFe: string) {
      const content = `<enviNFe xmlns="${NFE_NS}" versao="4.00"><idLote>${Date.now() % 1e15}</idLote><indSinc>1</indSinc>${signedNFe}</enviNFe>`;
      const xml = await call('autorizacao', content);
      const prot = tagBlock(xml, 'protNFe');
      const inner = prot ?? xml;
      return {
        loteStat: tagValue(xml, 'cStat'),
        loteMotivo: tagValue(xml, 'xMotivo'),
        cStat: prot ? tagValue(inner, 'cStat') : null,
        xMotivo: prot ? tagValue(inner, 'xMotivo') : null,
        nProt: prot ? tagValue(inner, 'nProt') : null,
        dhRecbto: prot ? tagValue(inner, 'dhRecbto') : null,
        protNFe: prot,
        raw: xml,
      };
    },

    /** Situação de uma nota pela chave (para reenvio depois de falha de comunicação). */
    async consult(key: string) {
      const xml = await call('consulta', `<consSitNFe xmlns="${NFE_NS}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><xServ>CONSULTAR</xServ><chNFe>${key}</chNFe></consSitNFe>`);
      return { cStat: tagValue(xml, 'cStat'), xMotivo: tagValue(xml, 'xMotivo'), protNFe: tagBlock(xml, 'protNFe'), raw: xml };
    },
  };
}
export type SefazClient = ReturnType<typeof sefazClient>;
