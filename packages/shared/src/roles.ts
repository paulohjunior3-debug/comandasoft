import { z } from 'zod';

export const ROLES = ['ADMIN', 'GERENTE', 'CAIXA', 'GARCOM'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Administrador',
  GERENTE: 'Gerente',
  CAIXA: 'Caixa',
  GARCOM: 'Garçom',
};
