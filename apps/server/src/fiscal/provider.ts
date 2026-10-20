/**
 * Emissora de NFC-e (SPEC 5.8). Fase 5: uma implementação por API (Nuvem Fiscal, Focus NFe,
 * PlugNotas…), escolhida com o estabelecimento e o contador. O caixa só conversa com esta
 * interface, então trocar de emissora não mexe no resto do sistema.
 */
export interface FiscalEmitItem {
  description: string;
  qty: number;
  unitPriceCents: number;
  totalCents: number;
  ncm: string;
  cfop: string;
  csosn: string;
  origin: string;
  cest: string | null;
  unit: string;
}

export interface FiscalEmitInput {
  series: number;
  number: number;
  environment: 'HOMOLOGACAO' | 'PRODUCAO';
  issuedAt: Date;
  items: FiscalEmitItem[];
  discountCents: number;
  /** Taxa de serviço e couvert entram como outras despesas/itens, conforme orientação do contador. */
  otherCents: number;
  payments: { method: 'CREDITO' | 'DEBITO' | 'PIX' | 'DINHEIRO'; amountCents: number; changeCents: number }[];
  /** CPF do consumidor na nota (só os dígitos), quando pedido. */
  consumerCpf: string | null;
}

export interface FiscalEmitResult {
  status: 'AUTORIZADA' | 'REJEITADA' | 'CONTINGENCIA';
  accessKey: string;
  protocol: string | null;
  xml: string | null;
  /** Mensagem da SEFAZ quando rejeitada. */
  message: string | null;
  /** Dados para imprimir o DANFE NFC-e (QR Code da consulta). */
  qrCodeUrl: string | null;
}

export interface FiscalProvider {
  readonly name: string;
  emit(input: FiscalEmitInput): Promise<FiscalEmitResult>;
  cancel(accessKey: string, reason: string): Promise<{ ok: boolean; xml: string | null; message: string | null }>;
}
