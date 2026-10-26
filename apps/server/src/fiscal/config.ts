import { DEFAULT_FISCAL_SETTINGS, fiscalSettingsSchema, type CertificateInfo, type FiscalEnvironment, type FiscalSettings } from '@sistema-bar/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { fiscalConfig } from '../db/schema';

/**
 * Configuração fiscal: a linha 'main' tem o emitente, a numeração de produção, o CSC de
 * produção e o certificado; a linha 'homologacao' tem o CSC e a numeração dos testes (a SEFAZ
 * dá um CSC para cada ambiente, e a numeração de teste não pode gastar a de produção).
 */
export const MAIN = 'main';
export const HOMOLOGACAO = 'homologacao';
const DAY = 24 * 60 * 60 * 1000;

export type ConfigRow = typeof fiscalConfig.$inferSelect;

export async function configRow(db: Pick<Db, 'select'>, key = MAIN): Promise<ConfigRow | null> {
  const [row] = await db.select().from(fiscalConfig).where(eq(fiscalConfig.key, key));
  return row ?? null;
}

export function settingsOf(row: ConfigRow | null): FiscalSettings {
  const parsed = fiscalSettingsSchema.safeParse({ ...DEFAULT_FISCAL_SETTINGS, ...((row?.data as object | undefined) ?? {}) });
  return parsed.success ? parsed.data : DEFAULT_FISCAL_SETTINGS;
}

export function certificateOf(row: ConfigRow | null): CertificateInfo | null {
  if (!row?.certPfxEnc || !row.certValidUntil || !row.certValidFrom || !row.certUploadedAt) return null;
  return {
    subject: row.certSubject ?? '',
    cnpj: row.certCnpj,
    validFrom: row.certValidFrom.toISOString(),
    validUntil: row.certValidUntil.toISOString(),
    uploadedAt: row.certUploadedAt.toISOString(),
    daysLeft: Math.floor((row.certValidUntil.getTime() - Date.now()) / DAY),
  };
}

/** Grava (cria ou atualiza) uma linha da configuração fiscal. */
export async function upsertConfig(db: Pick<Db, 'insert'>, values: Partial<typeof fiscalConfig.$inferInsert> & { data?: unknown }, key = MAIN) {
  await db
    .insert(fiscalConfig)
    .values({ key, data: values.data ?? (key === MAIN ? DEFAULT_FISCAL_SETTINGS : { nextNumber: 1, series: 1 }), ...values })
    .onConflictDoUpdate({ target: fiscalConfig.key, set: values });
}

/** Linha do CSC de cada ambiente. */
export const cscKeyOf = (env: FiscalEnvironment) => (env === 'PRODUCAO' ? MAIN : HOMOLOGACAO);
