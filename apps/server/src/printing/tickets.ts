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
  items: { qty: number; name: string; notes: string | null }[];
  /** Marcado nas reimpressões para a cozinha não preparar de novo. */
  reprint?: boolean;
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

export type TicketPayload = ProductionTicket | CancelTicket | TestTicket | BillTicket | CashTicket | DrawerTicket;
