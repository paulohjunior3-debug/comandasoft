/** Painel da cozinha (KDS): cada cartão é o cupom de produção de um pedido, esperando o "pronto". */
export interface KitchenTicket {
  /** id do cupom (print_job). */
  id: string;
  printerId: string;
  sector: string;
  tableNumber: number;
  /** "Balcão" nas vendas do balcão. */
  tableLabel: string | null;
  customers: string[];
  waiter: string;
  /** Quando o pedido chegou ao servidor (base do cronômetro). */
  createdAt: string;
  orderRef: string;
  takeaway: boolean;
  items: { qty: number; name: string; notes: string | null }[];
}

export interface KitchenPanelResponse {
  /** Hora do servidor, para o cronômetro não depender do relógio da máquina da cozinha. */
  now: string;
  printers: { id: string; name: string; sector: string }[];
  tickets: KitchenTicket[];
}

/** Até quantos minutos o pedido é "novo" (verde). */
export const KITCHEN_NEW_MINUTES = 10;
/** A partir de quantos minutos o pedido fica vermelho (perto dos 50 min). */
export const KITCHEN_LATE_MINUTES = 40;

export type KitchenTone = 'novo' | 'normal' | 'atrasado';

export function kitchenTone(minutes: number): KitchenTone {
  if (minutes >= KITCHEN_LATE_MINUTES) return 'atrasado';
  if (minutes < KITCHEN_NEW_MINUTES) return 'novo';
  return 'normal';
}
