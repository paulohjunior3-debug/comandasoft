/**
 * Conteúdo dos cupons, gravado em print_jobs.payload. O worker de impressão (próxima etapa)
 * transforma isso em ESC/POS conforme a largura e a página de código da impressora.
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
}

export type TicketPayload = ProductionTicket;
