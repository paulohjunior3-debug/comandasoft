import { CUF, HOMOLOGACAO_TEXTO, NFE_NS, tpAmbOf, type Ambiente } from './constants';
import { accessKey } from './key';

/**
 * Montagem do XML da NFC-e (infNFe), no mesmo formato que a SEFAZ-MG autorizava do Softcom.
 * Sem espaços nem quebras de linha e sem tags vazias: o texto já sai na forma canônica (C14N),
 * que é o que a assinatura digital usa.
 */

export interface NfceEmitter {
  cnpj: string;
  ie: string;
  legalName: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  cityCode: string;
  city: string;
  uf: string;
  zip: string;
  phone: string;
  /** 1 = Simples Nacional. */
  crt: 1 | 2 | 3;
}

export interface NfceItem {
  code: string;
  name: string;
  ncm: string;
  cest: string | null;
  cfop: string;
  unit: string;
  /** Quantidade (até 4 casas). */
  qty: number;
  /** Valor total do item em centavos (antes do desconto). */
  totalCents: number;
  /** Desconto rateado para este item. */
  discountCents: number;
  csosn: string;
  origin: string;
  pisCofinsCst: string;
}

/** tPag: 01 dinheiro, 03 crédito, 04 débito, 17 PIX dinâmico, 20 PIX estático, 99 outros. */
export interface NfcePayment {
  tPag: string;
  amountCents: number;
}

export interface NfceInput {
  env: Ambiente;
  series: number;
  number: number;
  cNF: string;
  issuedAt: Date;
  emitter: NfceEmitter;
  items: NfceItem[];
  payments: NfcePayment[];
  /** Troco em dinheiro (quando a soma dos pagamentos passa do total). */
  changeCents?: number;
  /** CPF do consumidor (opcional). */
  cpf?: string | null;
  info?: string;
  respTec: { cnpj: string; contact: string; email: string; phone: string } | null;
  appVersion: string;
}

export interface BuiltNfce {
  accessKey: string;
  /** <infNFe ...>...</infNFe> com o namespace (forma canônica, pronto para assinar). */
  infNFe: string;
  totalCents: number;
  discountCents: number;
}

/** Texto para o XML: só caracteres válidos, sem espaços sobrando, &, < e > escapados. */
export function xmlText(value: string, max?: number): string {
  let v = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (max) v = v.slice(0, max).trim();
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const money = (cents: number) => (cents / 100).toFixed(2);
const tag = (name: string, value: string | number) => `<${name}>${value}</${name}>`;
const opt = (name: string, value: string | null | undefined) => (value ? tag(name, value) : '');

/** Data e hora com o fuso de Brasília, como a SEFAZ espera (2026-10-21T21:16:54-03:00). */
export function dhBrasilia(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  const offsetMin = Math.round((local - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
  const sign = offsetMin <= 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}

/** Rateio de um valor em centavos proporcional aos pesos, sem perder centavo (maior resto). */
export function proportional(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || totalCents === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalCents * w) / sum);
  const out = raw.map(Math.floor);
  let rest = totalCents - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    out[i]! += 1;
    rest -= 1;
  }
  return out;
}

function icms(item: NfceItem): string {
  const o = item.origin || '0';
  switch (item.csosn) {
    case '500':
      return `<ICMS><ICMSSN500>${tag('orig', o)}${tag('CSOSN', '500')}</ICMSSN500></ICMS>`;
    case '102':
    case '103':
    case '300':
    case '400':
      return `<ICMS><ICMSSN102>${tag('orig', o)}${tag('CSOSN', item.csosn)}</ICMSSN102></ICMS>`;
    case '900':
      return `<ICMS><ICMSSN900>${tag('orig', o)}${tag('CSOSN', '900')}</ICMSSN900></ICMS>`;
    default:
      throw new Error(`CSOSN ${item.csosn || '(vazio)'} não suportado no produto "${item.name}". Use 102, 103, 300, 400, 500 ou 900.`);
  }
}

function pisCofins(cst: string): string {
  if (['04', '05', '06', '07', '08', '09'].includes(cst)) {
    return `<PIS><PISNT>${tag('CST', cst)}</PISNT></PIS><COFINS><COFINSNT>${tag('CST', cst)}</COFINSNT></COFINS>`;
  }
  if (/^(49|5\d|6\d|7[0-5]|98|99)$/.test(cst)) {
    return (
      `<PIS><PISOutr>${tag('CST', cst)}<vBC>0.00</vBC><pPIS>0.0000</pPIS><vPIS>0.00</vPIS></PISOutr></PIS>` +
      `<COFINS><COFINSOutr>${tag('CST', cst)}<vBC>0.00</vBC><pCOFINS>0.0000</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS>`
    );
  }
  throw new Error(`CST de PIS/COFINS ${cst} não suportado.`);
}

/** Monta a NFC-e (sem assinatura e sem o infNFeSupl). */
export function buildNfce(input: NfceInput): BuiltNfce {
  const e = input.emitter;
  const cUF = CUF[e.uf];
  if (!cUF) throw new Error(`UF ${e.uf} ainda não suportada na NFC-e.`);
  if (!input.items.length) throw new Error('A nota precisa de ao menos um item.');
  const tpAmb = tpAmbOf(input.env);
  const dhEmi = dhBrasilia(input.issuedAt);
  const yearMonth = dhEmi.slice(2, 4) + dhEmi.slice(5, 7);
  const { key, dv } = accessKey({ cUF, yearMonth, cnpj: e.cnpj, series: input.series, number: input.number, tpEmis: 1, cNF: input.cNF });

  const ide =
    '<ide>' +
    tag('cUF', cUF) +
    tag('cNF', input.cNF) +
    tag('natOp', 'VENDA DE MERCADORIA') +
    tag('mod', 65) +
    tag('serie', input.series) +
    tag('nNF', input.number) +
    tag('dhEmi', dhEmi) +
    tag('tpNF', 1) +
    tag('idDest', 1) +
    tag('cMunFG', e.cityCode) +
    tag('tpImp', 4) +
    tag('tpEmis', 1) +
    tag('cDV', dv) +
    tag('tpAmb', tpAmb) +
    tag('finNFe', 1) +
    tag('indFinal', 1) +
    tag('indPres', 1) +
    tag('indIntermed', 0) +
    tag('procEmi', 0) +
    tag('verProc', xmlText(input.appVersion, 20)) +
    '</ide>';

  const emit =
    '<emit>' +
    tag('CNPJ', e.cnpj) +
    tag('xNome', xmlText(e.legalName, 60)) +
    '<enderEmit>' +
    tag('xLgr', xmlText(e.street, 60)) +
    tag('nro', xmlText(e.number || 'SN', 60)) +
    opt('xCpl', e.complement ? xmlText(e.complement, 60) : null) +
    tag('xBairro', xmlText(e.district, 60)) +
    tag('cMun', e.cityCode) +
    tag('xMun', xmlText(e.city, 60)) +
    tag('UF', e.uf) +
    tag('CEP', e.zip) +
    opt('fone', e.phone.replace(/\D/g, '') || null) +
    '</enderEmit>' +
    tag('IE', e.ie) +
    tag('CRT', e.crt) +
    '</emit>';

  const dest = input.cpf
    ? '<dest>' + tag('CPF', input.cpf) + (tpAmb === 2 ? tag('xNome', HOMOLOGACAO_TEXTO) : '') + tag('indIEDest', 9) + '</dest>'
    : '';

  let vProd = 0;
  let vDesc = 0;
  const det = input.items
    .map((item, i) => {
      vProd += item.totalCents;
      vDesc += item.discountCents;
      const qty = item.qty.toFixed(4);
      const unit = (item.totalCents / 100 / item.qty).toFixed(10);
      const name = i === 0 && tpAmb === 2 ? HOMOLOGACAO_TEXTO : xmlText(item.name, 120);
      const uCom = xmlText(item.unit || 'UN', 6);
      return (
        `<det nItem="${i + 1}"><prod>` +
        tag('cProd', xmlText(item.code, 60)) +
        tag('cEAN', 'SEM GTIN') +
        tag('xProd', name) +
        tag('NCM', item.ncm) +
        opt('CEST', item.cest) +
        tag('CFOP', item.cfop) +
        tag('uCom', uCom) +
        tag('qCom', qty) +
        tag('vUnCom', unit) +
        tag('vProd', money(item.totalCents)) +
        tag('cEANTrib', 'SEM GTIN') +
        tag('uTrib', uCom) +
        tag('qTrib', qty) +
        tag('vUnTrib', unit) +
        (item.discountCents > 0 ? tag('vDesc', money(item.discountCents)) : '') +
        tag('indTot', 1) +
        '</prod><imposto>' +
        tag('vTotTrib', '0.00') +
        icms(item) +
        pisCofins(item.pisCofinsCst) +
        '</imposto>' +
        tag('vItem', money(item.totalCents - item.discountCents)) +
        '</det>'
      );
    })
    .join('');

  const vNF = vProd - vDesc;
  const total =
    '<total><ICMSTot>' +
    '<vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCPUFDest>0.00</vFCPUFDest><vICMSUFDest>0.00</vICMSUFDest>' +
    '<vICMSUFRemet>0.00</vICMSUFRemet><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet>' +
    '<qBCMonoRet>0.00</qBCMonoRet><vICMSMonoRet>0.00</vICMSMonoRet>' +
    tag('vProd', money(vProd)) +
    '<vFrete>0.00</vFrete><vSeg>0.00</vSeg>' +
    tag('vDesc', money(vDesc)) +
    '<vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro>' +
    tag('vNF', money(vNF)) +
    tag('vTotTrib', '0.00') +
    '</ICMSTot></total>';

  const paid = input.payments.reduce((s, p) => s + p.amountCents, 0);
  if (paid < vNF) throw new Error(`Pagamentos (${money(paid)}) menores que o total da nota (${money(vNF)}).`);
  const pag =
    '<pag>' +
    input.payments
      .map(
        (p) =>
          '<detPag>' +
          tag('indPag', 0) +
          tag('tPag', p.tPag) +
          tag('vPag', money(p.amountCents)) +
          (p.tPag === '03' || p.tPag === '04' ? '<card><tpIntegra>2</tpIntegra></card>' : '') +
          '</detPag>',
      )
      .join('') +
    (input.changeCents ? tag('vTroco', money(input.changeCents)) : '') +
    '</pag>';

  const infAdic = input.info ? `<infAdic>${tag('infCpl', xmlText(input.info, 2000))}</infAdic>` : '';
  const resp = input.respTec
    ? '<infRespTec>' +
      tag('CNPJ', input.respTec.cnpj) +
      tag('xContato', xmlText(input.respTec.contact, 60)) +
      tag('email', xmlText(input.respTec.email, 60)) +
      tag('fone', input.respTec.phone.replace(/\D/g, '')) +
      '</infRespTec>'
    : '';

  const infNFe =
    `<infNFe xmlns="${NFE_NS}" Id="NFe${key}" versao="4.00">` +
    ide +
    emit +
    dest +
    det +
    total +
    '<transp><modFrete>9</modFrete></transp>' +
    pag +
    infAdic +
    resp +
    '</infNFe>';
  return { accessKey: key, infNFe, totalCents: vNF, discountCents: vDesc };
}
