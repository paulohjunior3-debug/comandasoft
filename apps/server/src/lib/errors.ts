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
