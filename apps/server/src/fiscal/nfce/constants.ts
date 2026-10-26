/**
 * NFC-e (modelo 65) direto com a SEFAZ-MG, layout 4.00. Endereços oficiais dos webservices e
 * da consulta pelo QR Code, por ambiente (levantados no Softcom, que emitia assim em produção).
 */
export type Ambiente = 'PRODUCAO' | 'HOMOLOGACAO';

export const tpAmbOf = (env: Ambiente) => (env === 'PRODUCAO' ? 1 : 2);

const HOST: Record<Ambiente, string> = {
  PRODUCAO: 'https://nfce.fazenda.mg.gov.br/nfce/services',
  HOMOLOGACAO: 'https://hnfce.fazenda.mg.gov.br/nfce/services',
};

export const SERVICES = {
  status: { path: 'NFeStatusServico4', wsdl: 'NFeStatusServico4', action: 'nfeStatusServicoNF' },
  autorizacao: { path: 'NFeAutorizacao4', wsdl: 'NFeAutorizacao4', action: 'nfeAutorizacaoLote' },
  consulta: { path: 'NFeConsultaProtocolo4', wsdl: 'NFeConsultaProtocolo4', action: 'nfeConsultaNF' },
  evento: { path: 'NFeRecepcaoEvento4', wsdl: 'NFeRecepcaoEvento4', action: 'nfeRecepcaoEvento' },
  inutilizacao: { path: 'NFeInutilizacao4', wsdl: 'NFeInutilizacao4', action: 'nfeInutilizacaoNF' },
} as const;
export type Service = keyof typeof SERVICES;

export const serviceUrl = (env: Ambiente, service: Service) => `${HOST[env]}/${SERVICES[service].path}`;

/** Consulta pública (vai no QR Code e no cupom). */
export const QR_URL: Record<Ambiente, string> = {
  PRODUCAO: 'https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml',
  HOMOLOGACAO: 'https://hportalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml',
};
export const CHAVE_URL: Record<Ambiente, string> = {
  PRODUCAO: 'https://portalsped.fazenda.mg.gov.br/portalnfce',
  HOMOLOGACAO: 'https://hportalsped.fazenda.mg.gov.br/portalnfce',
};

/** Código IBGE das UFs (só MG por enquanto). */
export const CUF: Record<string, string> = { MG: '31' };

export const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

/** Na homologação o 1º item e o destinatário levam este texto (exigência da SEFAZ). */
export const HOMOLOGACAO_TEXTO = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
