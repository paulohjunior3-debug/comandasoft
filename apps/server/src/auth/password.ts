import { hash, verify } from '@node-rs/argon2';

// Parâmetros argon2id (OWASP): 19 MiB, 2 iterações.
const options = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, options);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Usado quando o login não existe, para o tempo de resposta não revelar quais usuários existem.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('senha-inexistente');
  await verifyPassword(await dummyHash, password);
}
