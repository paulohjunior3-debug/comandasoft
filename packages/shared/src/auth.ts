import { z } from 'zod';
import { roleSchema } from './roles';

export const loginRequestSchema = z.object({
  login: z.string().trim().min(1, 'Informe o usuário').max(64),
  password: z.string().min(1, 'Informe a senha').max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  login: z.string(),
  role: roleSchema,
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const authResponseSchema = z.object({
  accessToken: z.string(),
  user: authUserSchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
