import { z } from 'zod';

export const idParams = z.object({ id: z.string().uuid('Identificador inválido') });
