import { z } from 'zod';

/**
 * Preparação da NFC-e (SPEC 5.8, fase 5): dados do emitente, CSC, certificado A1, dados
 * fiscais dos produtos e guarda dos XMLs para a contabilidade. A emissão em si entra quando
 * o estabelecimento escolher a emissora (Nuvem Fiscal, Focus NFe, PlugNotas…).
 */

export const TAX_REGIMES = ['SIMPLES_NACIONAL', 'SIMPLES_EXCESSO', 'NORMAL'] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];
export const TAX_REGIME_LABELS: Record<TaxRegime, string> = {
  SIMPLES_NACIONAL: 'Simples Nacional',
  SIMPLES_EXCESSO: 'Simples Nacional – excesso de sublimite',
  NORMAL: 'Regime Normal (Lucro Presumido ou Real)',
};

export const FISCAL_ENVIRONMENTS = ['HOMOLOGACAO', 'PRODUCAO'] as const;
export type FiscalEnvironment = (typeof FISCAL_ENVIRONMENTS)[number];
export const FISCAL_ENVIRONMENT_LABELS: Record<FiscalEnvironment, string> = {
  HOMOLOGACAO: 'Homologação (teste, sem valor fiscal)',
  PRODUCAO: 'Produção (notas valendo)',
};

export const UFS = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE',
  'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
] as const;

/** Origem da mercadoria (tabela da NF-e). */
export const ORIGIN_LABELS: Record<string, string> = {
  '0': '0 – Nacional',
  '1': '1 – Estrangeira (importação direta)',
  '2': '2 – Estrangeira (mercado interno)',
  '3': '3 – Nacional, conteúdo importado 40–70%',
  '4': '4 – Nacional, processo produtivo básico',
  '5': '5 – Nacional, conteúdo importado até 40%',
  '6': '6 – Estrangeira sem similar (importação direta)',
  '7': '7 – Estrangeira sem similar (mercado interno)',
  '8': '8 – Nacional, conteúdo importado acima de 70%',
};

const digits = (n: number, label: string) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v === '' || v.length === n, `${label} deve ter ${n} dígitos`);
const text = (max: number) => z.string().trim().max(max);

export function isValidCnpj(value: string): boolean {
  const d = value.replace(/\D/g, '');
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((s, w, i) => s + w * Number(d[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/** Dados públicos do emitente e da numeração (os segredos ficam fora: CSC e certificado). */
export const fiscalSettingsSchema = z.object({
  legalName: text(120),
  tradeName: text(120),
  cnpj: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v === '' || isValidCnpj(v), 'CNPJ inválido'),
  stateRegistration: z
    .string()
    .trim()
    .transform((v) => v.replace(/[^\dA-Za-z]/g, '').toUpperCase())
    .refine((v) => v.length <= 14, 'Inscrição estadual inválida'),
  regime: z.enum(TAX_REGIMES),
  street: text(120),
  number: text(20),
  complement: text(60),
  district: text(60),
  city: text(60),
  /** Código IBGE do município (7 dígitos). */
  cityCode: digits(7, 'Código IBGE do município'),
  uf: z.enum(UFS),
  zip: digits(8, 'CEP'),
  phone: text(20),
  environment: z.enum(FISCAL_ENVIRONMENTS),
  series: z.number().int().min(1, 'Série de 1 a 999').max(999, 'Série de 1 a 999'),
  nextNumber: z.number().int().min(1).max(999_999_999),
  /** Padrões para produtos sem dado próprio (o contador confirma). */
  defaultCfop: digits(4, 'CFOP padrão'),
  defaultCsosn: z.string().trim().regex(/^(\d{2,3})?$/, 'CSOSN/CST padrão inválido'),
  defaultOrigin: z.string().regex(/^[0-8]$/, 'Origem inválida'),
  /** E-mail do contador, para mandar os XMLs do mês. */
  accountantEmail: z.union([z.literal(''), z.string().trim().email('E-mail do contador inválido')]),
});
export type FiscalSettings = z.infer<typeof fiscalSettingsSchema>;

export const DEFAULT_FISCAL_SETTINGS: FiscalSettings = {
  legalName: '',
  tradeName: '',
  cnpj: '',
  stateRegistration: '',
  regime: 'SIMPLES_NACIONAL',
  street: '',
  number: '',
  complement: '',
  district: '',
  city: '',
  cityCode: '',
  uf: 'MG',
  zip: '',
  phone: '',
  environment: 'HOMOLOGACAO',
  series: 1,
  nextNumber: 1,
  defaultCfop: '5102',
  defaultCsosn: '102',
  defaultOrigin: '0',
  accountantEmail: '',
};

/** CSC (Código de Segurança do Contribuinte), fornecido pela SEFAZ no credenciamento da NFC-e. */
export const cscInputSchema = z.object({
  cscId: z.string().trim().regex(/^\d{1,6}$/, 'ID do CSC: só números (ex.: 000001)'),
  cscToken: z.string().trim().min(16, 'Código CSC muito curto').max(36, 'Código CSC muito longo'),
});

/** Certificado A1 (.pfx/.p12) enviado em base64 com a senha. */
export const certificateUploadSchema = z.object({
  pfxBase64: z.string().min(100, 'Arquivo do certificado vazio').max(200_000, 'Arquivo grande demais para um certificado A1'),
  password: z.string().min(1, 'Informe a senha do certificado').max(100),
});

export interface CertificateInfo {
  subject: string;
  /** CNPJ do titular, quando consta no certificado (ICP-Brasil). */
  cnpj: string | null;
  validFrom: string;
  validUntil: string;
  uploadedAt: string;
  daysLeft: number;
}

export interface FiscalReadinessItem {
  key: string;
  label: string;
  ok: boolean;
  hint?: string;
}

export interface FiscalStatus {
  settings: FiscalSettings;
  cscConfigured: boolean;
  cscId: string | null;
  certificate: CertificateInfo | null;
  /** Emissora (API fiscal): ainda não escolhida até a fase 5. */
  provider: string | null;
  productsMissingNcm: number;
  activeProducts: number;
  readiness: FiscalReadinessItem[];
}

/** Dados fiscais de um produto, editados em lote (tela do contador). */
export const productFiscalSchema = z.object({
  id: z.string().uuid(),
  ncm: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v === '' || v.length === 8, 'NCM deve ter 8 dígitos')
    .transform((v) => v || null),
  cfop: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v === '' || v.length === 4, 'CFOP deve ter 4 dígitos')
    .transform((v) => v || null),
  csosn: z
    .string()
    .trim()
    .regex(/^(\d{2,3})?$/, 'CSOSN/CST deve ter 2 ou 3 dígitos')
    .transform((v) => v || null),
  origin: z
    .string()
    .trim()
    .regex(/^([0-8])?$/, 'Origem de 0 a 8')
    .transform((v) => v || null),
  cest: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v === '' || v.length === 7, 'CEST deve ter 7 dígitos')
    .transform((v) => v || null),
});
export const productFiscalBulkSchema = z.object({ items: z.array(productFiscalSchema).min(1).max(2000) });
export type ProductFiscalInput = z.input<typeof productFiscalSchema>;

export interface ProductFiscalRow {
  id: string;
  name: string;
  categoryName: string;
  priceCents: number;
  active: boolean;
  ncm: string | null;
  cfop: string | null;
  csosn: string | null;
  origin: string | null;
  cest: string | null;
}

export const FISCAL_DOCUMENT_STATUSES = ['AUTORIZADA', 'CANCELADA', 'REJEITADA', 'CONTINGENCIA'] as const;
export type FiscalDocumentStatus = (typeof FISCAL_DOCUMENT_STATUSES)[number];

export interface FiscalMonthSummary {
  month: string;
  authorized: number;
  canceled: number;
  totalCents: number;
  canceledCents: number;
}

export const fiscalMonthSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês inválido (use AAAA-MM).') });
