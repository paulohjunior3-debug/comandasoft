/**
 * Formato dos textos de licença e lease: `SB1.<JSON em base64url>.<assinatura Ed25519 em base64url>`.
 * A assinatura cobre `SB1.<JSON em base64url>`. Só WebCrypto (sem Buffer/node:crypto), porque o
 * mesmo código roda no servidor, no CLI do dono e no Cloudflare Worker.
 */

import type { webcrypto } from 'node:crypto';

/** Só o tipo (apagado no build): o Worker não tem node:crypto. */
export type CryptoKey = webcrypto.CryptoKey;

export const TOKEN_PREFIX = 'SB1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const ED25519 = { name: 'Ed25519' } as const;

/** Chave pública embutida: 32 bytes em base64url. */
export function importPublicKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64Url(raw), ED25519, false, ['verify']);
}

/** Chave privada guardada pelo dono (ou segredo do Worker): PKCS#8 em base64url. */
export function importPrivateKey(pkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', fromBase64Url(pkcs8), ED25519, false, ['sign']);
}

/** Par novo, já no formato de guardar (CLI `chaves`). */
export async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { publicKey: toBase64Url(raw), privateKey: toBase64Url(pkcs8) };
}

export async function signToken(payload: object, privateKey: CryptoKey): Promise<string> {
  const body = `${TOKEN_PREFIX}.${toBase64Url(encoder.encode(JSON.stringify(payload)))}`;
  const signature = new Uint8Array(await crypto.subtle.sign(ED25519, privateKey, encoder.encode(body)));
  return `${body}.${toBase64Url(signature)}`;
}

/** Lê o JSON sem conferir a assinatura (para saber o tipo e escolher a chave). */
export function peekToken(token: string): unknown {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  try {
    return JSON.parse(decoder.decode(fromBase64Url(parts[1]!)));
  } catch {
    return null;
  }
}

/** JSON do texto se a assinatura bate com alguma das chaves; senão null. */
export async function verifyToken(token: string, publicKeys: CryptoKey[]): Promise<unknown> {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = fromBase64Url(parts[2]!);
  } catch {
    return null;
  }
  const data = encoder.encode(`${parts[0]}.${parts[1]}`);
  for (const key of publicKeys) {
    if (await crypto.subtle.verify(ED25519, key, signature, data)) return peekToken(token);
  }
  return null;
}
