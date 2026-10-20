import {
  certificateUploadSchema,
  cscInputSchema,
  DEFAULT_FISCAL_SETTINGS,
  fiscalMonthSchema,
  fiscalSettingsSchema,
  productFiscalBulkSchema,
  type CertificateInfo,
  type FiscalMonthSummary,
  type FiscalSettings,
  type FiscalStatus,
  type ProductFiscalRow,
} from '@sistema-bar/shared';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { strToU8, zipSync } from 'fflate';
import type { AppDeps } from '../../app';
import type { Db } from '../../db/client';
import { categories, fiscalConfig, fiscalDocuments, products } from '../../db/schema';
import { parsePfx } from '../../fiscal/certificate';
import { audit } from '../../lib/audit';
import { HttpError } from '../../lib/errors';

const KEY = 'main';
const DAY = 24 * 60 * 60 * 1000;

async function configRow(db: Db) {
  const [row] = await db.select().from(fiscalConfig).where(eq(fiscalConfig.key, KEY));
  return row ?? null;
}

function settingsOf(row: Awaited<ReturnType<typeof configRow>>): FiscalSettings {
  const parsed = fiscalSettingsSchema.safeParse({ ...DEFAULT_FISCAL_SETTINGS, ...((row?.data as object | undefined) ?? {}) });
  return parsed.success ? parsed.data : DEFAULT_FISCAL_SETTINGS;
}

function certificateOf(row: Awaited<ReturnType<typeof configRow>>): CertificateInfo | null {
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

/** Grava (cria ou atualiza) a linha única da configuração fiscal. */
async function upsert(db: Pick<Db, 'insert'>, values: Partial<typeof fiscalConfig.$inferInsert> & { data?: unknown }) {
  await db
    .insert(fiscalConfig)
    .values({ key: KEY, data: values.data ?? DEFAULT_FISCAL_SETTINGS, ...values })
    .onConflictDoUpdate({ target: fiscalConfig.key, set: values });
}

/** Mês "AAAA-MM" em Brasília → intervalo UTC. */
function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1, 3));
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 3));
  return { start, end };
}

/**
 * Admin → Fiscal (SPEC 5.8): preparação da NFC-e. Dados do emitente, CSC e certificado A1
 * (cifrados), dados fiscais dos produtos e os XMLs das notas para a contabilidade.
 */
export async function fiscalRoutes(app: FastifyInstance, { db, secrets }: AppDeps) {
  app.get('/status', async (): Promise<FiscalStatus> => {
    const row = await configRow(db);
    const settings = settingsOf(row);
    const certificate = certificateOf(row);
    const [{ active, missing }] = (await db
      .select({
        active: sql<number>`count(*)::int`,
        missing: sql<number>`count(*) filter (where ${products.ncm} is null)::int`,
      })
      .from(products)
      .where(eq(products.active, true))) as [{ active: number; missing: number }];

    const addressOk = Boolean(settings.street && settings.number && settings.district && settings.city && settings.cityCode && settings.zip);
    const readiness = [
      { key: 'emitente', label: 'Razão social, CNPJ e inscrição estadual', ok: Boolean(settings.legalName && settings.cnpj && settings.stateRegistration) },
      { key: 'endereco', label: 'Endereço completo com código IBGE do município', ok: addressOk },
      { key: 'csc', label: 'CSC da NFC-e (SEFAZ)', ok: Boolean(row?.cscTokenEnc), hint: 'Gerado no credenciamento da NFC-e na SEFAZ.' },
      {
        key: 'certificado',
        label: 'Certificado digital A1 válido',
        ok: Boolean(certificate && certificate.daysLeft >= 0),
        hint: certificate && certificate.daysLeft < 0 ? 'Certificado vencido.' : undefined,
      },
      {
        key: 'cnpj-certificado',
        label: 'CNPJ do certificado igual ao do emitente',
        ok: Boolean(certificate?.cnpj && settings.cnpj && certificate.cnpj === settings.cnpj),
        hint: certificate && !certificate.cnpj ? 'O certificado não informa o CNPJ; confira com o contador.' : undefined,
      },
      { key: 'produtos', label: 'NCM em todos os produtos ativos', ok: active > 0 && missing === 0, hint: missing ? `${missing} produto(s) sem NCM.` : undefined },
      { key: 'emissora', label: 'Emissora de NFC-e contratada e ligada', ok: Boolean(row?.provider), hint: 'Próxima etapa: escolher a emissora com o contador.' },
    ];
    return {
      settings,
      cscConfigured: Boolean(row?.cscTokenEnc),
      cscId: row?.cscId ?? null,
      certificate,
      provider: row?.provider ?? null,
      productsMissingNcm: missing,
      activeProducts: active,
      readiness,
    };
  });

  app.put('/settings', async (request) => {
    const data = fiscalSettingsSchema.parse(request.body);
    const before = settingsOf(await configRow(db));
    await db.transaction(async (tx) => {
      await upsert(tx, { data });
      await audit(tx, request, { action: 'FISCAL_CONFIG_ALTERADA', entity: 'fiscal_config', before, after: data });
    });
    return data;
  });

  app.put('/csc', async (request) => {
    const { cscId, cscToken } = cscInputSchema.parse(request.body);
    await db.transaction(async (tx) => {
      await upsert(tx, { cscId, cscTokenEnc: secrets.seal(cscToken) });
      // O código em si não vai para a auditoria.
      await audit(tx, request, { action: 'FISCAL_CSC_ALTERADO', entity: 'fiscal_config', after: { cscId } });
    });
    return { cscConfigured: true, cscId };
  });

  app.post('/certificate', { bodyLimit: 400_000 }, async (request): Promise<CertificateInfo> => {
    const { pfxBase64, password } = certificateUploadSchema.parse(request.body);
    const pfx = Buffer.from(pfxBase64.replace(/^data:[^,]*,/, ''), 'base64');
    const cert = parsePfx(pfx, password);
    if (cert.validUntil.getTime() < Date.now()) throw new HttpError(400, 'CERT_EXPIRED', 'Este certificado já venceu. Peça um novo à certificadora.');
    const now = new Date();
    await db.transaction(async (tx) => {
      await upsert(tx, {
        certPfxEnc: secrets.seal(pfx),
        certPasswordEnc: secrets.seal(password),
        certSubject: cert.subject,
        certCnpj: cert.cnpj,
        certValidFrom: cert.validFrom,
        certValidUntil: cert.validUntil,
        certUploadedAt: now,
      });
      await audit(tx, request, {
        action: 'CERTIFICADO_ENVIADO',
        entity: 'fiscal_config',
        after: { subject: cert.subject, cnpj: cert.cnpj, validUntil: cert.validUntil.toISOString() },
      });
    });
    return certificateOf(await configRow(db))!;
  });

  app.delete('/certificate', async (request, reply) => {
    await db.transaction(async (tx) => {
      await upsert(tx, {
        certPfxEnc: null,
        certPasswordEnc: null,
        certSubject: null,
        certCnpj: null,
        certValidFrom: null,
        certValidUntil: null,
        certUploadedAt: null,
      });
      await audit(tx, request, { action: 'CERTIFICADO_REMOVIDO', entity: 'fiscal_config' });
    });
    return reply.code(204).send();
  });

  // ---- Dados fiscais dos produtos (tela do contador) ----

  app.get('/products', async (): Promise<ProductFiscalRow[]> =>
    db
      .select({
        id: products.id,
        name: products.name,
        categoryName: categories.name,
        priceCents: products.priceCents,
        active: products.active,
        ncm: products.ncm,
        cfop: products.cfop,
        csosn: products.csosn,
        origin: products.origin,
        cest: products.cest,
      })
      .from(products)
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .orderBy(asc(categories.sortOrder), asc(categories.name), asc(products.name)),
  );

  app.put('/products', { bodyLimit: 2_000_000 }, async (request) => {
    const { items } = productFiscalBulkSchema.parse(request.body);
    let changed = 0;
    await db.transaction(async (tx) => {
      for (const { id, ...fields } of items) {
        const res = await tx.update(products).set(fields).where(eq(products.id, id)).returning({ id: products.id });
        changed += res.length;
      }
      await audit(tx, request, { action: 'PRODUTOS_FISCAL_ALTERADOS', entity: 'product', after: { produtos: changed } });
    });
    return { changed };
  });

  // ---- Notas emitidas e XMLs para a contabilidade ----

  app.get('/summary', async (request): Promise<FiscalMonthSummary> => {
    const { month } = fiscalMonthSchema.parse(request.query);
    const { start, end } = monthRange(month);
    const [r] = (await db
      .select({
        authorized: sql<number>`count(*) filter (where ${fiscalDocuments.status} = 'AUTORIZADA')::int`,
        canceled: sql<number>`count(*) filter (where ${fiscalDocuments.status} = 'CANCELADA')::int`,
        totalCents: sql<number>`coalesce(sum(${fiscalDocuments.totalCents}) filter (where ${fiscalDocuments.status} = 'AUTORIZADA'), 0)::int`,
        canceledCents: sql<number>`coalesce(sum(${fiscalDocuments.totalCents}) filter (where ${fiscalDocuments.status} = 'CANCELADA'), 0)::int`,
      })
      .from(fiscalDocuments)
      .where(and(gte(fiscalDocuments.issuedAt, start), lt(fiscalDocuments.issuedAt, end), eq(fiscalDocuments.environment, 'PRODUCAO')))) as [
      Omit<FiscalMonthSummary, 'month'>,
    ];
    return { month, ...r };
  });

  /** .zip com os XMLs de produção do mês (notas e cancelamentos) e um resumo em planilha. */
  app.get('/export', async (request, reply) => {
    const { month } = fiscalMonthSchema.parse(request.query);
    const { start, end } = monthRange(month);
    const docs = await db
      .select()
      .from(fiscalDocuments)
      .where(and(gte(fiscalDocuments.issuedAt, start), lt(fiscalDocuments.issuedAt, end), eq(fiscalDocuments.environment, 'PRODUCAO')))
      .orderBy(asc(fiscalDocuments.series), asc(fiscalDocuments.number));
    const settings = settingsOf(await configRow(db));

    const files: Record<string, Uint8Array> = {};
    const money = (c: number) => (c / 100).toFixed(2).replace('.', ',');
    const rows = [['Série', 'Número', 'Chave de acesso', 'Emissão', 'Situação', 'Valor (R$)', 'Protocolo', 'Cancelamento', 'Motivo do cancelamento']];
    for (const d of docs) {
      if (d.xml) files[`NFCe/${d.accessKey}-nfce.xml`] = strToU8(d.xml);
      if (d.cancelXml) files[`Cancelamentos/${d.accessKey}-canc.xml`] = strToU8(d.cancelXml);
      rows.push([
        String(d.series),
        String(d.number),
        d.accessKey,
        d.issuedAt.toISOString(),
        d.status,
        money(d.totalCents),
        d.protocol ?? '',
        d.canceledAt?.toISOString() ?? '',
        d.cancelReason ?? '',
      ]);
    }
    const authorized = docs.filter((d) => d.status === 'AUTORIZADA');
    rows.push([], ['Notas autorizadas', String(authorized.length)], ['Total autorizado (R$)', money(authorized.reduce((s, d) => s + d.totalCents, 0))]);
    rows.push(['Canceladas', String(docs.filter((d) => d.status === 'CANCELADA').length)]);
    const cell = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    files['resumo.csv'] = strToU8('﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n'));

    await audit(db, request, { action: 'FISCAL_XML_EXPORTADO', entity: 'fiscal_documents', after: { month, notas: docs.length } });
    const name = `xml-nfce-${settings.cnpj || 'emitente'}-${month}.zip`;
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${name}"`)
      .send(Buffer.from(zipSync(files, { level: 6 })));
  });

}
