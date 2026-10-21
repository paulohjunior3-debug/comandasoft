// Gera o pacote de instalação para o PC do caixa: dist-instalador\SistemaBar-<versão>.zip
//
// O PC do bar não precisa de pnpm nem do código-fonte: o servidor vira um arquivo só
// (app\server.mjs), a PWA vai já montada, e o pacote mantém o mesmo layout do repositório
// para migrations, PWA e scripts (ver apps/server/src/paths.ts).
//
// Uso (na raiz do projeto): pnpm empacotar
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, 'dist-instalador');
const pkg = join(out, `SistemaBar-${version}`);
const step = (msg) => console.log(`\n> ${msg}`);

step(`Empacotando Sistema Bar ${version}`);
rmSync(pkg, { recursive: true, force: true });
mkdirSync(join(pkg, 'app'), { recursive: true });

step('Montando a PWA');
execSync('pnpm --filter @sistema-bar/web build', { cwd: root, stdio: 'inherit' });

step('Gerando o servidor em um arquivo (esbuild)');
await build({
  entryPoints: { server: join(root, 'apps/server/src/index.ts'), cli: join(root, 'apps/server/src/cli.ts') },
  outdir: join(pkg, 'app'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Módulo nativo (binário por sistema): vai copiado em app\node_modules.
  external: ['@node-rs/argon2'],
  define: { __SISTEMA_BAR_BUNDLE__: 'true' },
  // Dependências CommonJS dentro de um bundle ESM precisam de require/__dirname.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __fu } from 'node:url';",
      "import { dirname as __dn } from 'node:path';",
      'const require = __cr(import.meta.url);',
      'const __filename = __fu(import.meta.url);',
      'const __dirname = __dn(__filename);',
    ].join('\n'),
  },
  legalComments: 'none',
  logLevel: 'warning',
});

step('Copiando o módulo nativo do argon2 (senhas)');
const serverRequire = createRequire(join(root, 'apps/server/package.json'));
const argonDir = dirname(realpathSync(serverRequire.resolve('@node-rs/argon2/package.json')));
const argonRequire = createRequire(join(argonDir, 'package.json'));
const binaryName = '@node-rs/argon2-win32-x64-msvc';
let binaryDir;
try {
  binaryDir = dirname(realpathSync(argonRequire.resolve(`${binaryName}/package.json`)));
} catch {
  throw new Error(`${binaryName} não encontrado. Rode o empacotador num Windows 64 bits com "pnpm install" feito.`);
}
cpSync(argonDir, join(pkg, 'app/node_modules/@node-rs/argon2'), { recursive: true, dereference: true });
cpSync(binaryDir, join(pkg, `app/node_modules/${binaryName}`), { recursive: true, dereference: true });
// O bundle é ESM: marca a pasta para o Node tratar .mjs/.js corretamente.
writeFileSync(join(pkg, 'app/package.json'), JSON.stringify({ type: 'module', private: true }, null, 2));

step('Copiando migrations, PWA, scripts e cardápios');
const copy = (from, to) => cpSync(join(root, from), join(pkg, to ?? from), { recursive: true });
copy('apps/server/drizzle');
copy('apps/server/scripts/raw-print.ps1');
copy('apps/web/dist');
copy('apps/server/seeds', 'cardapios');
copy('.env.example');

// Windows PowerShell 5.1 só lê acentos corretamente em .ps1 com BOM UTF-8;
// .bat e .txt vão com quebra de linha do Windows (CRLF) para o Bloco de Notas.
const BOM = String.fromCharCode(0xfeff);
const toCrlf = (text) => text.split('\r\n').join('\n').split('\n').join('\r\n');
const installerFiles = [
  'instalar.ps1',
  'atualizar.ps1',
  'desinstalar.ps1',
  'comum.ps1',
  'servico.ps1',
  'vigia.ps1',
  'reiniciar.ps1',
  'gerar-certificado.ps1',
  'INSTALAR.bat',
  'ATUALIZAR.bat',
  'REINICIAR.bat',
  'LEIA-ME.txt',
];
for (const f of installerFiles) {
  let text = readFileSync(join(root, 'instalador', f), 'utf8');
  if (text.startsWith(BOM)) text = text.slice(1);
  text = toCrlf(text);
  writeFileSync(join(pkg, f), f.endsWith('.ps1') ? BOM + text : text, 'utf8');
}
writeFileSync(join(pkg, 'VERSAO.txt'), `${version}\r\n`);

step('Compactando');
const zip = join(out, `SistemaBar-${version}.zip`);
rmSync(zip, { force: true });
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${pkg}\\*' -DestinationPath '${zip}' -Force`], {
  stdio: 'inherit',
});

if (!existsSync(zip)) throw new Error('Falha ao gerar o zip.');
console.log(`\nPronto: ${zip}`);
console.log('Copie o zip para o PC do caixa (pendrive), extraia e rode INSTALAR.bat.');
