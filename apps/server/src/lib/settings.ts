import { DEFAULT_SETTINGS, settingsSchema, type Settings } from '@sistema-bar/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { settings } from '../db/schema';

const KEY = 'app';

/** Configurações do estabelecimento, com os padrões preenchendo o que ainda não foi salvo. */
export async function getSettings(db: Db): Promise<Settings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  const merged = { ...DEFAULT_SETTINGS, ...((row?.valueJson as Partial<Settings> | undefined) ?? {}) };
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(db: Pick<Db, 'insert'>, value: Settings) {
  await db
    .insert(settings)
    .values({ key: KEY, valueJson: value })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson: value, updatedAt: new Date() } });
}
