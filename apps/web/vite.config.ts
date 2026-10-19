import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Certificado gerado por scripts/gerar-certificado.ps1 (mkcert). Sem ele, o Vite sobe em HTTP.
const certDir = fileURLToPath(new URL('../../certs/', import.meta.url));
const cert = `${certDir}dev-cert.pem`;
const key = `${certDir}dev-key.pem`;
const https = existsSync(cert) && existsSync(key) ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;

const apiPort = process.env.PORT ?? '3000';
const { version } = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Sistema Bar',
        short_name: 'Sistema Bar',
        description: 'Comandas, pedidos e caixa para bares e restaurantes',
        lang: 'pt-BR',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
      devOptions: { enabled: true, type: 'module' },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    https,
    proxy: {
      // xfwd: repassa o IP real do celular (X-Forwarded-For) para a auditoria da API.
      '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false, xfwd: true },
    },
  },
  preview: { host: true, port: 4173, https },
});
