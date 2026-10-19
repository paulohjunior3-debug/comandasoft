// Contratos da fila de impressão (SPEC 5.5).

export const PRINT_JOB_STATUSES = ['PENDENTE', 'IMPRIMINDO', 'OK', 'ERRO'] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

export type PrintJobType = 'PRODUCAO' | 'CANCELAMENTO' | 'PRE_CONTA' | 'CUPOM' | 'DANFE' | 'CAIXA' | 'TESTE';

export interface PrintJobSummary {
  id: string;
  printerId: string;
  printerName: string;
  sectorLabel: string;
  type: PrintJobType;
  status: PrintJobStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  printedAt: string | null;
  nextAttemptAt: string | null;
  reprintOf: string | null;
  /** Resumo para a lista: "Mesa 10 · Paulo, Ana · 3 itens". */
  description: string;
}

export interface PrinterQueueStatus {
  printerId: string;
  printerName: string;
  sectorLabel: string;
  active: boolean;
  pending: number;
  errors: number;
  lastError: string | null;
  lastPrintedAt: string | null;
}

export interface PrintQueueResponse {
  /** "emulador" grava os cupons em arquivo (desenvolvimento); "windows" manda para as impressoras. */
  mode: 'emulador' | 'windows';
  printers: PrinterQueueStatus[];
  jobs: PrintJobSummary[];
}
