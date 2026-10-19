import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InstalledPrinter } from '@sistema-bar/shared';

const run = promisify(execFile);

export type ListInstalledPrinters = () => Promise<InstalledPrinter[]>;

/**
 * Guarda o resultado por `ttlMs` e compartilha a consulta em andamento:
 * o `Get-Printer` leva alguns segundos e é chamado em várias telas.
 */
export function cachedLister(list: ListInstalledPrinters, ttlMs = 30_000): ListInstalledPrinters {
  let cache: { at: number; value: Promise<InstalledPrinter[]> } | null = null;
  return () => {
    if (!cache || Date.now() - cache.at > ttlMs) {
      const value = list();
      cache = { at: Date.now(), value };
      value.catch(() => {
        if (cache?.value === value) cache = null; // não guarda falha
      });
    }
    return cache.value;
  };
}

/**
 * Lista as impressoras instaladas no Windows do PC do caixa (rede ou USB), pelo `Get-Printer`.
 * Fora do Windows devolve lista vazia (desenvolvimento em outros sistemas).
 */
export const listWindowsPrinters: ListInstalledPrinters = async () => {
  if (process.platform !== 'win32') return [];
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
        'Get-Printer | Select-Object Name, DriverName, PortName | ConvertTo-Json -Compress',
    ],
    { timeout: 15_000, windowsHide: true },
  );
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as {
    Name: string;
    DriverName?: string | null;
    PortName?: string | null;
  }[];
  return rows
    .map((r) => ({ name: r.Name, driverName: r.DriverName ?? null, portName: r.PortName ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
};
