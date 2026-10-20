import { networkInterfaces } from 'node:os';

/**
 * IPv4 da rede local deste PC: o endereço que os celulares usam para chegar ao sistema. O cabo
 * vem antes da Wi-Fi, que costuma mudar quando o notebook troca de rede.
 */
export function lanAddresses(): string[] {
  const wireless = /wi-?fi|wlan|wireless|sem fio/i;
  return Object.entries(networkInterfaces())
    .flatMap(([name, list]) => (list ?? []).map((n) => ({ ...n, wifi: wireless.test(name) })))
    .filter((n) => n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
    .sort((a, b) => Number(a.wifi) - Number(b.wifi))
    .map((n) => n.address);
}
