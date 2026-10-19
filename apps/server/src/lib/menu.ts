import type { MenuCategory } from '@sistema-bar/shared';
import { and, asc, eq } from 'drizzle-orm';
import { categories, products } from '../db/schema';
import type { Queryable } from './billing';

/** Cardápio ativo agrupado por categoria. `hideSoldOut`: o cliente (QR) não vê o que está esgotado. */
export async function loadMenu(db: Queryable, { hideSoldOut = false } = {}): Promise<MenuCategory[]> {
  const rows = await db
    .select({ category: categories, product: products })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(and(eq(products.active, true), eq(categories.active, true), hideSoldOut ? eq(products.soldOut, false) : undefined))
    .orderBy(asc(categories.sortOrder), asc(categories.name), asc(products.name));

  const menu = new Map<string, MenuCategory>();
  for (const { category: c, product: p } of rows) {
    let entry = menu.get(c.id);
    if (!entry) {
      entry = { id: c.id, name: c.name, color: c.color, products: [] };
      menu.set(c.id, entry);
    }
    entry.products.push({ id: p.id, name: p.name, description: p.description, priceCents: p.priceCents, soldOut: p.soldOut });
  }
  return [...menu.values()];
}
