import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Segredos guardados no banco (CSC, certificado A1 e a senha dele): AES-256-GCM com chave
 * derivada do CPF_SECRET do .env. Sem o .env, o banco sozinho (ou um backup vazado) não abre.
 */
export function createSecretBox(secret: string, purpose = 'fiscal') {
  const key = Buffer.from(hkdfSync('sha256', secret, 'sistema-bar', `${purpose}-enc`, 32));
  return {
    seal(plain: Buffer | string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
    },
    open(sealed: string): Buffer {
      const buf = Buffer.from(sealed, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
    },
  };
}

export type SecretBox = ReturnType<typeof createSecretBox>;
