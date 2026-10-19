/** Erro com status HTTP e mensagem para o usuário (pt-BR). O error handler do app responde com ele. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `${what} não encontrado(a).`);

interface PgErrorLike {
  code?: string;
  constraint?: string;
  constraint_name?: string;
  cause?: unknown;
}

/** Extrai código e constraint de erros do postgres-js, do PGlite e do wrapper do Drizzle. */
export function pgError(err: unknown): { code: string; constraint: string | undefined } | null {
  let e = err as PgErrorLike | undefined;
  for (let depth = 0; e && depth < 3; depth++) {
    if (typeof e.code === 'string' && /^\d{5}$/.test(e.code)) {
      return { code: e.code, constraint: e.constraint_name ?? e.constraint };
    }
    e = e.cause as PgErrorLike | undefined;
  }
  return null;
}

const UNIQUE_MESSAGES: Record<string, string> = {
  categories_name_unique: 'Já existe uma categoria com esse nome.',
  products_sku_unique: 'Já existe um produto com esse código.',
  printers_name_unique: 'Já existe uma impressora com esse nome.',
  tables_number_unique: 'Já existe uma mesa com esse número.',
  tables_qr_token_unique: 'Conflito ao gerar o QR da mesa. Tente de novo.',
  users_login_unique: 'Esse login já está em uso.',
};

/** Converte violações de integridade do banco em respostas 409 legíveis. */
export function mapDbError(err: unknown): HttpError | null {
  const pg = pgError(err);
  if (!pg) return null;
  if (pg.code === '23505') {
    return new HttpError(409, 'DUPLICATE', UNIQUE_MESSAGES[pg.constraint ?? ''] ?? 'Registro duplicado.');
  }
  if (pg.code === '23503') {
    return new HttpError(
      409,
      'IN_USE',
      'Não é possível excluir: este cadastro está sendo usado por outros. Desative-o em vez de excluir.',
    );
  }
  return null;
}

interface IssueLike {
  code: string;
  message: string;
  input?: unknown;
  path: PropertyKey[];
}

/**
 * Mensagem de validação para a tela. As mensagens dos schemas já são pt-BR (e as padrão do
 * Zod também, via @sistema-bar/shared). Campo que nem veio quase sempre é o app aberto numa
 * versão antiga depois de uma atualização: aí a orientação é recarregar a página.
 */
export function validationMessage(issues: IssueLike[]): string {
  const first = issues[0];
  if (!first) return 'Dados inválidos.';
  if (first.code === 'invalid_type' && first.input === undefined) {
    const field = first.path.length ? ` (${first.path.join('.')})` : '';
    return `Faltou um dado obrigatório${field}. Se o sistema foi atualizado, recarregue a página (F5) e tente de novo.`;
  }
  return first.message;
}

/** Erros do próprio Fastify (corpo inválido, tipo de conteúdo…) em pt-BR, sem texto técnico em inglês. */
const FASTIFY_MESSAGES: Record<string, string> = {
  FST_ERR_CTP_EMPTY_JSON_BODY: 'A requisição chegou sem dados.',
  FST_ERR_CTP_INVALID_JSON_BODY: 'Os dados enviados estão em formato inválido.',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'Tipo de conteúdo não aceito.',
  FST_ERR_CTP_BODY_TOO_LARGE: 'Os dados enviados são grandes demais.',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'Tamanho dos dados inválido.',
  FST_ERR_VALIDATION: 'Dados inválidos.',
  FST_ERR_NOT_FOUND: 'Rota não encontrada.',
};

export function frameworkMessage(code: string | undefined, statusCode: number): string {
  if (code && FASTIFY_MESSAGES[code]) return FASTIFY_MESSAGES[code];
  if (statusCode === 404) return 'Não encontrado.';
  if (statusCode === 413) return 'Os dados enviados são grandes demais.';
  if (statusCode === 415) return 'Tipo de conteúdo não aceito.';
  return 'Requisição inválida.';
}
