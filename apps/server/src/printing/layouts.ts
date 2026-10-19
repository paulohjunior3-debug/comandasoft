import type { Block } from '@sistema-bar/escpos';
import type { ProductionTicket, TestTicket, TicketPayload } from './tickets';

const when = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

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

export function ticketBlocks(payload: TicketPayload): Block[] {
  switch (payload.kind) {
    case 'PRODUCAO':
      return production(payload);
    case 'TESTE':
      return test(payload);
  }
}

/** Linha curta para a lista da fila: "Mesa 10 · Paulo, Ana · 3 itens". */
export function describeTicket(payload: TicketPayload): string {
  if (payload.kind === 'TESTE') return `Teste de impressão (${payload.requestedBy})`;
  const items = payload.items.reduce((s, i) => s + i.qty, 0);
  return `Mesa ${payload.tableNumber} · ${payload.customers.join(', ')} · ${items} ${items === 1 ? 'item' : 'itens'}`;
}
