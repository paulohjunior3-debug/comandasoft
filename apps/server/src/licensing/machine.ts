import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Impressão digital da máquina: SHA-256 de "sistema-bar|<MachineGuid>" em 4 grupos de 4.
 * O instalador calcula igual (instalador/comum.ps1, Codigo-Maquina) para o cliente mandar ao dono.
 */
export function machineFingerprint(machineGuid: string): string {
  const hex = createHash('sha256').update(`sistema-bar|${machineGuid.trim().toLowerCase()}`, 'utf8').digest('hex');
  return hex.slice(0, 16).toUpperCase().match(/.{4}/g)!.join('-');
}

/**
 * Lê o MachineGuid do Windows direto do registro (não do .env, que o cliente consegue editar).
 * Fora do Windows (desenvolvimento) ou se falhar: null.
 */
export async function readMachineId(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], {
      windowsHide: true,
      timeout: 10_000,
    });
    const guid = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(stdout)?.[1];
    return guid ? machineFingerprint(guid) : null;
  } catch {
    return null;
  }
}
