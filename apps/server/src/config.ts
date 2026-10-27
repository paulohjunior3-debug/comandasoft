import { existsSync } from 'node:fs';
import { z } from 'zod';
import { paths } from './paths';

if (existsSync(paths.envFile)) process.loadEnvFile(paths.envFile);

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url('DATABASE_URL inválida'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de pelo menos 32 caracteres'),
  CPF_SECRET: z.string().min(32, 'CPF_SECRET precisa de pelo menos 32 caracteres'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Porta HTTP do QR do cliente (cardápio e comanda). Vazio = desligado. Instalado: 8080. */
  PUBLIC_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  HTTPS_CERT: z.preprocess(emptyToUndefined, z.string().optional()),
  HTTPS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Endereço próprio (ex.: sistema.esquinadatilapia.com.br), com certificado da Let's Encrypt. */
  DOMINIO: z.preprocess(emptyToUndefined, z.string().toLowerCase().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'DOMINIO inválido').optional()),
  /** Token da Cloudflare (Zone > DNS > Edit) do domínio: aponta o DNS e prova a posse para a Let's Encrypt. */
  CLOUDFLARE_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Porta HTTPS extra (padrão 443 com DOMINIO): o endereço próprio sem ":8443". 0 = desligada. */
  EXTRA_HTTPS_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(65535).optional()),
  ACME_EMAIL: z.preprocess(emptyToUndefined, z.string().email().optional()),
  /** Usa o ambiente de teste da Let's Encrypt (certificado não confiável; para testar sem gastar o limite). */
  ACME_STAGING: z.preprocess(emptyToUndefined, z.enum(['0', '1']).default('0')),
  /** emulador = grava os cupons em data/impressoes (desenvolvimento); windows = impressoras reais. */
  PRINT_MODE: z.enum(['emulador', 'windows']).default('emulador'),
  PRINT_EMULATOR_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Grava o log neste arquivo (instalado: data/logs/servidor.log). Vazio = saída padrão. */
  LOG_FILE: z.preprocess(emptyToUndefined, z.string().optional()),
  SEED_ADMIN_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida no .env:\n${issues}`);
  }
  return parsed.data;
}
