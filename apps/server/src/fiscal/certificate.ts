import forge from 'node-forge';
import { HttpError } from '../lib/errors';

export interface ParsedCertificate {
  subject: string;
  cnpj: string | null;
  validFrom: Date;
  validUntil: Date;
}

/**
 * Abre o certificado A1 (.pfx/.p12) com a senha e lê titular, CNPJ e validade.
 * Não guarda nada: quem chama decide o que cifrar e gravar.
 */
export function parsePfx(pfx: Buffer, password: string): ParsedCertificate {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch {
    throw new HttpError(400, 'CERT_INVALID', 'Não foi possível abrir o certificado: senha incorreta ou arquivo que não é um certificado A1 (.pfx).');
  }
  // Tipos de "bag" do PKCS#12 (OIDs fixos): certificado, chave cifrada e chave aberta.
  const CERT_BAG = '1.2.840.113549.1.12.10.1.3';
  const SHROUDED_KEY_BAG = '1.2.840.113549.1.12.10.1.2';
  const KEY_BAG = '1.2.840.113549.1.12.10.1.1';
  const certs = p12.getBags({ bagType: CERT_BAG })[CERT_BAG] ?? [];
  const keys = [...(p12.getBags({ bagType: SHROUDED_KEY_BAG })[SHROUDED_KEY_BAG] ?? []), ...(p12.getBags({ bagType: KEY_BAG })[KEY_BAG] ?? [])];
  if (!keys.length) throw new HttpError(400, 'CERT_INVALID', 'O arquivo não tem a chave privada. Exporte o certificado A1 completo (.pfx com chave).');
  // O certificado do titular é o que não é autoridade certificadora.
  const isCa = (c: forge.pki.Certificate) => c.extensions.some((e: { name?: string; cA?: boolean }) => e.name === 'basicConstraints' && e.cA);
  const list = certs.map((bag: forge.pkcs12.Bag) => bag.cert).filter((c): c is forge.pki.Certificate => Boolean(c));
  const cert = list.find((c) => !isCa(c)) ?? list[0];
  if (!cert) throw new HttpError(400, 'CERT_INVALID', 'Nenhum certificado encontrado no arquivo.');

  const cn = String(cert.subject.getField('CN')?.value ?? '');
  const org = String(cert.subject.getField('O')?.value ?? '');
  // ICP-Brasil: o CN costuma ser "RAZÃO SOCIAL:CNPJ"; senão, procura no nome alternativo (otherName).
  let cnpj = cn.match(/(\d{14})/)?.[1] ?? null;
  if (!cnpj) {
    const san = cert.getExtension('subjectAltName') as { altNames?: { type: number; value?: unknown }[] } | null;
    for (const alt of san?.altNames ?? []) {
      const m = alt.type === 0 && typeof alt.value === 'string' ? alt.value.match(/\d{14}/) : null;
      if (m) cnpj = m[0];
    }
  }

  return {
    subject: cn || org || 'Certificado sem nome',
    cnpj,
    validFrom: cert.validity.notBefore,
    validUntil: cert.validity.notAfter,
  };
}
