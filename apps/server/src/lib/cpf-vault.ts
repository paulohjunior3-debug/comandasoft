import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { cpfLast3, onlyDigits } from '@sistema-bar/shared';

/**
 * Proteção do CPF (SPEC 6 e LGPD). O número nunca é gravado em claro:
 * - `hmac`: busca pelo CPF no caixa (determinístico, impossível de reverter sem o segredo);
 * - `encrypted`: AES-256-GCM, só para "CPF na nota" da NFC-e;
 * - `last3`: PIN do QR do cliente.
 *
 * As duas chaves derivam de CPF_SECRET. Trocar o segredo depois de ter comandas
 * impede a busca e a leitura dos CPFs já gravados.
 */
export function createCpfVault(secret: string) {
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', secret, 'sistema-bar', info, 32));
  const hmacKey = derive('cpf-hmac');
  const encKey = derive('cpf-enc');

  return {
    protect(cpf: string) {
      const digits = onlyDigits(cpf);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encKey, iv);
      const ct = Buffer.concat([cipher.update(digits, 'utf8'), cipher.final()]);
      return {
        hmac: this.hmac(digits),
        encrypted: Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64'),
        last3: cpfLast3(digits),
      };
    },

    hmac(cpf: string) {
      return createHmac('sha256', hmacKey).update(onlyDigits(cpf)).digest('hex');
    },

    reveal(encrypted: string) {
      const buf = Buffer.from(encrypted, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', encKey, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

export type CpfVault = ReturnType<typeof createCpfVault>;
