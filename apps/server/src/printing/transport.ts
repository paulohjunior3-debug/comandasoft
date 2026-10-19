import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { paths } from '../paths';

const run = promisify(execFile);

export interface PrintTarget {
  id: string;
  name: string;
  windowsName: string;
}

/** Entrega os bytes à impressora. Lança erro com mensagem legível se não conseguir. */
export interface PrintTransport {
  mode: 'emulador' | 'windows';
  send(printer: PrintTarget, job: { id: string; bytes: Uint8Array; preview: string }): Promise<void>;
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'impressora';

/**
 * Emulador (SPEC 5.5, desenvolvimento sem impressora): grava a prévia em .txt e os bytes
 * ESC/POS em .bin, numa pasta por impressora.
 */
export function emulatorTransport(dir: string): PrintTransport {
  return {
    mode: 'emulador',
    async send(printer, job) {
      const folder = join(dir, slug(printer.name));
      await mkdir(folder, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = join(folder, `${stamp}-${job.id.slice(-6)}`);
      await writeFile(`${base}.txt`, `${job.preview}\n`, 'utf8');
      await writeFile(`${base}.bin`, job.bytes);
    },
  };
}

const RAW_SCRIPT = paths.rawPrintScript;

/**
 * Impressoras instaladas no Windows (rede ou USB), pelo nome da instalação (SPEC 12).
 * Os bytes vão em modo RAW para o spooler (WritePrinter), sem passar pelo driver gráfico.
 */
export function windowsTransport(): PrintTransport {
  return {
    mode: 'windows',
    async send(printer, job) {
      if (process.platform !== 'win32') throw new Error('Impressão pelo Windows só funciona no PC do caixa (Windows).');
      const file = join(tmpdir(), `sistema-bar-${job.id}.bin`);
      await writeFile(file, job.bytes);
      try {
        await run(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RAW_SCRIPT, '-PrinterName', printer.windowsName, '-Path', file],
          { timeout: 30_000, windowsHide: true },
        );
      } catch (err) {
        const e = err as { stderr?: string; killed?: boolean; message: string };
        if (e.killed) throw new Error('A impressora não respondeu em 30 segundos.');
        const detail = (e.stderr ?? '').split('\n').find((l) => l.trim().startsWith('ERRO:'))?.replace('ERRO:', '').trim();
        throw new Error(detail || `Falha ao enviar para "${printer.windowsName}".`);
      } finally {
        await rm(file, { force: true });
      }
    },
  };
}
