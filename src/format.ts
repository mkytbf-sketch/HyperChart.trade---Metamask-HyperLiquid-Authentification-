import { asset } from './asset';
const cache = new Map<number, Intl.NumberFormat>();
const fixed = (digits: number) => {
  let f = cache.get(digits);
  if (!f) cache.set(digits, (f = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits })));
  return f;
};
const compactFmt = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });

const NBSP = ' ';

/** Prix, avec les décimales de l'actif affiché (une pour le BTC). */
export const price = (v: number) => fixed(asset.digits).format(v);
/** Plus petit écart de prix affiché. */
export const tick = () => 10 ** -asset.digits;
/**
 * Pas de prix « rond » des saisies (molette, arrondis) : 1 $ pour le BTC, un dixième de chiffre significatif près
 * pour les autres actifs (0,1 pour l'ETH, 0,00001 pour le DOGE).
 */
export const priceStep = () => 10 ** (1 - asset.digits);
/** Arrondi au pas de saisie. */
export const roundStep = (v: number) => {
  const k = 10 ** (asset.digits - 1);
  return Math.round(v * k) / k;
};
/** Arrondi au plus petit écart affiché. */
export const roundTick = (v: number) => {
  const k = 10 ** asset.digits;
  return Math.round(v * k) / k;
};
export const int = (v: number) => fixed(0).format(v);
export const num = (v: number, digits = 1) => fixed(digits).format(v);
export const compact = (v: number) => compactFmt.format(v);

export function signed(v: number, digits = 1): string {
  const scale = 10 ** digits;
  const r = Math.round(v * scale) / scale;
  return (r > 0 ? '+' : r < 0 ? '−' : '') + fixed(digits).format(Math.abs(r));
}

/** Ratio → pourcentage signé : 0.0123 → « +1,23 % ». */
export const pct = (ratio: number, digits = 2) => `${signed(ratio * 100, digits)}${NBSP}%`;
/** Ratio → part entière : 0.38 → « 38 % ». */
export const share = (ratio: number) => `${int(ratio * 100)}${NBSP}%`;

/**
 * Montant en USDC, la monnaie du compte Hyperliquid : centimes sous 100, dollar entier au-delà. Séparateur de
 * milliers de `toLocaleString` (espace fine insécable) et espace ordinaire avant « USDC », comme l'affichait la
 * carte de trading.
 */
export const usdc = (v: number) => `${v.toLocaleString('fr-FR', { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 })} USDC`;
/** Montant en USDC signé (« +12 USDC », « −3,5 USDC ») ; zéro compte comme positif. */
export const signedUsdc = (v: number) => `${v >= 0 ? '+' : '−'}${usdc(Math.abs(v))}`;
/** Quantité de l'actif affiché, aux décimales de taille d'Hyperliquid (« 0,01 BTC »). */
export const coinQty = (v: number) => `${v.toLocaleString('fr-FR', { maximumFractionDigits: asset.szDecimals })} ${asset.coin}`;
/** Adresse raccourcie : « 0x1234…abcd ». */
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Taux de financement « neutre », en % par 8 h : le taux d'intérêt de base des contrats perpétuels. */
export const NEUTRAL_FUNDING = 0.01;

export type FundingZone = 'up' | 'flat' | 'down';

/**
 * Zone d'un taux de financement (en % par 8 h), d'après ce qu'il signifie réellement :
 *  - au-dessus du taux neutre : les longs paient une prime, le positionnement est acheteur ;
 *  - entre 0 et le taux neutre : les longs paient encore, mais moins que le taux de base : zone neutre ;
 *  - négatif : ce sont les shorts qui paient, le positionnement est vendeur.
 * Un taux positif n'est donc jamais classé comme vendeur.
 */
export function fundingZone(percent: number): FundingZone {
  return percent > NEUTRAL_FUNDING ? 'up' : percent < 0 ? 'down' : 'flat';
}

const intraday = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const daily = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Horodatage d'une bougie : heure locale en intrajournalier, date UTC pour les bougies journalières. */
export const stamp = (t: number, isDaily: boolean) => (isDaily ? daily : intraday).format(t * 1000);
