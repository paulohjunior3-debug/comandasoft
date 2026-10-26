import { createHash, createSign } from 'node:crypto';
import forge from 'node-forge';

/**
 * Certificado A1 aberto: chave privada e certificado em PEM (para assinar e para o TLS com a
 * SEFAZ). Usa o node-forge porque muitos .pfx de certificadoras usam cifras antigas que o
 * OpenSSL 3 do Node não abre direto.
 */
export interface OpenedCertificate {
  keyPem: string;
  certPem: string;
  /** Certificado em base64 (DER), para o <X509Certificate> da assinatura. */
  certBase64: string;
  /** Cadeia da certificadora (se veio no .pfx), para o TLS. */
  chainPem: string[];
}

export function openCertificate(pfx: Buffer, password: string): OpenedCertificate {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  const CERT_BAG = forge.pki.oids.certBag!;
  const SHROUDED = forge.pki.oids.pkcs8ShroudedKeyBag!;
  const KEY_BAG = forge.pki.oids.keyBag!;
  const key = [...(p12.getBags({ bagType: SHROUDED })[SHROUDED] ?? []), ...(p12.getBags({ bagType: KEY_BAG })[KEY_BAG] ?? [])][0]?.key;
  if (!key) throw new Error('O certificado não tem a chave privada.');
  const certs = (p12.getBags({ bagType: CERT_BAG })[CERT_BAG] ?? []).map((b) => b.cert).filter((c): c is forge.pki.Certificate => Boolean(c));
  const isCa = (c: forge.pki.Certificate) => c.extensions.some((e: { name?: string; cA?: boolean }) => e.name === 'basicConstraints' && e.cA);
  const own = certs.find((c) => !isCa(c)) ?? certs[0];
  if (!own) throw new Error('Nenhum certificado no arquivo.');
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(own)).getBytes();
  return {
    keyPem: forge.pki.privateKeyToPem(key),
    certPem: forge.pki.certificateToPem(own),
    certBase64: forge.util.encode64(der),
    chainPem: certs.filter((c) => c !== own).map((c) => forge.pki.certificateToPem(c)),
  };
}

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const DSIG = 'http://www.w3.org/2000/09/xmldsig#';

/**
 * Assinatura XMLDSig da NFC-e (padrão do Manual do Contribuinte): RSA-SHA1, C14N, enveloped,
 * referência ao Id do infNFe. `canonicalInfNFe` precisa estar na forma canônica (o build já gera
 * assim, com o namespace no próprio elemento). Devolve o elemento <Signature>.
 */
export function signInfNFe(canonicalInfNFe: string, id: string, cert: OpenedCertificate): string {
  const digest = createHash('sha1').update(canonicalInfNFe, 'utf8').digest('base64');
  const signedInfo =
    '<SignedInfo>' +
    `<CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${DSIG}rsa-sha1"></SignatureMethod>` +
    `<Reference URI="#${id}">` +
    '<Transforms>' +
    `<Transform Algorithm="${DSIG}enveloped-signature"></Transform>` +
    `<Transform Algorithm="${C14N}"></Transform>` +
    '</Transforms>' +
    `<DigestMethod Algorithm="${DSIG}sha1"></DigestMethod>` +
    `<DigestValue>${digest}</DigestValue>` +
    '</Reference>' +
    '</SignedInfo>';
  // Forma canônica do SignedInfo dentro do <Signature>: herda o namespace do xmldsig.
  const canonicalSignedInfo = signedInfo.replace('<SignedInfo>', `<SignedInfo xmlns="${DSIG}">`);
  const value = createSign('RSA-SHA1').update(canonicalSignedInfo, 'utf8').sign(cert.keyPem, 'base64');
  return (
    `<Signature xmlns="${DSIG}">` +
    signedInfo +
    `<SignatureValue>${value}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${cert.certBase64}</X509Certificate></X509Data></KeyInfo>` +
    '</Signature>'
  );
}

/** Assina um elemento qualquer que já esteja na forma canônica (evento de cancelamento, inutilização). */
export const signElement = signInfNFe;
