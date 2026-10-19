/**
 * Conteúdo dos cupons, gravado em print_jobs.payload. O worker transforma isso em ESC/POS
 * conforme a largura e a página de código de cada impressora (ver layouts.ts).
 */
export interface ProductionTicket {
  kind: 'PRODUCAO';
  /** BAR, COZINHA… em fonte dupla no topo. */
  sector: string;
  tableNumber: number;
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

export interface TestTicket {
  kind: 'TESTE';
  printerName: string;
  windowsName: string;
  sector: string;
  requestedBy: string;
  createdAt: string;
  reprint?: boolean;
}

export type TicketPayload = ProductionTicket | TestTicket;
