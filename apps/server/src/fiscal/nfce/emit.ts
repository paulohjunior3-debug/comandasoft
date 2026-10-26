import { type FiscalEnvironment, type FiscalSettings, type NfceEmitResult, type PaymentMethod } from '@sistema-bar/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AppDeps } from '../../app';
import { comandas, fiscalConfig, fiscalDocuments, fiscalRequests, orderItems, orderItemShares, products } from '../../db/schema';
import { audit } from '../../lib/audit';
import { loadBill } from '../../lib/billing';
import { enqueueCashierPrint } from '../../lib/cashier-print';
import { HttpError } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import { appVersion } from '../../paths';
import type { NfceTicket } from '../../printing/tickets';
import { certificateOf, configRow, cscKeyOf, HOMOLOGACAO, MAIN, settingsOf, upsertConfig } from '../config';
import { assembleNfe, nfeProc } from './assemble';
import { buildNfce, proportional, type NfceInput, type NfceItem, type NfcePayment } from './build';
import { CHAVE_URL } from './constants';
import { randomCNF } from './key';
import { sefazClient, SefazCommError, tagValue, type Transport } from './sefaz';
import { openCertificate } from './sign';

type Deps = Pick<AppDeps, 'db' | 'secrets' | 'cpf' | 'printWorker'> & { sefazTransport?: Transport };

const T_PAG: Record<PaymentMethod, (s: FiscalSettings) => string> = {
  DINHEIRO: () => '01',
  CREDITO: () => '03',
  DEBITO: () => '04',
  PIX: (s) => s.pixTPag,
};

/** O que falta para emitir no ambiente escolhido (lista vazia = pronto). */
export async function nfceMissing(db: Deps['db'], settings: FiscalSettings): Promise<string[]> {
  const main = await configRow(db, MAIN);
  const csc = await configRow(db, cscKeyOf(settings.environment));
  const cert = certificateOf(main);
  const missing: string[] = [];
  if (!settings.legalName || !settings.cnpj || !settings.stateRegistration) missing.push('razão social, CNPJ e inscrição estadual');
  if (!settings.street || !settings.district || !settings.city || !settings.cityCode || !settings.zip) missing.push('endereço completo com código IBGE');
  if (settings.uf !== 'MG') missing.push('emissão direta disponível só para MG');
  if (!csc?.cscTokenEnc || !csc.cscId) missing.push(`CSC de ${settings.environment === 'PRODUCAO' ? 'produção' : 'homologação'}`);
  if (!cert) missing.push('certificado A1');
  else if (cert.daysLeft < 0) missing.push('certificado A1 válido (está vencido)');
  else if (cert.cnpj && cert.cnpj !== settings.cnpj) missing.push('certificado do mesmo CNPJ do emitente');
  if (!settings.respTecCnpj || !settings.respTecContact || !settings.respTecEmail || !settings.respTecPhone) missing.push('responsável técnico (CNPJ, contato, e-mail e telefone)');
  if (settings.regime !== 'SIMPLES_NACIONAL') missing.push('regime Simples Nacional (outros regimes ainda não suportados)');
  return missing;
}

interface EmitRequest {
  request: FastifyRequest;
  /** Comandas da venda; vazio só na nota de teste. */
  comandaIds: string[];
  cpfOnNote: boolean;
  fiscalRequestId?: string;
  registerPrinterId?: string | null;
  /** Nota de teste (homologação): um item, pago em dinheiro. */
  test?: boolean;
}

/** Itens da nota a partir das comandas (parte de cada comanda nos itens rateados). */
async function saleItems(db: Deps['db'], ids: string[], settings: FiscalSettings): Promise<NfceItem[]> {
  const rows = await db
    .select({
      productId: products.id,
      sku: products.sku,
      name: orderItems.productNameSnapshot,
      unitPriceCents: orderItems.unitPriceCents,
      amountCents: orderItemShares.amountCents,
      ncm: products.ncm,
      cest: products.cest,
      cfop: products.cfop,
      csosn: products.csosn,
      origin: products.origin,
      unit: products.unit,
    })
    .from(orderItemShares)
    .innerJoin(orderItems, eq(orderItems.id, orderItemShares.orderItemId))
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(and(inArray(orderItemShares.comandaId, ids), eq(orderItems.status, 'ATIVO')));
  const groups = new Map<string, NfceItem & { unitPriceCents: number }>();
  const noNcm = new Set<string>();
  for (const r of rows) {
    if (r.amountCents <= 0) continue;
    if (!r.ncm) noNcm.add(r.name);
    const key = `${r.productId}|${r.unitPriceCents}`;
    const g = groups.get(key);
    if (g) {
      g.totalCents += r.amountCents;
      g.qty = g.totalCents / g.unitPriceCents;
    } else {
      groups.set(key, {
        code: r.sku || r.productId.slice(0, 8).toUpperCase(),
        name: r.name,
        ncm: r.ncm ?? '',
        cest: r.cest,
        cfop: r.cfop || settings.defaultCfop,
        unit: r.unit || 'UN',
        qty: r.amountCents / r.unitPriceCents,
        totalCents: r.amountCents,
        discountCents: 0,
        csosn: r.csosn || settings.defaultCsosn,
        origin: r.origin || settings.defaultOrigin,
        pisCofinsCst: settings.pisCofinsCst,
        unitPriceCents: r.unitPriceCents,
      });
    }
  }
  if (noNcm.size) throw new HttpError(409, 'NFCE_NCM', `Produto(s) sem NCM: ${[...noNcm].join(', ')}. Preencha em Administração > Fiscal > Produtos.`);
  // Quantidade com no máximo 4 casas (item rateado entre comandas pode dar fração).
  return [...groups.values()].map(({ unitPriceCents: _u, ...i }) => ({ ...i, qty: Math.round(i.qty * 10_000) / 10_000 }));
}

/** Pagamentos da venda por forma, na proporção, somando exatamente o total da nota. */
function notePayments(byMethod: Map<PaymentMethod, number>, totalCents: number, settings: FiscalSettings): NfcePayment[] {
  const methods = [...byMethod.keys()];
  if (!methods.length) return [{ tPag: '01', amountCents: totalCents }];
  const shares = proportional(totalCents, methods.map((m) => byMethod.get(m)!));
  const merged = new Map<string, number>();
  methods.forEach((m, i) => merged.set(T_PAG[m](settings), (merged.get(T_PAG[m](settings)) ?? 0) + shares[i]!));
  return [...merged].filter(([, v]) => v > 0).map(([tPag, amountCents]) => ({ tPag, amountCents }));
}

const TPAG_LABEL: Record<string, string> = { '01': 'Dinheiro', '03': 'Cartão de crédito', '04': 'Cartão de débito', '17': 'PIX', '20': 'PIX' };

/**
 * Emite a NFC-e direto com a SEFAZ-MG. Rejeição volta como REJEITADA com o motivo (o número é
 * devolvido para a próxima tentativa); falha de comunicação volta como ERRO_COMUNICACAO (o
 * número fica gasto: a nota pode ter chegado; a consulta pela chave resolve depois).
 */
export async function emitNfce(deps: Deps, req: EmitRequest): Promise<NfceEmitResult> {
  const { db, secrets } = deps;
  const main = await configRow(db, MAIN);
  const settings = settingsOf(main);
  const env: FiscalEnvironment = settings.environment;
  if (req.test && env !== 'HOMOLOGACAO') throw new HttpError(409, 'NFCE_TEST_PROD', 'A nota de teste só pode ser emitida em homologação.');
  const missing = await nfceMissing(db, settings);
  if (missing.length) throw new HttpError(409, 'NFCE_NOT_READY', `Falta configurar: ${missing.join('; ')}.`);

  // ---- Itens, desconto e pagamentos ----
  let items: NfceItem[];
  let payments: NfcePayment[];
  let paymentLabels: { label: string; amountCents: number }[];
  let cpf: string | null = null;
  let info = '';
  if (req.test) {
    const [p] = await db
      .select()
      .from(products)
      .where(and(eq(products.active, true), sql`${products.ncm} is not null`))
      .limit(1);
    if (!p) throw new HttpError(409, 'NFCE_NCM', 'Preencha o NCM de ao menos um produto (Administração > Fiscal > Produtos) para a nota de teste.');
    items = [
      {
        code: p.sku || p.id.slice(0, 8).toUpperCase(),
        name: p.name,
        ncm: p.ncm!,
        cest: p.cest,
        cfop: p.cfop || settings.defaultCfop,
        unit: p.unit || 'UN',
        qty: 1,
        totalCents: p.priceCents,
        discountCents: 0,
        csosn: p.csosn || settings.defaultCsosn,
        origin: p.origin || settings.defaultOrigin,
        pisCofinsCst: settings.pisCofinsCst,
      },
    ];
    payments = [{ tPag: '01', amountCents: p.priceCents }];
    paymentLabels = [{ label: 'Dinheiro', amountCents: p.priceCents }];
    info = 'Nota de teste do Sistema Bar';
  } else {
    if (!req.comandaIds.length) throw new HttpError(400, 'VALIDATION', 'Escolha as comandas da nota.');
    const overlap = sql`${fiscalRequests.comandaIds} ?| array[${sql.join(
      req.comandaIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[]`;
    const [already] = await db
      .select({ number: fiscalDocuments.number })
      .from(fiscalDocuments)
      .innerJoin(fiscalRequests, eq(fiscalRequests.id, fiscalDocuments.fiscalRequestId))
      .where(and(eq(fiscalDocuments.environment, env), inArray(fiscalDocuments.status, ['AUTORIZADA', 'CONTINGENCIA']), overlap));
    if (already) throw new HttpError(409, 'NFCE_DUPLICADA', `Essa conta já tem a NFC-e ${already.number} autorizada.`);
    const pending = (await pendingNotes(deps)).find((n) => n.env === env && n.comandaIds.some((id) => req.comandaIds.includes(id)));
    if (pending) return resolvePending(deps, req.request, settings, pending.sealed, req);
    items = await saleItems(db, req.comandaIds, settings);
    if (!items.length) throw new HttpError(409, 'NFCE_EMPTY', 'Essas comandas não têm itens para a nota.');
    const bill = await loadBill(db, req.comandaIds, await getSettings(db));
    const itemsTotal = items.reduce((s, i) => s + i.totalCents, 0);
    const discount = Math.min(bill.totals.discountCents, itemsTotal - items.length); // cada item precisa ficar com valor
    const perItem = proportional(Math.max(0, discount), items.map((i) => i.totalCents));
    items = items.map((i, n) => ({ ...i, discountCents: perItem[n]! }));
    const total = itemsTotal - Math.max(0, discount);
    const byMethod = new Map<PaymentMethod, number>();
    for (const p of bill.payments.filter((x) => x.status === 'OK')) {
      const mine = p.allocations.filter((a) => req.comandaIds.includes(a.comandaId)).reduce((s, a) => s + a.amountCents, 0);
      if (mine > 0) byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + mine);
    }
    payments = notePayments(byMethod, total, settings);
    paymentLabels = payments.map((p) => ({ label: TPAG_LABEL[p.tPag] ?? 'Outros', amountCents: p.amountCents }));
    info = `${bill.tableLabel} · ${bill.comandas.map((c) => c.customerName).join(', ')}`;
    if (req.cpfOnNote) {
      const rows = await db.select({ enc: comandas.cpfEncrypted }).from(comandas).where(inArray(comandas.id, req.comandaIds));
      const cpfs = [...new Set(rows.map((r) => (r.enc ? deps.cpf.reveal(r.enc) : null)).filter(Boolean))];
      if (cpfs.length === 1) cpf = cpfs[0]!;
    }
  }

  // ---- Certificado, CSC e número ----
  const ctx = await openContext(deps, req.request, settings);
  const numberKey = env === 'PRODUCAO' ? MAIN : HOMOLOGACAO;
  if (env === 'HOMOLOGACAO' && !(await configRow(db, HOMOLOGACAO))) await upsertConfig(db, {}, HOMOLOGACAO);
  // Reserva o número dentro de uma transação (dois caixas ao mesmo tempo não pegam o mesmo).
  const { series, number } = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(fiscalConfig).where(eq(fiscalConfig.key, numberKey)).for('update');
    const data = (row!.data ?? {}) as { nextNumber?: number; series?: number };
    const n = env === 'PRODUCAO' ? settings.nextNumber : (data.nextNumber ?? 1);
    const s = env === 'PRODUCAO' ? settings.series : (data.series ?? 1);
    await tx
      .update(fiscalConfig)
      .set({ data: { ...data, nextNumber: n + 1 } })
      .where(eq(fiscalConfig.key, numberKey));
    return { series: s, number: n };
  });
  const giveBack = async () => {
    await db
      .update(fiscalConfig)
      .set({ data: sql`jsonb_set(${fiscalConfig.data}, '{nextNumber}', to_jsonb(${number}::int))` })
      .where(and(eq(fiscalConfig.key, numberKey), sql`(${fiscalConfig.data}->>'nextNumber')::int = ${number + 1}`));
  };

  const input: NfceInput = {
    env,
    series,
    number,
    cNF: randomCNF(number),
    issuedAt: new Date(),
    emitter: {
      cnpj: settings.cnpj,
      ie: settings.stateRegistration,
      legalName: settings.legalName,
      street: settings.street,
      number: settings.number,
      complement: settings.complement,
      district: settings.district,
      cityCode: settings.cityCode,
      city: settings.city,
      uf: settings.uf,
      zip: settings.zip,
      phone: settings.phone,
      crt: 1,
    },
    items,
    payments,
    cpf,
    info,
    respTec: { cnpj: settings.respTecCnpj, contact: settings.respTecContact, email: settings.respTecEmail, phone: settings.respTecPhone },
    appVersion: `SistemaBar ${appVersion()}`,
  };
  return send(deps, ctx, { input, paymentLabels, comandaIds: req.comandaIds, fiscalRequestId: req.fiscalRequestId, registerPrinterId: req.registerPrinterId }, giveBack);
}

// ---------- Envio, nota sem confirmação e finalização ----------

/** Nota enviada sem resposta da SEFAZ: guardada (cifrada) até a consulta pela chave resolver. */
interface Pending {
  input: NfceInput;
  paymentLabels: { label: string; amountCents: number }[];
  comandaIds: string[];
  fiscalRequestId?: string;
  registerPrinterId?: string | null;
  /** XML assinado que foi para a SEFAZ (se ela autorizou, é este que vale). */
  nfe?: string;
  qrCode?: string;
  accessKey?: string;
  totalCents?: number;
  discountCents?: number;
}
const PENDING = 'pendente:';

type Ctx = Awaited<ReturnType<typeof openContext>>;

async function openContext(deps: Deps, request: FastifyRequest, settings: FiscalSettings) {
  const main = (await configRow(deps.db, MAIN))!;
  const env = settings.environment;
  const cert = openCertificate(deps.secrets.open(main.certPfxEnc!), deps.secrets.open(main.certPasswordEnc!).toString('utf8'));
  const cscRow = (await configRow(deps.db, cscKeyOf(env)))!;
  const csc = { id: cscRow.cscId!, token: deps.secrets.open(cscRow.cscTokenEnc!).toString('utf8') };
  const client = sefazClient({ env, uf: settings.uf, cert, transport: deps.sefazTransport });
  return { request, settings, env, cert, csc, client };
}

/** Notas sem confirmação da SEFAZ (falha de comunicação), da mais antiga para a mais nova. */
export async function pendingNotes(deps: Pick<Deps, 'db' | 'secrets'>) {
  const rows = await deps.db.select().from(fiscalConfig).where(sql`${fiscalConfig.key} like ${PENDING + '%'}`);
  return rows
    .map((r) => {
      const d = r.data as { sealed: string; comandaIds: string[]; number: number; env: FiscalEnvironment; totalCents: number };
      return { key: r.key, accessKey: r.key.slice(PENDING.length), ...d, updatedAt: r.updatedAt };
    })
    .sort((a, b) => a.number - b.number);
}
const unseal = (deps: Pick<Deps, 'secrets'>, sealed: string): Pending => {
  const p = JSON.parse(deps.secrets.open(sealed).toString('utf8')) as Pending;
  return { ...p, input: { ...p.input, issuedAt: new Date(p.input.issuedAt) } };
};
async function savePending(deps: Deps, p: Pending) {
  const key = PENDING + p.accessKey!;
  const data = { sealed: deps.secrets.seal(JSON.stringify(p)), comandaIds: p.comandaIds, number: p.input.number, env: p.input.env, totalCents: p.totalCents };
  await deps.db.insert(fiscalConfig).values({ key, data }).onConflictDoUpdate({ target: fiscalConfig.key, set: { data } });
}
const dropPending = (deps: Deps, accessKey: string | undefined) =>
  accessKey ? deps.db.delete(fiscalConfig).where(eq(fiscalConfig.key, PENDING + accessKey)) : Promise.resolve();

/** Assina, envia e trata a resposta. `giveBack` só existe na primeira tentativa (número recém-reservado). */
async function send(deps: Deps, ctx: Ctx, p: Pending, giveBack?: () => Promise<void>): Promise<NfceEmitResult> {
  const { db } = deps;
  const { env } = ctx;
  const built = buildNfce(p.input);
  const { nfe, qrCode } = assembleNfe(built, env, ctx.cert, ctx.csc);
  const previousKey = p.accessKey;
  const sent: Pending = { ...p, nfe, qrCode, accessKey: built.accessKey, totalCents: built.totalCents, discountCents: built.discountCents };
  const base = { environment: env, series: p.input.series, number: p.input.number, accessKey: built.accessKey };

  let res: Awaited<ReturnType<Ctx['client']['authorize']>>;
  try {
    res = await ctx.client.authorize(nfe);
  } catch (err) {
    if (!(err instanceof SefazCommError)) {
      await giveBack?.();
      throw err;
    }
    if (previousKey !== built.accessKey) await dropPending(deps, previousKey);
    await savePending(deps, sent);
    await setRequestStatus(db, p.fiscalRequestId, 'ERRO_COMUNICACAO');
    await audit(db, ctx.request, { action: 'NFCE_SEM_COMUNICACAO', entity: 'nfce', entityId: p.fiscalRequestId, after: { ...base, error: err.message } });
    return {
      status: 'ERRO_COMUNICACAO',
      message: `${err.message} A NFC-e ${p.input.number} ficou sem confirmação: peça o cupom fiscal de novo em instantes (o sistema consulta a SEFAZ antes de reenviar).`,
      ...base,
    };
  }

  await dropPending(deps, previousKey);
  if (res.cStat !== '100' && res.cStat !== '150') {
    const message = res.cStat ? `${res.cStat} - ${res.xMotivo}` : `${res.loteStat} - ${res.loteMotivo}`;
    if (giveBack) await giveBack();
    await setRequestStatus(db, p.fiscalRequestId, 'REJEITADA');
    // Número gasto numa reenvio recusado: precisa de inutilização (fica na auditoria para o contador).
    await audit(db, ctx.request, { action: 'NFCE_REJEITADA', entity: 'nfce', entityId: p.fiscalRequestId, after: { ...base, message, numberUsed: !giveBack } });
    return { status: 'REJEITADA', message: `A SEFAZ recusou a nota: ${message}`, environment: env };
  }
  return finish(deps, ctx, sent, res.protNFe!, res.nProt, res.dhRecbto);
}

/** Nota autorizada: grava o XML com o protocolo, audita e imprime o DANFE no caixa. */
async function finish(deps: Deps, ctx: Ctx, p: Pending, protNFe: string, nProt: string | null, dhRecbto: string | null): Promise<NfceEmitResult> {
  const { db } = deps;
  const { env, settings } = ctx;
  const { input } = p;
  const base = { environment: env, series: input.series, number: input.number, accessKey: p.accessKey! };
  const xml = nfeProc(p.nfe!, protNFe);
  const [doc] = await db
    .insert(fiscalDocuments)
    .values({
      fiscalRequestId: p.fiscalRequestId ?? null,
      series: input.series,
      number: input.number,
      accessKey: p.accessKey!,
      environment: env,
      status: 'AUTORIZADA',
      totalCents: p.totalCents!,
      xml,
      protocol: nProt,
      issuedAt: input.issuedAt,
    })
    .returning({ id: fiscalDocuments.id });
  await setRequestStatus(db, p.fiscalRequestId, 'AUTORIZADA');
  await audit(db, ctx.request, { action: 'NFCE_AUTORIZADA', entity: 'nfce', entityId: doc!.id, after: { ...base, protocol: nProt, totalCents: p.totalCents } });

  const ticket: NfceTicket = {
    kind: 'NFCE',
    homologacao: env === 'HOMOLOGACAO',
    emitter: {
      legalName: settings.legalName,
      cnpj: settings.cnpj,
      ie: settings.stateRegistration,
      address: `${settings.street}, ${settings.number || 'SN'} - ${settings.district} - ${settings.city}/${settings.uf}`,
    },
    items: input.items.map((i) => ({ code: i.code, name: i.name, qty: i.qty, unit: i.unit, unitCents: Math.round(i.totalCents / i.qty), totalCents: i.totalCents })),
    itemsCents: input.items.reduce((s, i) => s + i.totalCents, 0),
    discountCents: p.discountCents ?? 0,
    totalCents: p.totalCents!,
    payments: p.paymentLabels,
    changeCents: 0,
    cpf: input.cpf ?? null,
    series: input.series,
    number: input.number,
    issuedAt: input.issuedAt.toISOString(),
    accessKey: p.accessKey!,
    protocol: nProt,
    authorizedAt: dhRecbto,
    qrCode: p.qrCode!,
    urlChave: CHAVE_URL[env],
  };
  const printed = await enqueueCashierPrint(db, await getSettings(db), ticket, doc!.id, p.registerPrinterId);
  if (printed) deps.printWorker.kick();
  return {
    status: 'AUTORIZADA',
    message: `NFC-e ${input.number} autorizada${env === 'HOMOLOGACAO' ? ' (homologação, sem valor fiscal)' : ''}.${printed ? '' : ' Sem impressora do caixa: não imprimiu.'}`,
    ...base,
    documentId: doc!.id,
    printed,
  };
}

/**
 * Nota que ficou sem confirmação: consulta pela chave antes de qualquer coisa. Se a SEFAZ já
 * autorizou, guarda e imprime essa; se ela não recebeu, reenvia com o mesmo número.
 */
async function resolvePending(deps: Deps, request: FastifyRequest, settings: FiscalSettings, sealed: string, req?: EmitRequest): Promise<NfceEmitResult> {
  const p = unseal(deps, sealed);
  if (req?.fiscalRequestId) p.fiscalRequestId = req.fiscalRequestId;
  if (req && req.registerPrinterId !== undefined) p.registerPrinterId = req.registerPrinterId;
  const ctx = await openContext(deps, request, settings);
  const base = { environment: ctx.env, series: p.input.series, number: p.input.number, accessKey: p.accessKey };
  let r: Awaited<ReturnType<Ctx['client']['consult']>>;
  try {
    r = await ctx.client.consult(p.accessKey!);
  } catch (err) {
    if (!(err instanceof SefazCommError)) throw err;
    return { status: 'ERRO_COMUNICACAO', message: `${err.message} A NFC-e ${p.input.number} continua sem confirmação.`, ...base };
  }
  if ((r.cStat === '100' || r.cStat === '150') && r.protNFe) {
    await dropPending(deps, p.accessKey);
    return finish(deps, ctx, p, r.protNFe, tagValue(r.protNFe, 'nProt'), tagValue(r.protNFe, 'dhRecbto'));
  }
  if (r.cStat === '217') {
    // A SEFAZ não recebeu: reenvia com o mesmo número e a hora de agora (NFC-e não aceita emissão atrasada).
    return send(deps, ctx, { ...p, input: { ...p.input, issuedAt: new Date() } });
  }
  return { status: 'REJEITADA', message: `Consulta da NFC-e ${p.input.number} na SEFAZ: ${r.cStat} - ${r.xMotivo}`, environment: ctx.env };
}

/** Tela Fiscal: tenta resolver as notas sem confirmação (consulta e, se preciso, reenvia). */
export async function resolvePendingNotes(deps: Deps, request: FastifyRequest) {
  const settings = settingsOf(await configRow(deps.db, MAIN));
  const results: NfceEmitResult[] = [];
  for (const n of await pendingNotes(deps)) {
    if (n.env !== settings.environment) continue;
    results.push(await resolvePending(deps, request, settings, n.sealed));
  }
  return results;
}

async function setRequestStatus(db: Deps['db'], id: string | undefined, status: string) {
  if (id) await db.update(fiscalRequests).set({ status }).where(eq(fiscalRequests.id, id));
}

/** Teste de comunicação: status do serviço da SEFAZ no ambiente configurado. */
export async function sefazStatus(deps: Deps) {
  const main = await configRow(deps.db, MAIN);
  const settings = settingsOf(main);
  if (!main?.certPfxEnc || !main.certPasswordEnc) throw new HttpError(409, 'NFCE_NOT_READY', 'Envie o certificado A1 antes de testar a comunicação.');
  const cert = openCertificate(deps.secrets.open(main.certPfxEnc), deps.secrets.open(main.certPasswordEnc).toString('utf8'));
  const client = sefazClient({ env: settings.environment, uf: settings.uf, cert, transport: deps.sefazTransport });
  try {
    const r = await client.status();
    return { environment: settings.environment, ok: r.cStat === '107', cStat: r.cStat, message: `${r.cStat} - ${r.xMotivo}` };
  } catch (err) {
    return { environment: settings.environment, ok: false, cStat: null, message: (err as Error).message };
  }
}

