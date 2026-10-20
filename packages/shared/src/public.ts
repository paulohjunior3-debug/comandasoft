import { z } from 'zod';
import type { ComandaTotals } from './billing';
import type { PaymentMethod } from './cashier';
import type { MenuCategory } from './waiter';

/**
 * QR da mesa (SPEC 5.6): cardápio aberto e consulta da própria comanda, somente leitura,
 * liberada pelo PIN = 4 últimos números do telefone.
 */

/** Tentativas erradas de PIN por comanda antes de bloquear a consulta (até o garçom liberar). */
export const QR_MAX_WRONG_PINS = 5;
export const QR_WRONG_PIN_WINDOW_MINUTES = 10;

/** PIN do QR: 4 últimos números do telefone (comandas antigas sem telefone: 3 últimos do CPF). */
export const qrUnlockSchema = z.object({
  pin: z.string().regex(/^\d{3,4}$/, 'Digite os 4 últimos números do telefone.'),
});

/** O PIN de uma comanda: últimos 4 do telefone ou, se não houver telefone, últimos 3 do CPF. */
export function qrPinOf(c: { phone: string | null; cpfLast3: string | null }): string | null {
  const phone = (c.phone ?? '').replace(/\D/g, '');
  if (phone.length >= 4) return phone.slice(-4);
  return c.cpfLast3 ? c.cpfLast3.padStart(3, '0').slice(-3) : null;
}

export interface PublicTableInfo {
  tableNumber: number;
  companyName: string;
  guestWifiName: string;
  serviceFeeEnabled: boolean;
  menu: MenuCategory[];
}

export interface PublicComandaOption {
  id: string;
  /** Nome mascarado: "Pau*** H." */
  maskedName: string;
  locked: boolean;
  /** Quantos dígitos o PIN tem: 4 (telefone) ou 3 (CPF, comandas antigas). */
  pinDigits: 3 | 4;
}

export interface QrUnlockResult {
  token: string;
  expiresInSeconds: number;
}

export interface PublicComandaView {
  customerName: string;
  tableNumber: number;
  status: 'ABERTA' | 'EM_FECHAMENTO';
  openedAt: string;
  peopleCount: number;
  items: { name: string; qty: number; amountCents: number; sharedWith: number; at: string }[];
  totals: ComandaTotals;
  serviceFeeWaived: boolean;
  payments: { payerName: string; method: PaymentMethod; amountCents: number; at: string }[];
  updatedAt: string;
}

export const PUBLIC_ERRORS = {
  WRONG_PIN: 'WRONG_PIN',
  QR_LOCKED: 'QR_LOCKED',
  COMANDA_CLOSED: 'COMANDA_CLOSED',
} as const;

/**
 * Nome para a lista do QR, sem expor quem está na mesa: 3 primeiras letras e a inicial do
 * sobrenome ("Paulo Henrique" → "Pau*** H.", "Ana" → "Ana***").
 */
export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '***';
  const first = [...parts[0]!].slice(0, 3).join('');
  const last = parts.length > 1 ? ` ${[...parts.at(-1)!][0]!.toUpperCase()}.` : '';
  return `${first}***${last}`;
}

/** Admin → Mesas → Imprimir QR: porta do servidor do cliente e endereços sugeridos por IP. */
export interface QrInfo {
  /** null = servidor do QR desligado (PUBLIC_PORT vazio no .env). */
  publicPort: number | null;
  suggestedBaseUrls: string[];
}
