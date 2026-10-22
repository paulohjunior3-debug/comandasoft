import { z } from 'zod';
import { daysBetween } from './time';

/** Grupos da tela de auditoria (SPEC 5.10). */
export const AUDIT_GROUPS = ['ACESSO', 'CAIXA', 'VENDAS', 'CANCELAMENTOS', 'CADASTROS', 'CONFIGURACOES', 'IMPRESSAO', 'CLIENTE_QR'] as const;
export type AuditGroup = (typeof AUDIT_GROUPS)[number];
export const AUDIT_GROUP_LABELS: Record<AuditGroup, string> = {
  ACESSO: 'Acesso (login)',
  CAIXA: 'Caixa (abertura, sangria, fechamento)',
  VENDAS: 'Vendas (comandas e pagamentos)',
  CANCELAMENTOS: 'Cancelamentos, descontos e estornos',
  CADASTROS: 'Cadastros (produtos, mesas, usuários)',
  CONFIGURACOES: 'Configurações',
  IMPRESSAO: 'Impressão',
  CLIENTE_QR: 'QR do cliente',
};

/** Nome em português e grupo de cada ação gravada em audit_logs. */
export const AUDIT_ACTIONS: Record<string, { label: string; group: AuditGroup; sensitive?: boolean }> = {
  LOGIN: { label: 'Entrou no sistema', group: 'ACESSO' },
  LOGIN_FALHOU: { label: 'Senha errada no login', group: 'ACESSO', sensitive: true },
  REFRESH_REUTILIZADO: { label: 'Sessão reutilizada (possível cópia do login)', group: 'ACESSO', sensitive: true },

  CAIXA_ABERTO: { label: 'Abriu o caixa', group: 'CAIXA' },
  CAIXA_FECHADO: { label: 'Fechou o caixa', group: 'CAIXA' },
  SANGRIA: { label: 'Sangria', group: 'CAIXA' },
  SUPRIMENTO: { label: 'Suprimento', group: 'CAIXA' },

  COMANDA_ABERTA: { label: 'Abriu comanda', group: 'VENDAS' },
  COMANDA_FECHAMENTO_SOLICITADO: { label: 'Pediu o fechamento da comanda', group: 'VENDAS' },
  PAGAMENTO: { label: 'Recebeu pagamento', group: 'VENDAS' },
  CUPOM_FISCAL_SOLICITADO: { label: 'Pediu cupom fiscal', group: 'VENDAS' },
  PEDIDO_PRECO_DIVERGENTE: { label: 'Pedido com preço desatualizado no celular', group: 'VENDAS' },
  MESA_ALERTA_CONTA_REMOVIDO: { label: 'Tirou a mesa do vermelho (conta impressa)', group: 'VENDAS' },

  ITEM_CANCELADO: { label: 'Cancelou item', group: 'CANCELAMENTOS', sensitive: true },
  COMANDA_CANCELADA: { label: 'Cancelou mesa/comanda', group: 'CANCELAMENTOS', sensitive: true },
  ESTORNO: { label: 'Estornou pagamento', group: 'CANCELAMENTOS', sensitive: true },
  PAGAMENTO_FORMA_ALTERADA: { label: 'Alterou a forma de pagamento', group: 'CANCELAMENTOS', sensitive: true },
  DESCONTO: { label: 'Deu desconto', group: 'CANCELAMENTOS', sensitive: true },
  DESCONTO_DESFEITO: { label: 'Desfez desconto', group: 'CANCELAMENTOS' },
  TAXA_SERVICO_REMOVIDA: { label: 'Retirou a taxa de serviço', group: 'CANCELAMENTOS', sensitive: true },
  TAXA_SERVICO_REMOVIDA_DESFEITO: { label: 'Devolveu a taxa de serviço', group: 'CANCELAMENTOS' },
  COUVERT_REMOVIDO: { label: 'Retirou o couvert', group: 'CANCELAMENTOS', sensitive: true },
  COUVERT_REMOVIDO_DESFEITO: { label: 'Devolveu o couvert', group: 'CANCELAMENTOS' },

  PRODUTO_CRIADO: { label: 'Cadastrou produto', group: 'CADASTROS' },
  PRODUTO_ALTERADO: { label: 'Alterou produto', group: 'CADASTROS' },
  PRODUTO_PRECO_ALTERADO: { label: 'Alterou preço de produto', group: 'CADASTROS', sensitive: true },
  PRODUTO_EXCLUIDO: { label: 'Excluiu produto', group: 'CADASTROS' },
  PRODUTO_ESGOTADO: { label: 'Marcou produto como esgotado', group: 'CADASTROS' },
  PRODUTO_DISPONIVEL: { label: 'Produto voltou a ficar disponível', group: 'CADASTROS' },
  CATEGORIA_CRIADA: { label: 'Cadastrou categoria', group: 'CADASTROS' },
  CATEGORIA_ALTERADA: { label: 'Alterou categoria', group: 'CADASTROS' },
  CATEGORIA_EXCLUIDA: { label: 'Excluiu categoria', group: 'CADASTROS' },
  CARDAPIO_IMPORTADO: { label: 'Importou cardápio', group: 'CADASTROS' },
  MESA_CRIADA: { label: 'Cadastrou mesa', group: 'CADASTROS' },
  MESAS_CRIADAS_LOTE: { label: 'Cadastrou várias mesas', group: 'CADASTROS' },
  MESA_ALTERADA: { label: 'Alterou mesa', group: 'CADASTROS' },
  MESA_EXCLUIDA: { label: 'Excluiu mesa', group: 'CADASTROS' },
  MESA_QR_REGERADO: { label: 'Gerou novo QR da mesa', group: 'CADASTROS' },
  USUARIO_CRIADO: { label: 'Cadastrou usuário', group: 'CADASTROS', sensitive: true },
  USUARIO_ALTERADO: { label: 'Alterou usuário', group: 'CADASTROS', sensitive: true },
  USUARIO_ALTERADO_SENHA: { label: 'Trocou a senha de usuário', group: 'CADASTROS', sensitive: true },
  CAIXA_CADASTRADO: { label: 'Cadastrou caixa', group: 'CADASTROS' },
  CAIXA_ALTERADO: { label: 'Alterou caixa', group: 'CADASTROS' },
  IMPRESSORA_CRIADA: { label: 'Cadastrou impressora', group: 'CADASTROS' },
  IMPRESSORA_ALTERADA: { label: 'Alterou impressora', group: 'CADASTROS' },
  IMPRESSORA_EXCLUIDA: { label: 'Excluiu impressora', group: 'CADASTROS' },

  CONFIGURACOES_ALTERADAS: { label: 'Alterou as configurações', group: 'CONFIGURACOES' },
  TAXA_SERVICO_LIGADA: { label: 'Ligou a taxa de serviço', group: 'CONFIGURACOES', sensitive: true },
  TAXA_SERVICO_DESLIGADA: { label: 'Desligou a taxa de serviço', group: 'CONFIGURACOES', sensitive: true },

  REIMPRESSAO: { label: 'Reimprimiu cupom', group: 'IMPRESSAO' },
  PAINEL_REVERTIDO: { label: 'Voltou pedido para o painel da cozinha', group: 'IMPRESSAO' },

  TRANSFERENCIA: { label: 'Transferiu comanda de mesa', group: 'VENDAS' },
  ITEM_TRANSFERIDO: { label: 'Moveu item para outra comanda', group: 'CANCELAMENTOS', sensitive: true },
  VENDA_BALCAO_ABERTA: { label: 'Abriu venda no balcão', group: 'VENDAS' },
  COUVERT_INICIADO: { label: 'Iniciou o couvert', group: 'CAIXA' },
  COUVERT_ENCERRADO: { label: 'Encerrou o couvert', group: 'CAIXA' },
  FISCAL_CONFIG_ALTERADA: { label: 'Alterou os dados fiscais', group: 'CONFIGURACOES' },
  FISCAL_CSC_ALTERADO: { label: 'Alterou o CSC da NFC-e', group: 'CONFIGURACOES', sensitive: true },
  CERTIFICADO_ENVIADO: { label: 'Enviou o certificado digital', group: 'CONFIGURACOES', sensitive: true },
  CERTIFICADO_REMOVIDO: { label: 'Removeu o certificado digital', group: 'CONFIGURACOES', sensitive: true },
  PRODUTOS_FISCAL_ALTERADOS: { label: 'Alterou dados fiscais de produtos', group: 'CADASTROS' },
  FISCAL_XML_EXPORTADO: { label: 'Baixou os XMLs para o contador', group: 'CONFIGURACOES' },
  PRODUTO_FOTO_ALTERADA: { label: 'Trocou a foto de produto', group: 'CADASTROS' },
  PRODUTO_FOTO_REMOVIDA: { label: 'Removeu a foto de produto', group: 'CADASTROS' },
  QR_BLOQUEADO: { label: 'QR bloqueado por PIN errado', group: 'CLIENTE_QR', sensitive: true },
  QR_LIBERADO: { label: 'Liberou o QR da comanda', group: 'CLIENTE_QR' },
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTIONS[action]?.label ?? action.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export function auditActionsOf(group: AuditGroup): string[] {
  return Object.entries(AUDIT_ACTIONS)
    .filter(([, a]) => a.group === group)
    .map(([key]) => key);
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (use AAAA-MM-DD).');

export const auditQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    userId: z.string().uuid('Usuário inválido.').optional(),
    group: z.enum(AUDIT_GROUPS).optional(),
    action: z.string().regex(/^[A-Z_]{2,60}$/, 'Ação inválida.').optional(),
    /** Busca no conteúdo do registro (nome de produto, cliente, motivo…). */
    q: z.string().trim().max(80).optional(),
    /** Só as ações sensíveis (cancelamento, desconto, estorno, preço, senha…). */
    sensitive: z
      .enum(['1', 'true'])
      .optional()
      .transform((v) => v !== undefined),
    /** Paginação: registros mais antigos que este (id do último da página anterior). */
    before: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .refine((q) => q.from <= q.to, { message: 'A data inicial é depois da final.', path: ['to'] })
  .refine((q) => daysBetween(q.from, q.to) <= 366, { message: 'Escolha um período de até 1 ano.', path: ['to'] });
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AuditEntry {
  id: string;
  at: string;
  userId: string | null;
  userName: string | null;
  userRole: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Passe em `before` para buscar a próxima página; null = acabou. */
  nextBefore: string | null;
}

export interface AuditOptions {
  users: { id: string; name: string; role: string; active: boolean }[];
  /** Ações que já aparecem no registro (inclui as que não têm nome em português). */
  actions: string[];
}
