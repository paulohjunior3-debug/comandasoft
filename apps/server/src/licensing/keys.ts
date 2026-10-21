import { importPublicKey, type CryptoKey } from './token';

/**
 * Chaves públicas embutidas no servidor (32 bytes em base64url), geradas por `pnpm licenca chaves`.
 * As privadas ficam só com o dono (raiz) e no servidor de licenças (renovação). Lista para permitir
 * trocar de chave sem invalidar as licenças já emitidas.
 */
export const EMBEDDED_PUBLIC_KEYS = {
  root: ['yYmI-c4BZJ5J3tUSg-CSwqH_yeQrHGEPZXM4oATGcdg'],
  renewal: ['rs2PgDYb3-5Xl0Aj_w0NXvMJKFCAg1S3EtAlSJDyaTk'],
};

export interface LicenseKeys {
  root: CryptoKey[];
  renewal: CryptoKey[];
}

export async function loadEmbeddedKeys(): Promise<LicenseKeys> {
  return {
    root: await Promise.all(EMBEDDED_PUBLIC_KEYS.root.map(importPublicKey)),
    renewal: await Promise.all(EMBEDDED_PUBLIC_KEYS.renewal.map(importPublicKey)),
  };
}
