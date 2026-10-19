import type { Block } from '@sistema-bar/escpos';
import { formatBRL } from '@sistema-bar/shared';
import type { BillTicket, CashTicket, CompanyHeader, ProductionTicket, TestTicket, TicketPayload } from './tickets';

const when = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const money = (cents: number) => formatBRL(cents);

/**
 * Cupom de produção (SPEC 5.5): setor em destaque, MESA e NOME para o cumim entregar,
 * itens com quantidade em destaque e observações em negrito.
 */
function production(t: ProductionTicket): Block[] {
  const blocks: Block[] = [
    { kind: 'text', text: t.sector, align: 'center', size: 'big', bold: true },
    { kind: 'rule', char: '=' },
    { kind: 'text', text: `MESA ${t.tableNumber}`, align: 'center', size: 'big', bold: true },
    { kind: 'text', text: t.customers.join(', ').toUpperCase(), align: 'center', size: 'tall', bold: true },
    { kind: 'text', text: `${t.waiter} · ${when(t.createdAt)} · #${t.orderRef}`, align: 'center' },
  ];
  if (t.reprint) blocks.push({ kind: 'text', text: '*** REIMPRESSÃO ***', align: 'center', bold: true, size: 'tall' });
  blocks.push({ kind: 'rule' });
  for (const item of t.items) {
    blocks.push({ kind: 'text', text: `${item.qty}x ${item.name}`, size: 'tall', bold: true });
    if (item.notes) blocks.push({ kind: 'text', text: `>> ${item.notes.toUpperCase()}`, bold: true });
  }
  blocks.push({ kind: 'rule' }, { kind: 'feed', lines: 1 });
  return blocks;
}

/** Página de teste: confirma conexão, largura do papel e acentuação. */
function test(t: TestTicket): Block[] {
  return [
    { kind: 'text', text: t.sector, align: 'center', size: 'big', bold: true },
    { kind: 'text', text: 'TESTE DE IMPRESSÃO', align: 'center', bold: true },
    { kind: 'rule' },
    { kind: 'text', text: `Cadastro: ${t.printerName}` },
    { kind: 'text', text: `Windows: ${t.windowsName}` },
    { kind: 'text', text: `Pedido por ${t.requestedBy} em ${when(t.createdAt)}` },
    { kind: 'rule' },
    { kind: 'text', text: 'Acentos: Ação, pão, coração, açaí, você, ÇÃÕÉÍÚ' },
    { kind: 'text', text: 'Se os acentos saíram trocados, mude a "Acentuação" no cadastro da impressora.' },
    { kind: 'rule' },
    { kind: 'text', text: 'Normal' },
    { kind: 'text', text: 'Negrito', bold: true },
    { kind: 'text', text: 'Alto', size: 'tall' },
    { kind: 'text', text: 'Grande', size: 'big' },
    { kind: 'rule', char: '=' },
    { kind: 'feed', lines: 1 },
  ];
}

function header(c: CompanyHeader): Block[] {
  const blocks: Block[] = [];
  if (c.name) blocks.push({ kind: 'text', text: c.name, align: 'center', bold: true, size: 'tall' });
  if (c.document) blocks.push({ kind: 'text', text: `CNPJ ${c.document}`, align: 'center' });
  if (c.address) blocks.push({ kind: 'text', text: c.address, align: 'center' });
  if (c.phone) blocks.push({ kind: 'text', text: c.phone, align: 'center' });
  return blocks;
}

/** Pré-conta e cupom final (SPEC 5.5): itens por pessoa, taxa, couvert, descontos, pagos e restante. */
function bill(t: BillTicket): Block[] {
  const blocks: Block[] = [
    ...header(t.company),
    { kind: 'rule', char: '=' },
    { kind: 'text', text: t.variant === 'PRE_CONTA' ? 'CONFERÊNCIA DE CONTA' : 'CUPOM DE CONSUMO', align: 'center', bold: true },
    { kind: 'text', text: `MESA ${t.tableNumber}`, align: 'center', size: 'big', bold: true },
    { kind: 'text', text: `${when(t.createdAt)} · ${t.operator}`, align: 'center' },
  ];
  if (t.reprint) blocks.push({ kind: 'text', text: '*** REIMPRESSÃO ***', align: 'center', bold: true });
  for (const c of t.comandas) {
    blocks.push({ kind: 'rule' }, { kind: 'text', text: c.name.toUpperCase(), bold: true });
    for (const i of c.items) {
      blocks.push({ kind: 'pair', left: `${i.qty}x ${i.name}${i.shared ? ' (rateado)' : ''}`, right: money(i.amountCents) });
    }
    if (t.comandas.length > 1) blocks.push({ kind: 'pair', left: '  Total desta pessoa', right: money(c.totalCents), bold: true });
  }
  const tt = t.totals;
  blocks.push({ kind: 'rule' }, { kind: 'pair', left: 'Subtotal', right: money(tt.itemsCents) });
  if (tt.serviceFeeCents) blocks.push({ kind: 'pair', left: 'Taxa de serviço (10%)', right: money(tt.serviceFeeCents) });
  if (tt.couvertCents) blocks.push({ kind: 'pair', left: 'Couvert', right: money(tt.couvertCents) });
  if (tt.discountCents) blocks.push({ kind: 'pair', left: 'Desconto', right: `-${money(tt.discountCents)}` });
  blocks.push({ kind: 'pair', left: 'TOTAL', right: money(tt.totalCents), bold: true, size: 'tall' });
  if (t.payments.length) {
    blocks.push({ kind: 'rule' });
    for (const p of t.payments) {
      blocks.push({ kind: 'pair', left: `Pago por ${p.payerName} (${p.method})`, right: money(p.amountCents) });
      if (p.detail) blocks.push({ kind: 'text', text: `  ${p.detail}` });
      if (p.changeCents) blocks.push({ kind: 'pair', left: '  Troco', right: money(p.changeCents) });
    }
  }
  if (tt.remainingCents) blocks.push({ kind: 'pair', left: 'RESTANTE', right: money(tt.remainingCents), bold: true, size: 'tall' });
  else if (t.payments.length) blocks.push({ kind: 'text', text: 'CONTA PAGA', align: 'center', bold: true, size: 'tall' });
  blocks.push({ kind: 'rule' }, { kind: 'text', text: 'NÃO É DOCUMENTO FISCAL', align: 'center', bold: true });
  if (t.company.footer) blocks.push({ kind: 'text', text: t.company.footer, align: 'center' });
  blocks.push({ kind: 'feed', lines: 1 });
  return blocks;
}

const CASH_TITLE: Record<CashTicket['variant'], string> = {
  ABERTURA: 'ABERTURA DE CAIXA',
  SANGRIA: 'SANGRIA',
  SUPRIMENTO: 'SUPRIMENTO',
  FECHAMENTO: 'FECHAMENTO DE CAIXA',
};

/** Comprovantes do caixa (SPEC 5.7): sangria/suprimento com motivo e relatório de fechamento. */
function cash(t: CashTicket): Block[] {
  const blocks: Block[] = [
    ...header(t.company),
    { kind: 'rule', char: '=' },
    { kind: 'text', text: CASH_TITLE[t.variant], align: 'center', bold: true, size: 'tall' },
    { kind: 'text', text: `${when(t.createdAt)} · ${t.operator}`, align: 'center' },
  ];
  if (t.reprint) blocks.push({ kind: 'text', text: '*** REIMPRESSÃO ***', align: 'center', bold: true });
  blocks.push({ kind: 'rule' });
  if (t.amountCents !== undefined) blocks.push({ kind: 'pair', left: 'Valor', right: money(t.amountCents), bold: true, size: 'tall' });
  if (t.reason) blocks.push({ kind: 'text', text: `Motivo: ${t.reason}` });
  const r = t.report;
  if (r) {
    blocks.push(
      { kind: 'text', text: `Aberto em ${when(r.openedAt)}` },
      { kind: 'pair', left: 'Fundo de troco', right: money(r.openingFloatCents) },
      { kind: 'pair', left: 'Suprimentos', right: money(r.suprimentosCents) },
      { kind: 'pair', left: 'Sangrias', right: `-${money(r.sangriasCents)}` },
      { kind: 'rule' },
      { kind: 'pair', left: 'Forma', right: 'Esperado / Contado' },
    );
    for (const row of r.rows) {
      const counted = row.countedCents === null ? '-' : money(row.countedCents);
      blocks.push({ kind: 'pair', left: row.method, right: `${money(row.expectedCents)} / ${counted}` });
      if (row.differenceCents) {
        blocks.push({ kind: 'pair', left: row.differenceCents > 0 ? '  Sobra' : '  Falta', right: money(Math.abs(row.differenceCents)) });
      }
    }
    const label = r.differenceCents === 0 ? 'SEM DIFERENÇA' : r.differenceCents > 0 ? 'SOBRA' : 'FALTA';
    blocks.push({ kind: 'rule' }, { kind: 'pair', left: label, right: money(Math.abs(r.differenceCents)), bold: true, size: 'tall' });
    if (r.openComandas) blocks.push({ kind: 'text', text: `Atenção: ${r.openComandas} comanda(s) ainda aberta(s).`, bold: true });
    if (r.notes) blocks.push({ kind: 'text', text: `Obs.: ${r.notes}` });
  }
  blocks.push(
    { kind: 'feed', lines: 2 },
    { kind: 'text', text: '_______________________________', align: 'center' },
    { kind: 'text', text: 'Assinatura', align: 'center' },
    { kind: 'feed', lines: 1 },
  );
  return blocks;
}

export function ticketBlocks(payload: TicketPayload): Block[] {
  switch (payload.kind) {
    case 'PRODUCAO':
      return production(payload);
    case 'TESTE':
      return test(payload);
    case 'CONTA':
      return bill(payload);
    case 'CAIXA':
      return cash(payload);
    case 'GAVETA':
      return [];
  }
}

/** Linha curta para a lista da fila: "Mesa 10 · Paulo, Ana · 3 itens". */
export function describeTicket(payload: TicketPayload): string {
  switch (payload.kind) {
    case 'TESTE':
      return `Teste de impressão (${payload.requestedBy})`;
    case 'GAVETA':
      return 'Abrir gaveta de dinheiro';
    case 'CAIXA':
      return `${CASH_TITLE[payload.variant]}${payload.amountCents !== undefined ? ` · ${money(payload.amountCents)}` : ''}`;
    case 'CONTA':
      return `${payload.variant === 'PRE_CONTA' ? 'Pré-conta' : 'Cupom'} · Mesa ${payload.tableNumber} · ${payload.comandas.map((c) => c.name).join(', ')}`;
    case 'PRODUCAO': {
      const items = payload.items.reduce((s, i) => s + i.qty, 0);
      return `Mesa ${payload.tableNumber} · ${payload.customers.join(', ')} · ${items} ${items === 1 ? 'item' : 'itens'}`;
    }
  }
}
