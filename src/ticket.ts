/**
 * Calculs du ticket d'ordre Hyperliquid (fonctions pures, testées) : taille réglée en part du pouvoir d'achat,
 * taille calculée à partir du risque, risque au stop, gain au take profit, rapport gain / risque, et contrôle des
 * prix de TP et SL par rapport à l'entrée.
 */

/** Pouvoir d'achat : marge disponible × levier, en USDC de position. */
export function buyingPower(available: number | null, leverage: number): number {
  return Math.max(0, (available ?? 0) * Math.max(1, leverage));
}

/** Part du pouvoir d'achat (0 à 100) représentée par un montant de position. */
export function powerPct(usdc: number, power: number): number {
  return power > 0 ? Math.min(100, Math.max(0, (usdc / power) * 100)) : 0;
}

/** Montant de position pour une part (0 à 100) du pouvoir d'achat, arrondi au dollar inférieur. */
export function pctToUsdc(pct: number, power: number): number {
  return Math.floor((power * Math.min(100, Math.max(0, pct))) / 100);
}

export interface TicketPlan {
  /** Taille, dans l'unité de l'actif, tronquée au pas d'Hyperliquid. */
  size: number;
  notional: number;
  /** Perte si le stop est touché (positive), hors frais et glissement ; null sans stop. */
  risk: number | null;
  /** Gain si le take profit est atteint, hors frais ; null sans TP. */
  reward: number | null;
  /** Gain / risque ; null s'il manque l'un des deux. */
  rr: number | null;
  /** Risque en part de la valeur du compte (0 à 1). */
  riskShare: number | null;
  /** Raison pour laquelle l'ordre ne peut pas partir tel quel. */
  problem: string | null;
}

/**
 * Marge relative appliquée avant de tronquer une taille au pas du contrat. Sans elle, l'arrondi binaire fait tomber
 * une valeur exacte juste sous le pas (501 USDC à 100 000 → 500,99999999999994 pas → 0,005 BTC au lieu de 0,00501 ;
 * 0,0003 BTC → 0,00029). Un milliardième ne fait franchir un pas qu'à une saisie située à moins d'un milliardième de
 * ce pas, et le montant de l'ordre ne dépasse jamais la saisie de plus de cette marge.
 */
export const SIZE_NUDGE = 1e-9;

/**
 * Plan de l'ordre. La taille vient de `qty` (quantité de l'actif saisie telle quelle) si elle est donnée, sinon du
 * montant `usdc` converti au prix d'entrée ; elle est tronquée au pas du contrat dans les deux cas.
 */
export function planTicket(o: {
  buy: boolean;
  entry: number;
  usdc: number;
  qty?: number | null;
  tp?: number | null;
  sl?: number | null;
  accountValue?: number | null;
  szDecimals: number;
  minNotional: number;
}): TicketPlan {
  const k = 10 ** o.szDecimals;
  const qty = o.qty != null && o.qty > 0 && Number.isFinite(o.qty) ? o.qty : null;
  const raw = o.entry > 0 ? (qty ?? o.usdc / o.entry) : 0;
  const size = raw > 0 ? Math.floor(raw * k * (1 + SIZE_NUDGE)) / k : 0;
  const notional = size * o.entry;
  const way = o.buy ? 1 : -1;
  const risk = o.sl ? (o.entry - o.sl) * way * size : null;
  const reward = o.tp ? (o.tp - o.entry) * way * size : null;
  let problem: string | null = null;
  if (!(size > 0)) problem = 'Montant invalide.';
  else if (notional < o.minNotional) problem = `Hyperliquid refuse les ordres de moins de ${o.minNotional} USDC.`;
  else if (o.sl && (o.buy ? o.sl >= o.entry : o.sl <= o.entry))
    problem = `Le stop d’un ${o.buy ? 'long' : 'short'} doit être ${o.buy ? 'au-dessous' : 'au-dessus'} de l’entrée.`;
  else if (o.tp && (o.buy ? o.tp <= o.entry : o.tp >= o.entry))
    problem = `Le take profit d’un ${o.buy ? 'long' : 'short'} doit être ${o.buy ? 'au-dessus' : 'au-dessous'} de l’entrée.`;
  return {
    size,
    notional,
    risk,
    reward,
    rr: risk !== null && reward !== null && risk > 0 ? reward / risk : null,
    riskShare: risk !== null && o.accountValue ? risk / o.accountValue : null,
    problem,
  };
}

export interface MergedPosition {
  /** Taille signée de la position après l'ordre (positive : long). */
  size: number;
  /** Prix d'entrée moyen de cette position. */
  entry: number;
  /**
   * Vrai si la position obtenue est dans le sens de l'ordre (ouverture, renfort ou retournement). Faux si l'ordre
   * ne fait que réduire ou fermer la position ouverte : un TP ou un SL pensé pour le sens de l'ordre n'a alors
   * aucun sens sur ce qu'il en reste.
   */
  coherent: boolean;
}

/**
 * Position obtenue quand un ordre au marché de `size` au prix `price` s'ajoute à la position ouverte. Sur
 * Hyperliquid, le stop loss est rattaché à la position entière : le risque d'un stop posé avec un renfort se
 * mesure donc sur cette position-là, pas sur le seul ordre ajouté.
 */
export function positionAfter(before: { size: number; entry: number } | null, buy: boolean, size: number, price: number): MergedPosition {
  const had = before?.size ?? 0;
  const after = had + (buy ? size : -size);
  const coherent = Math.abs(after) > 1e-12 && after > 0 === buy;
  // Même sens (ou pas de position) : moyenne pondérée. Retournement : la nouvelle position naît au prix de l'ordre.
  // Réduction : le prix d'entrée de ce qui reste ne change pas.
  const sameWay = had === 0 || had > 0 === buy;
  const entry = sameWay
    ? (Math.abs(had) * (before?.entry ?? price) + size * price) / (Math.abs(had) + size)
    : coherent
      ? price
      : (before?.entry ?? price);
  return { size: after, entry, coherent };
}

/** Montant de position (USDC) qui fait perdre `riskPct` % du compte si le stop est touché. */
export function usdcForRisk(riskPct: number, accountValue: number, entry: number, stop: number): number {
  const gap = Math.abs(entry - stop);
  if (!(gap > 0) || !(riskPct > 0) || !(accountValue > 0)) return 0;
  return Math.floor(((accountValue * riskPct) / 100 / gap) * entry);
}
