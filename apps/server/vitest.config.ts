import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Cada arquivo sobe um PostgreSQL em memória (PGlite), aplica as migrations e gera hashes
    // argon2: com vários arquivos em paralelo isso passa dos 10 s padrão em máquinas mais lentas.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
