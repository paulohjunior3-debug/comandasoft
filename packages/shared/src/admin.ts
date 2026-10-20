import { z } from 'zod';
import { roleSchema } from './roles';

// Contratos dos cadastros do painel administrativo (SPEC 5.1).
// Os schemas de entrada aceitam strings vazias vindas de formulários e as tratam como "sem valor".

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullish()
    .transform((v) => v ?? null);

const name = (label: string, max = 80) => z.string().trim().min(1, `Informe ${label}`).max(max);
const cents = z.number().int('Valor inválido').min(0, 'Valor não pode ser negativo');
const id = z.string().uuid();

// ---------- Categorias ----------

export const categoryInputSchema = z.object({
  name: name('o nome da categoria'),
  sortOrder: z.number().int().min(0).default(0),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Cor inválida')
    .nullish()
    .transform((v) => v ?? null),
  active: z.boolean().default(true),
  /** Impressoras em que os itens desta categoria saem (SPEC 5.5). */
  printerIds: z.array(id).default([]),
});
export type CategoryInput = z.input<typeof categoryInputSchema>;

export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  color: string | null;
  active: boolean;
  printerIds: string[];
  productCount: number;
}

// ---------- Produtos ----------

export const productInputSchema = z.object({
  categoryId: id.or(z.literal('')).refine((v) => v !== '', 'Escolha a categoria'),
  name: name('o nome do produto', 120),
  description: optionalText(500),
  imageUrl: optionalText(500),
  priceCents: cents,
  sku: optionalText(40),
  active: z.boolean().default(true),
  soldOut: z.boolean().default(false),
  // Dados fiscais para a NFC-e (fase 5). Opcionais por enquanto.
  ncm: z
    .string()
    .trim()
    .regex(/^(\d{8})?$/, 'NCM deve ter 8 dígitos')
    .transform((v) => v || null)
    .nullish()
    .transform((v) => v ?? null),
  cfop: z
    .string()
    .trim()
    .regex(/^(\d{4})?$/, 'CFOP deve ter 4 dígitos')
    .transform((v) => v || null)
    .nullish()
    .transform((v) => v ?? null),
  csosn: optionalText(4),
  unit: z.string().trim().min(1).max(6).default('UN'),
  origin: optionalText(1),
  cest: z
    .string()
    .trim()
    .regex(/^(\d{7})?$/, 'CEST deve ter 7 dígitos')
    .transform((v) => v || null)
    .nullish()
    .transform((v) => v ?? null),
});
export type ProductInput = z.input<typeof productInputSchema>;

export interface Product {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  priceCents: number;
  sku: string | null;
  active: boolean;
  soldOut: boolean;
  ncm: string | null;
  cfop: string | null;
  csosn: string | null;
  unit: string;
  origin: string | null;
  cest: string | null;
}

/** Alteração rápida de "esgotado", usada também pelo garçom/gerente no futuro. */
export const productSoldOutSchema = z.object({ soldOut: z.boolean() });

// ---------- Mesas ----------

export const tableInputSchema = z.object({
  number: z.number().int('Número inválido').min(1, 'Número deve ser maior que zero').max(9999),
  area: optionalText(40),
  capacity: z.number().int().min(1).max(100).nullish().transform((v) => v ?? null),
  active: z.boolean().default(true),
});
export type TableInput = z.input<typeof tableInputSchema>;

/** Criação de várias mesas de uma vez (ex.: 1 a 30 no salão). */
export const tableBulkInputSchema = z
  .object({
    from: z.number().int().min(1).max(9999),
    to: z.number().int().min(1).max(9999),
    area: optionalText(40),
    capacity: z.number().int().min(1).max(100).nullish().transform((v) => v ?? null),
  })
  .refine((v) => v.to >= v.from, { message: 'O número final deve ser maior ou igual ao inicial', path: ['to'] })
  .refine((v) => v.to - v.from < 500, { message: 'Máximo de 500 mesas por vez', path: ['to'] });
export type TableBulkInput = z.input<typeof tableBulkInputSchema>;

export interface DiningTable {
  id: string;
  number: number;
  area: string | null;
  capacity: number | null;
  active: boolean;
  qrToken: string;
}

// ---------- Impressoras ----------

export const PRINTER_WIDTHS = [58, 80] as const;
export const PRINTER_CODEPAGES = ['CP860', 'CP850', 'CP437', 'SEM_ACENTO'] as const;

export const printerInputSchema = z.object({
  name: name('o nome da impressora', 60),
  /** Nome exato da impressora instalada no Windows do PC do caixa. */
  windowsName: name('a impressora do Windows', 200),
  /** Texto que sai em destaque no cupom (ex.: BAR, COZINHA). */
  sectorLabel: name('o setor', 20).transform((v) => v.toUpperCase()),
  widthMm: z.union([z.literal(58), z.literal(80)]).default(80),
  codepage: z.enum(PRINTER_CODEPAGES).default('CP860'),
  cut: z.boolean().default(true),
  active: z.boolean().default(true),
  /** Categorias cujos itens saem nesta impressora (o dono configura pela tela da impressora). */
  categoryIds: z.array(id).default([]),
});
export type PrinterInput = z.input<typeof printerInputSchema>;

export interface Printer {
  id: string;
  name: string;
  windowsName: string;
  sectorLabel: string;
  widthMm: 58 | 80;
  codepage: (typeof PRINTER_CODEPAGES)[number];
  cut: boolean;
  active: boolean;
  categoryIds: string[];
  /** false quando o nome não aparece mais entre as impressoras instaladas no Windows. */
  installed: boolean | null;
}

export interface InstalledPrinter {
  name: string;
  driverName: string | null;
  portName: string | null;
}

// ---------- Usuários ----------

// 4 dígitos bastam para o dia a dia no celular (o login tem limite de tentativas); admin: use uma mais forte.
const password = z.string().min(4, 'A senha precisa de pelo menos 4 caracteres').max(128);
const pin = z
  .string()
  .regex(/^(\d{4,6})?$/, 'O PIN deve ter de 4 a 6 números')
  .transform((v) => v || null)
  .nullish()
  .transform((v) => v ?? null);

const userBase = {
  name: name('o nome'),
  login: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'O login precisa de pelo menos 3 caracteres')
    .max(32)
    .regex(/^[a-z0-9._-]+$/, 'Use apenas letras, números, ponto, hífen ou sublinhado'),
  role: roleSchema,
  active: z.boolean().default(true),
};

export const userCreateSchema = z.object({ ...userBase, password, pin });
export type UserCreateInput = z.input<typeof userCreateSchema>;

/** Na edição, senha e PIN só mudam se forem informados. `clearPin` remove o PIN. */
export const userUpdateSchema = z.object({
  ...userBase,
  password: password.or(z.literal('')).optional(),
  pin: z
    .string()
    .regex(/^(\d{4,6})?$/, 'O PIN deve ter de 4 a 6 números')
    .optional(),
  clearPin: z.boolean().optional(),
});
export type UserUpdateInput = z.input<typeof userUpdateSchema>;

export interface AdminUser {
  id: string;
  name: string;
  login: string;
  role: z.infer<typeof roleSchema>;
  active: boolean;
  hasPin: boolean;
  createdAt: string;
}

// ---------- Configurações ----------

export const SERVICE_FEE_BASIS_POINTS = 1000; // 10%, decidido pelo dono (SPEC 12)

export const settingsSchema = z.object({
  /** Liga/desliga a taxa de serviço de 10% (SPEC 5.7). */
  serviceFeeEnabled: z.boolean(),
  couvertCents: cents,
  /** Vários shows no mesmo dia: cobrar o couvert uma vez por pessoa ou a cada show. */
  couvertMode: z.enum(['UMA_VEZ', 'POR_SHOW']),
  /** Minutos sem atendimento para a mesa ficar amarela / vermelha no mapa. */
  alertYellowMinutes: z.number().int().min(1).max(240),
  alertRedMinutes: z.number().int().min(1).max(480),
  companyName: z.string().trim().max(120),
  companyDocument: z.string().trim().max(20),
  companyAddress: z.string().trim().max(200),
  companyPhone: z.string().trim().max(20),
  receiptFooter: z.string().trim().max(200),
  /** Impressora do caixa: pré-conta, cupom final, gaveta e relatórios (SPEC 5.5). */
  cashierPrinterId: z.string().uuid().nullable(),
  /**
   * Endereço que vai no QR das mesas (ex.: http://192.168.0.10:8080). Vazio = o sistema sugere
   * pelo IP deste PC. Se o IP mudar, os QR impressos param de funcionar: fixe o IP no roteador.
   */
  qrBaseUrl: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === '' || /^https?:\/\/[^\s/]+$/.test(v.replace(/\/$/, '')), 'Endereço do QR inválido (ex.: http://192.168.0.10:8080).')
    .transform((v) => v.replace(/\/$/, '')),
  /** Nome do Wi-Fi para os clientes, impresso no cartão do QR. */
  guestWifiName: z.string().trim().max(60),
  /** Semana do bar: dia do Período 1 (0 = domingo … 6 = sábado) e dias em que não abre. */
  weekStartDay: z.number().int().min(0).max(6),
  closedDays: z
    .array(z.number().int().min(0).max(6))
    .max(6, 'O bar precisa abrir pelo menos um dia na semana.')
    .transform((d) => [...new Set(d)].sort()),
}).refine((s) => s.alertRedMinutes > s.alertYellowMinutes, {
  message: 'O tempo do vermelho deve ser maior que o do amarelo',
  path: ['alertRedMinutes'],
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  serviceFeeEnabled: false,
  couvertCents: 0,
  couvertMode: 'UMA_VEZ',
  alertYellowMinutes: 15,
  alertRedMinutes: 30,
  companyName: '',
  companyDocument: '',
  companyAddress: '',
  companyPhone: '',
  receiptFooter: 'Obrigado pela preferência!',
  cashierPrinterId: null,
  qrBaseUrl: '',
  guestWifiName: '',
  weekStartDay: 1,
  closedDays: [],
};

/** Foto do produto: imagem já reduzida no navegador, enviada como data URL (JPEG/WebP/PNG). */
export const productImageSchema = z.object({
  dataUrl: z
    .string()
    .regex(/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/, 'Envie uma imagem JPG, PNG ou WebP.')
    .max(1_400_000, 'Foto grande demais (máx. 1 MB depois de reduzida).'),
});
