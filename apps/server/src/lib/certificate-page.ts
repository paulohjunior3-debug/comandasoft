import { existsSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

/**
 * Página para instalar, nos celulares da equipe, o certificado de confiança do sistema (a CA
 * do mkcert, só a parte pública). Sem ele o Chrome do Android trata o sistema como "não
 * seguro" e só cria atalho, em vez de instalar como app. Servida no servidor do QR (HTTP),
 * que abre sem aviso de certificado.
 */
export async function certificatePageRoutes(app: FastifyInstance, { caCertPath, mainPort }: { caCertPath: string; mainPort: number | null }) {
  app.get('/certificado/sistema-bar.crt', { logLevel: 'warn' }, (_request, reply) => {
    if (!existsSync(caCertPath)) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Certificado não encontrado neste computador.' });
    return reply
      .header('content-type', 'application/x-x509-ca-cert')
      .header('content-disposition', 'attachment; filename="sistema-bar.crt"')
      .send(readFileSync(caCertPath));
  });

  app.get('/certificado', { logLevel: 'warn' }, (request, reply) => {
    const host = request.hostname.replace(/:\d+$/, '');
    const appUrl = mainPort ? `https://${host}:${mainPort}` : null;
    const has = existsSync(caCertPath);
    return reply.header('content-type', 'text/html; charset=utf-8').send(page(appUrl, has));
  });
}

function page(appUrl: string | null, has: boolean): string {
  const open = appUrl ? `<a class="btn sec" href="${appUrl}">Abrir o sistema</a><p class="hint">${appUrl}</p>` : '';
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Instalar o Sistema Bar no celular</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; background: #020617; color: #e2e8f0; line-height: 1.5; }
  main { max-width: 34rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 1.75rem 0 .5rem; color: #fbbf24; }
  p { margin: .4rem 0; color: #cbd5e1; }
  ol { padding-left: 1.25rem; margin: .4rem 0; } li { margin: .35rem 0; }
  b { color: #f8fafc; }
  .btn { display: block; text-align: center; margin: 1rem 0 .25rem; padding: .9rem; border-radius: .75rem; background: #f59e0b; color: #020617; font-weight: 700; text-decoration: none; }
  .btn.sec { background: #1e293b; color: #f8fafc; border: 1px solid #334155; }
  .hint { font-size: .8rem; color: #64748b; text-align: center; }
  .box { background: #0f172a; border-radius: .75rem; padding: .75rem 1rem; margin-top: .75rem; }
  .warn { background: #451a03; color: #fde68a; }
</style></head>
<body><main>
  <h1>Sistema Bar no celular</h1>
  <p>Para o celular confiar no sistema e instalar como app, instale o certificado do estabelecimento <b>uma vez</b> neste aparelho.</p>
  ${has ? '<a class="btn" href="/certificado/sistema-bar.crt">1. Baixar o certificado</a>' : '<p class="box warn">O certificado não foi encontrado neste computador. Peça ao responsável para rodar o gerar-certificado.ps1.</p>'}

  <h2>Android</h2>
  <ol>
    <li>Toque em <b>Baixar o certificado</b> acima.</li>
    <li>Abra <b>Configurações → Segurança</b> (ou "Segurança e privacidade") → <b>Mais configurações de segurança</b> → <b>Criptografia e credenciais</b> → <b>Instalar um certificado</b> → <b>Certificado de CA</b>.</li>
    <li>Toque em <b>Instalar mesmo assim</b>, confirme com a senha/digital do celular e escolha o arquivo <b>sistema-bar.crt</b> em Downloads.</li>
    <li>Abra o sistema no <b>Chrome</b> (botão abaixo), entre com seu usuário e toque em <b>⋮ → Instalar app</b>.</li>
  </ol>
  <p class="hint">O nome dos menus muda um pouco de marca para marca (Samsung, Motorola, Xiaomi…). Se não achar, procure "certificado" na busca das Configurações.</p>

  <h2>iPhone</h2>
  <ol>
    <li>Abra esta página no <b>Safari</b> e toque em <b>Baixar o certificado</b> → <b>Permitir</b>.</li>
    <li>Ajustes → <b>Perfil Transferido</b> → <b>Instalar</b>.</li>
    <li>Ajustes → Geral → Sobre → <b>Ajustes de Confiança de Certificado</b> → ative o certificado <b>mkcert</b>.</li>
    <li>Abra o sistema no Safari → <b>Compartilhar → Adicionar à Tela de Início</b>.</li>
  </ol>

  ${open}
  <p class="box">Depois de instalado, o app abre em tela cheia, como um aplicativo. Se o endereço do computador mudar, não precisa instalar o certificado de novo: só abrir o endereço novo e instalar o app outra vez.</p>
</main></body></html>`;
}
