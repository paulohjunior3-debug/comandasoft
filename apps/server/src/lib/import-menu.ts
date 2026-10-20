import { parseBRL } from '@sistema-bar/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { auditLogs, categories, products } from '../db/schema';
import { getSettings, saveSettings } from './settings';

const price = z.string().transform((v, ctx) => {
  const cents = parseBRL(v);
  if (cents === null) {
    ctx.addIssue({ code: 'custom', message: `Preço inválido: "${v}"` });
    return z.NEVER;
  }
  return cents;
});

const menuSchema = z.object({
  estabelecimento: z.string().optional(),
  categorias: z.array(
    z.object({
      nome: z.string().min(1),
      cor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      produtos: z.array(
        z.object({
          nome: z.string().min(1),
          preco: price,
          descricao: z.string().optional(),
          // Dados fiscais opcionais (NFC-e): o contador pode mandar junto no arquivo.
          ncm: z.string().regex(/^\d{8}$/, 'NCM deve ter 8 dígitos').optional(),
          cfop: z.string().regex(/^\d{4}$/, 'CFOP deve ter 4 dígitos').optional(),
          csosn: z.string().regex(/^\d{2,3}$/, 'CSOSN/CST deve ter 2 ou 3 dígitos').optional(),
          origem: z.string().regex(/^[0-8]$/, 'Origem de 0 a 8').optional(),
          cest: z.string().regex(/^\d{7}$/, 'CEST deve ter 7 dígitos').optional(),
        }),
      ),
    }),
  ),
});

export type MenuFile = z.input<typeof menuSchema>;

/**
 * Importa um cardápio (categorias e produtos com preço). Pode rodar mais de uma vez:
 * encontra pelo nome e só atualiza preço/descrição/cor; nada é apagado; vínculos com
 * impressoras não mudam.
 */
export async function importMenu(db: Db, raw: unknown, source: string) {
  const menu = menuSchema.parse(raw);
  let created = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const [index, cat] of menu.categorias.entries()) {
      let [category] = await tx.select().from(categories).where(eq(categories.name, cat.nome));
      if (category) {
        [category] = await tx
          .update(categories)
          .set({ sortOrder: index + 1, color: cat.cor ?? category.color })
          .where(eq(categories.id, category.id))
          .returning();
      } else {
        [category] = await tx.insert(categories).values({ name: cat.nome, sortOrder: index + 1, color: cat.cor ?? null }).returning();
      }

      for (const p of cat.produtos) {
        // Só os campos fiscais que vieram no arquivo; os outros ficam como estão.
        const fiscal = Object.fromEntries(
          Object.entries({ ncm: p.ncm, cfop: p.cfop, csosn: p.csosn, origin: p.origem, cest: p.cest }).filter(([, v]) => v !== undefined),
        );
        const [existing] = await tx
          .select()
          .from(products)
          .where(and(eq(products.categoryId, category!.id), eq(products.name, p.nome)));
        if (existing) {
          const fiscalChanged = Object.entries(fiscal).some(([k, v]) => existing[k as keyof typeof existing] !== v);
          if (existing.priceCents !== p.preco || (p.descricao ?? null) !== existing.description || fiscalChanged) {
            await tx
              .update(products)
              .set({ priceCents: p.preco, description: p.descricao ?? null, ...fiscal })
              .where(eq(products.id, existing.id));
            updated++;
          }
        } else {
          await tx.insert(products).values({ categoryId: category!.id, name: p.nome, priceCents: p.preco, description: p.descricao ?? null, ...fiscal });
          created++;
        }
      }
    }
    await tx.insert(auditLogs).values({
      action: 'CARDAPIO_IMPORTADO',
      entity: 'product',
      afterJson: { arquivo: source, categorias: menu.categorias.length, criados: created, atualizados: updated },
    });
  });

  // Nome do estabelecimento no cupom, se ainda não foi preenchido.
  if (menu.estabelecimento) {
    const settings = await getSettings(db);
    if (!settings.companyName) await saveSettings(db, { ...settings, companyName: menu.estabelecimento });
  }

  // Nome do estabelecimento no cupom, se ainda não foi preenchido.
  if (menu.estabelecimento) {
    const settings = await getSettings(db);
    if (!settings.companyName) await saveSettings(db, { ...settings, companyName: menu.estabelecimento });
  }
  const total = menu.categorias.reduce((sum, c) => sum + c.produtos.length, 0);
  return { categories: menu.categorias.length, products: total, created, updated };
}
