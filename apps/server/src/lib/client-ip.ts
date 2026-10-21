import type { FastifyRequest } from 'fastify';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * O acesso veio pelo túnel da Cloudflare (QR do cliente pelo 4G)? O cloudflared roda neste PC e
 * entrega a conexão pelo localhost com o cabeçalho CF-Connecting-IP. Só confiamos no cabeçalho
 * quando a conexão é local: um aparelho da rede não consegue se passar por outro.
 */
export function viaTunnel(request: FastifyRequest): boolean {
  return LOOPBACK.has(request.socket.remoteAddress ?? '') && typeof request.headers['cf-connecting-ip'] === 'string';
}

/** IP do aparelho do cliente: o informado pelo túnel ou o da própria conexão (rede local). */
export function clientIp(request: FastifyRequest): string {
  if (viaTunnel(request)) return (request.headers['cf-connecting-ip'] as string).trim().slice(0, 64);
  return request.ip;
}
