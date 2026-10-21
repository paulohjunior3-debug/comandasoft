import { z } from 'zod';

/** Prazos do licenciamento (docs/licenciamento.md), em dias. */
export const LICENSE_TIMING = {
  /** Validade de cada lease renovado. */
  leaseDays: 15,
  /** Faixa amarela quando faltam esses dias para vencer. */
  warnDays: 7,
  /** Depois de vencer, ainda funciona tudo por esses dias (faixa vermelha). */
  graceDays: 3,
  /** Instalação sem licença. */
  trialDays: 15,
  /** Caixa aberto antes do bloqueio segue o dia até fechar, no máximo por estas horas. */
  openSessionHours: 24,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

const isoDate = z.iso.datetime({ offset: true });

/** Licença do cliente, assinada com a chave raiz do dono. */
export const licensePayloadSchema = z.object({
  tipo: z.literal('licenca'),
  id: z.string().min(1),
  cliente: z.string().min(1),
  cnpj: z.string(),
  /** Impressão digital da máquina (XXXX-XXXX-XXXX-XXXX); null = qualquer PC. */
  maquina: z.string().nullable(),
  emitidaEm: isoDate,
  /** Fim do contrato; null = enquanto houver lease. */
  validaAte: isoDate.nullable(),
  recursos: z.array(z.string()),
  /** Endereço do servidor de licenças; null = sem renovação (não precisa de lease). */
  renovacao: z.string().url().nullable(),
  /** Contato que aparece nos avisos e no bloqueio. */
  suporte: z.string().nullable(),
});
export type LicensePayload = z.infer<typeof licensePayloadSchema>;

/** Lease curto, assinado com a chave de renovação (servidor de licenças ou CLI do dono). */
export const leasePayloadSchema = z.object({
  tipo: z.literal('lease'),
  licencaId: z.string().min(1),
  maquina: z.string().nullable(),
  emitidoEm: isoDate,
  validoAte: isoDate,
});
export type LeasePayload = z.infer<typeof leasePayloadSchema>;

export const LICENSE_STATES = ['VALIDA', 'AVISO', 'CARENCIA', 'BLOQUEADA'] as const;
export type LicenseState = (typeof LICENSE_STATES)[number];

export interface LicenseRenewal {
  at: string;
  ok: boolean;
  message: string | null;
}

/** O que a tela de licença e as faixas de aviso mostram. */
export interface LicenseStatus {
  state: LicenseState;
  mode: 'LICENCIADA' | 'AVALIACAO';
  /** Frase pronta para a faixa ou o bloqueio (null quando está tudo certo). */
  message: string | null;
  licenseId: string | null;
  customer: string | null;
  cnpj: string | null;
  features: string[];
  /** Quando vence (lease, contrato ou avaliação); null = não vence. */
  expiresAt: string | null;
  /** Quando passa a bloquear (vencimento + carência). */
  blocksAt: string | null;
  /** Dias até vencer (negativo = vencida há tantos dias). */
  daysLeft: number | null;
  machineId: string | null;
  machineBound: boolean;
  autoRenew: boolean;
  lastRenewal: LicenseRenewal | null;
  support: string | null;
  /** false no desenvolvimento: mostra o estado, mas não bloqueia nada. */
  enforced: boolean;
}

/** Versão curta para as faixas do caixa e do admin (qualquer perfil logado). */
export type LicenseBannerInfo = Pick<LicenseStatus, 'state' | 'mode' | 'message' | 'daysLeft' | 'support'>;

export const installLicenseSchema = z.object({
  token: z.string().trim().min(10, 'Cole o texto da licença.'),
});

export const LICENSE_ERRORS = { BLOCKED: 'LICENCA_BLOQUEADA', INVALID: 'LICENCA_INVALIDA' } as const;

interface ComputeInput {
  license: LicensePayload | null;
  /** Só um lease da mesma licença (o serviço descarta os outros). */
  lease: LeasePayload | null;
  trialStartedAt: Date;
  machineId: string | null;
  /** Hora efetiva (já protegida contra relógio atrasado). */
  now: Date;
}

/**
 * Estado da licença numa hora. Puro: quem chama já conferiu as assinaturas.
 * Vencimento = o que vier primeiro entre o lease (ou a própria licença, nos primeiros dias) e o
 * fim do contrato; licença sem renovação não depende de lease.
 */
export function computeLicenseState({ license, lease, trialStartedAt, machineId, now }: ComputeInput) {
  let expiresAt: Date | null;
  let wrongMachine = false;
  if (license) {
    wrongMachine = license.maquina !== null && license.maquina !== machineId;
    const leaseEnd = license.renovacao
      ? new Date(
          Math.max(
            new Date(license.emitidaEm).getTime() + LICENSE_TIMING.leaseDays * DAY_MS,
            lease ? new Date(lease.validoAte).getTime() : 0,
          ),
        )
      : null;
    const contractEnd = license.validaAte ? new Date(license.validaAte) : null;
    expiresAt =
      leaseEnd && contractEnd ? (leaseEnd < contractEnd ? leaseEnd : contractEnd) : (leaseEnd ?? contractEnd);
  } else {
    expiresAt = new Date(trialStartedAt.getTime() + LICENSE_TIMING.trialDays * DAY_MS);
  }

  const blocksAt = expiresAt ? new Date(expiresAt.getTime() + LICENSE_TIMING.graceDays * DAY_MS) : null;
  const daysLeft = expiresAt ? Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS) : null;
  let state: LicenseState;
  if (wrongMachine) state = 'BLOQUEADA';
  else if (!expiresAt) state = 'VALIDA';
  else if (now.getTime() < expiresAt.getTime() - LICENSE_TIMING.warnDays * DAY_MS) state = 'VALIDA';
  else if (now < expiresAt) state = 'AVISO';
  else if (now < blocksAt!) state = 'CARENCIA';
  else state = 'BLOQUEADA';

  return { state, expiresAt, blocksAt, daysLeft, wrongMachine };
}

/** Frase da faixa/bloqueio para cada estado. */
export function licenseMessage(
  info: { state: LicenseState; mode: 'LICENCIADA' | 'AVALIACAO'; daysLeft: number | null; wrongMachine?: boolean },
  support: string | null,
): string | null {
  const contact = support ? ` Suporte: ${support}.` : ' Fale com o suporte.';
  const trial = info.mode === 'AVALIACAO';
  const days = info.daysLeft ?? 0;
  const graceLeft = Math.max(1, LICENSE_TIMING.graceDays + days);
  switch (info.state) {
    case 'VALIDA':
      return null;
    case 'AVISO':
      return trial
        ? `Período de avaliação: faltam ${days} dia(s). Instale a licença em Administração > Licença.${contact}`
        : `A licença vence em ${days} dia(s). Verifique a internet do computador do caixa.${contact}`;
    case 'CARENCIA':
      return trial
        ? `O período de avaliação acabou. Em ${graceLeft} dia(s) não será possível abrir caixa nem lançar pedidos.${contact}`
        : `A licença venceu. Em ${graceLeft} dia(s) não será possível abrir caixa nem lançar pedidos.${contact}`;
    case 'BLOQUEADA':
      if (info.wrongMachine) return `A licença é de outro computador. Abrir caixa e lançar pedidos está bloqueado.${contact}`;
      return trial
        ? `Período de avaliação encerrado. Abrir caixa e lançar pedidos está bloqueado; fechar contas e relatórios continuam liberados.${contact}`
        : `Licença vencida. Abrir caixa e lançar pedidos está bloqueado; fechar contas e relatórios continuam liberados.${contact}`;
  }
}
