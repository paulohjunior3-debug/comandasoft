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
  HTTPS_CERT: z.preprocess(emptyToUndefined, z.string().optional()),
  HTTPS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  /** emulador = grava os cupons em data/impressoes (desenvolvimento); windows = impressoras reais. */
  PRINT_MODE: z.enum(['emulador', 'windows']).default('emulador'),
  PRINT_EMULATOR_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
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
