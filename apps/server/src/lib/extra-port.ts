import { createServer, type Server, type ServerOptions } from 'node:https';
import type { FastifyInstance } from 'fastify';

/**
 * Porta HTTPS extra com o mesmo sistema (ex.: 443, para o endereço próprio funcionar sem ":8443").
 * Mesmo certificado e mesmas rotas da porta principal. Porta ocupada (IIS, outro programa) não
 * derruba nada: avisa no log e o sistema segue só na porta principal.
 */
export function listenExtraHttps(app: FastifyInstance, options: ServerOptions, port: number, host: string): Promise<Server | null> {
  const server = createServer(options, (req, res) => app.routing(req, res));
  return new Promise((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      const why = err.code === 'EADDRINUSE' ? 'outro programa já usa essa porta' : err.code === 'EACCES' ? 'sem permissão para essa porta' : err.message;
      app.log.warn(`Porta ${port} não ficou disponível (${why}); o sistema segue só na porta principal.`);
      resolve(null);
    });
    server.listen(port, host, () => resolve(server));
  });
}
