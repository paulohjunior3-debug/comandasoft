import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Definido como true pelo empacotador (esbuild) no servidor instalado. */
declare const __SISTEMA_BAR_BUNDLE__: boolean | undefined;

const here = dirname(fileURLToPath(import.meta.url));
const bundled = typeof __SISTEMA_BAR_BUNDLE__ !== 'undefined' && __SISTEMA_BAR_BUNDLE__;

/**
 * Raiz do sistema. No desenvolvimento é a raiz do repositório; instalado, é a pasta da
 * instalação (ex.: C:\SistemaBar), onde o servidor fica em app\server.mjs. O pacote mantém
 * o mesmo layout do repositório para migrations, PWA e scripts, então os caminhos são iguais.
 * SISTEMA_BAR_HOME no ambiente sobrepõe tudo.
 */
export const HOME = process.env.SISTEMA_BAR_HOME
  ? resolve(process.env.SISTEMA_BAR_HOME)
  : bundled
    ? resolve(here, '..')
    : resolve(here, '../../..');

export const paths = {
  home: HOME,
  envFile: join(HOME, '.env'),
  migrations: join(HOME, 'apps', 'server', 'drizzle'),
  webDist: join(HOME, 'apps', 'web', 'dist'),
  rawPrintScript: join(HOME, 'apps', 'server', 'scripts', 'raw-print.ps1'),
  emulatorDir: join(HOME, 'data', 'impressoes'),
  backupsDir: join(HOME, 'data', 'backups'),
  /** Caminho do .env (ex.: certs/dev-cert.pem) relativo à raiz. */
  fromHome: (p: string) => resolve(HOME, p),
};

/** Versão do sistema: VERSAO.txt na instalação, package.json da raiz no repositório. */
export function appVersion(): string {
  try {
    const file = join(HOME, 'VERSAO.txt');
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    return (JSON.parse(readFileSync(join(HOME, 'package.json'), 'utf8')) as { version?: string }).version ?? 'dev';
  } catch {
    return 'dev';
  }
}
