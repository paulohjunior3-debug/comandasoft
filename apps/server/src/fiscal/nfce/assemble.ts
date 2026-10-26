import { NFE_NS, type Ambiente } from './constants';
import type { BuiltNfce } from './build';
import { infNFeSupl, qrCodeOnline } from './qrcode';
import { signInfNFe, type OpenedCertificate } from './sign';

/** NFC-e pronta para enviar: <NFe> com infNFe, infNFeSupl (QR Code) e a assinatura. */
export function assembleNfe(built: BuiltNfce, env: Ambiente, cert: OpenedCertificate, csc: { id: string; token: string }) {
  const id = `NFe${built.accessKey}`;
  const signature = signInfNFe(built.infNFe, id, cert);
  const qrCode = qrCodeOnline(env, built.accessKey, csc.id, csc.token);
  // No documento o infNFe herda o namespace do <NFe> (a forma canônica, usada na assinatura, é a mesma).
  const infNFe = built.infNFe.replace(`<infNFe xmlns="${NFE_NS}" `, '<infNFe ');
  const nfe = `<NFe xmlns="${NFE_NS}">${infNFe}${infNFeSupl(env, qrCode)}${signature}</NFe>`;
  return { nfe, qrCode };
}

/** XML de distribuição (nota + protocolo), o que se guarda e manda para a contabilidade. */
export function nfeProc(nfe: string, protNFe: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00" xmlns="${NFE_NS}">${nfe}${protNFe}</nfeProc>`;
}
