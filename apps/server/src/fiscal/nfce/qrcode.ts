import { createHash } from 'node:crypto';
import { CHAVE_URL, QR_URL, tpAmbOf, type Ambiente } from './constants';

/**
 * QR Code da NFC-e, versão 2, emissão normal (online):
 * p = chave|2|tpAmb|idCSC|hash, hash = SHA-1 (hex) de "chave|2|tpAmb|idCSC" seguido do CSC.
 * O idCSC vai sem zeros à esquerda (o Softcom mandava 0 por engano e a SEFAZ rejeitava: 462).
 */
export function qrCodeOnline(env: Ambiente, key: string, cscId: string, csc: string): string {
  const id = String(Number(cscId));
  const base = `${key}|2|${tpAmbOf(env)}|${id}`;
  const hash = createHash('sha1').update(base + csc, 'utf8').digest('hex');
  return `${QR_URL[env]}?p=${base}|${hash}`;
}

/** Grupo <infNFeSupl> (vai depois do infNFe, antes da assinatura). */
export function infNFeSupl(env: Ambiente, qrCode: string): string {
  return `<infNFeSupl><qrCode><![CDATA[${qrCode}]]></qrCode><urlChave>${CHAVE_URL[env]}</urlChave></infNFeSupl>`;
}
