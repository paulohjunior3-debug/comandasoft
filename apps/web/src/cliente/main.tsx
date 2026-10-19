import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClientApp } from './ClientApp';
import '../index.css';

// Página do QR da mesa (SPEC 5.6): leve, sem login, sem service worker. A URL é /m/<token da mesa>.
const qrToken = decodeURIComponent(window.location.pathname.split('/')[2] ?? '');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClientApp qrToken={qrToken} />
  </StrictMode>,
);
