/**
 * Conteúdo dos cupons, gravado em print_jobs.payload. O worker transforma isso em ESC/POS
 * conforme a largura e a página de código de cada impressora (ver layouts.ts).
 */
export interface ProductionTicket {
  kind: 'PRODUCAO';
  /** BAR, COZINHA… em fonte dupla no topo. */
  sector: string;
  tableNumber: number;
  /** "BALCÃO" nas vendas do balcão; sem ele, sai "MESA <número>". */
  tableLabel?: string;
  /** Para quem entregar (SPEC 5.5): um nome, ou vários quando o pedido foi rateado. */
  customers: string[];
  waiter: string;
  /** Hora em que o garçom enviou o pedido. */
  createdAt: string;
  /** Últimos caracteres do id do pedido, para conferência/reimpressão. */
  orderRef: string;
  /** itemId: para tirar do painel da cozinha um item cancelado antes do "pronto". */
  items: { qty: number; name: string; notes: string | null; itemId?: string }[];
  /** Pedido para viagem: faixa "PARA VIAGEM" no cupom e cartão laranja no painel. */
  takeaway?: boolean;
  /** Marcado nas reimpressões para a cozinha não preparar de novo. */
  reprint?: boolean;
  /** Aviso de alteração de um pedido já impresso (ex.: "AGORA É PARA VIAGEM"). */
  notice?: string;
}

/** Aviso ao setor (bar, cozinha) de que um item lançado foi cancelado: não preparar. */
export interface CancelTicket {
  kind: 'CANCELAMENTO';
  sector: string;
  tableNumber: number;
  /** "BALCÃO" nas vendas do balcão; sem ele, sai "MESA <número>". */
  tableLabel?: string;
  customers: string[];
  /** Quem cancelou (operador) e quem autorizou. */
  operator: string;
  authorizedBy: string;
  createdAt: string;
  reason: string;
  items: { qty: number; name: string; notes: string | null }[];
}

export interface TestTicket {
  kind: 'TESTE';
  printerName: string;
  windowsName: string;
  sector: string;
  requestedBy: string;
  createdAt: string;
  reprint?: boolean;
}

export interface CompanyHeader {
  name: string;
  document: string;
  address: string;
  phone: string;
  footer: string;
}

/**
 * Pré-conta (conferência) ou cupom final da conta (SPEC 5.5/5.7). Não é documento fiscal.
 * Os valores vêm prontos do servidor: o layout só formata.
 */
export interface BillTicket {
  kind: 'CONTA';
  variant: 'PRE_CONTA' | 'CUPOM';
  company: CompanyHeader;
  tableNumber: number;
  /** "BALCÃO" nas vendas do balcão; sem ele, sai "MESA <número>". */
  tableLabel?: string;
  createdAt: string;
  operator: string;
  comandas: {
    name: string;
    items: { qty: number; name: string; amountCents: number; shared: boolean }[];
    itemsCents: number;
    serviceFeeCents: number;
    couvertCents: number;
    discountCents: number;
    totalCents: number;
  }[];
  totals: { itemsCents: number; serviceFeeCents: number; couvertCents: number; discountCents: number; totalCents: number; paidCents: number; remainingCents: number };
  payments: { payerName: string; method: string; amountCents: number; changeCents: number; /** O que pagou, se foi por item. */ detail?: string }[];
  openDrawer?: boolean;
  reprint?: boolean;
}

/** Comprovantes do caixa: abertura, sangria/suprimento e relatório de fechamento. */
export interface CashTicket {
  kind: 'CAIXA';
  variant: 'ABERTURA' | 'SANGRIA' | 'SUPRIMENTO' | 'FECHAMENTO';
  company: CompanyHeader;
  operator: string;
  createdAt: string;
  amountCents?: number;
  reason?: string;
  /** Fechamento: esperado, contado e diferença por forma. */
  report?: {
    openedAt: string;
    openingFloatCents: number;
    rows: { method: string; expectedCents: number; countedCents: number | null; differenceCents: number | null }[];
    sangriasCents: number;
    suprimentosCents: number;
    differenceCents: number;
    openComandas: number;
    notes?: string;
  };
  reprint?: boolean;
}

/** Só o pulso da gaveta de dinheiro, sem papel. */
export interface DrawerTicket {
  kind: 'GAVETA';
  reprint?: boolean;
}

/** DANFE NFC-e: o cupom fiscal impresso, com a chave de acesso e o QR Code da consulta. */
export interface NfceTicket {
  kind: 'NFCE';
  homologacao: boolean;
  emitter: { legalName: string; cnpj: string; ie: string; address: string };
  items: { code: string; name: string; qty: number; unit: string; unitCents: number; totalCents: number }[];
  itemsCents: number;
  discountCents: number;
  totalCents: number;
  payments: { label: string; amountCents: number }[];
  changeCents: number;
  /** CPF do consumidor (só os 3 primeiros e 2 últimos dígitos aparecem no papel). */
  cpf: string | null;
  series: number;
  number: number;
  issuedAt: string;
  accessKey: string;
  protocol: string | null;
  authorizedAt: string | null;
  qrCode: string;
  urlChave: string;
  reprint?: boolean;
}

export type TicketPayload = ProductionTicket | CancelTicket | TestTicket | BillTicket | CashTicket | DrawerTicket | NfceTicket;
