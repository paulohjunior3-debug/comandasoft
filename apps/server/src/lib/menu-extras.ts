import { MENU_BADGES, type MenuBadge } from '@sistema-bar/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { settings } from '../db/schema';
import type { Queryable } from './billing';

/**
 * Destaques (⭐) e selos do cardápio do cliente. Ficam numa linha própria de `settings` (sem
 * coluna nova em products).
 */
const KEY = 'menu-extras';
const extrasSchema = z.object({
  featured: z.array(z.string().uuid()).default([]),
  badges: z.record(z.string(), z.array(z.enum(MENU_BADGES))).default({}),
});
export type MenuExtras = z.infer<typeof extrasSchema>;

export async function getMenuExtras(db: Pick<Queryable, 'select'>): Promise<MenuExtras> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  const parsed = extrasSchema.safeParse(row?.valueJson ?? {});
  return parsed.success ? parsed.data : { featured: [], badges: {} };
}

/** Grava o destaque e os selos de um produto (null = produto apagado: tira dos extras). */
export async function setProductExtras(db: Queryable, productId: string, value: { featured: boolean; badges: MenuBadge[] } | null) {
  const current = await getMenuExtras(db);
  const featured = current.featured.filter((id) => id !== productId);
  if (value?.featured) featured.push(productId);
  const badges = { ...current.badges };
  if (value?.badges.length) badges[productId] = value.badges;
  else delete badges[productId];
  const next: MenuExtras = { featured, badges };
  await db
    .insert(settings)
    .values({ key: KEY, valueJson: next })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson: next, updatedAt: new Date() } });
}

export const extrasOf = (extras: MenuExtras, productId: string) => ({
  featured: extras.featured.includes(productId),
  badges: extras.badges[productId] ?? [],
});
