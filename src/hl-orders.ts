import { asset as shown } from './asset';
import { CLOID_FULL, CLOID_PARTIAL, MIN_NOTIONAL, ownCloid, tpSplit } from './hl-wires';
import type { HlOrder, HlOrderKind, HlOtherOrder, RawOrder } from './hl-types';

/**
 * Lecture des ordres ouverts publiés par Hyperliquid (traduction, part exécutée) et recalage des protections sur la
 * taille de la position : découpés de hyperliquid.ts (Q-01, 24/11/2026), qui les réexporte.
 */

export function parseOrders(raw: RawOrder[], coin: string = shown.coin): HlOrder[] {
  return raw.filter(o => o.coin === coin).map(orderOf);
}

/**
 * Ordres ouverts des autres actifs que celui affiché, lus de la même façon (panneau des positions). Ils ne servent
 * qu'à l'affichage : aucune action de trading ne part d'eux.
 */
export function parseOtherOrders(raw: RawOrder[], coin: string = shown.coin): HlOtherOrder[] {
  return raw.filter(o => o.coin !== coin).map(o => ({ ...orderOf(o), coin: o.coin }));
}

/** Un ordre ouvert d'Hyperliquid, traduit (sens, nature, libellé, rôle d'un TP). */
function orderOf(o: RawOrder): HlOrder {
  const buy = o.side === 'B';
  // Un ordre limite « réduisant seulement » ne peut que fermer : c'est un take profit limite.
  const kind: HlOrderKind = !o.isTrigger
    ? o.reduceOnly
      ? 'tp'
      : 'limit'
    : o.orderType.startsWith('Take Profit')
      ? 'tp'
      : o.reduceOnly || o.isPositionTpsl
        ? 'sl'
        : 'stop';
  const size = +o.sz;
  const cloid = o.cloid ?? undefined;
  const tpRole =
    kind === 'tp' && !o.isTrigger && cloid
      ? cloid.startsWith(`0x${CLOID_FULL}`)
        ? 'full'
        : cloid.startsWith(`0x${CLOID_PARTIAL}`)
          ? 'partial'
          : undefined
      : undefined;
  const label =
    kind === 'tp'
      ? o.isTrigger
        ? 'TP'
        : tpRole === 'partial'
          ? 'TP partiel'
          : 'TP limite'
      : kind === 'sl'
        ? 'SL'
        : kind === 'stop'
          ? buy
            ? 'Stop achat'
            : 'Stop vente'
          : buy
            ? 'Achat'
            : 'Vente';
  return {
    oid: o.oid,
    kind,
    buy,
    price: +(o.isTrigger ? o.triggerPx : o.limitPx),
    size,
    reduceOnly: o.reduceOnly,
    position: o.isPositionTpsl,
    trigger: o.isTrigger,
    label,
    ...(cloid ? { cloid } : {}),
    ...(tpRole ? { tpRole } : {}),
    ...(o.isTrigger ? { market: /market/i.test(o.orderType) } : {}),
    ...(+o.limitPx > 0 ? { limitPx: +o.limitPx } : {}),
    ...(o.tif !== undefined ? { tif: o.tif } : {}),
    ...(o.origSz !== undefined && +o.origSz > 0 ? { origSize: +o.origSz } : {}),
    ...(ownCloid(cloid) ? { ours: true } : {}),
    ...(o.children?.length ? { children: o.children.map(orderOf) } : {}),
  };
}

/**
 * Part déjà exécutée d'une entrée (23/11/2026) : `origSize − size`, 0 si l'ordre n'a pas commencé à s'exécuter ou si
 * sa taille d'origine n'est pas connue.
 */
export function filledPart(o: Pick<HlOrder, 'size' | 'origSize'>): number {
  return o.origSize !== undefined && o.origSize > o.size ? o.origSize - o.size : 0;
}

/**
 * Take profit et stop loss à recaler sur la taille de la position, quand elle a changé (renforcée par un long ou
 * un short exécuté, ou allégée) :
 *  - le TP limite complet reprend exactement ce que les TP partiels laissent de la position ;
 *  - un TP ou SL déclenché de taille fixe (posé avec une entrée limite) est agrandi à toute la position.
 * Les TP partiels gardent leur taille, et un TP / SL rattaché à la position la suit déjà chez Hyperliquid. Ne
 * propose rien sous le montant minimal d'un ordre (`minNotional`, en USDC).
 * Depuis le 23/11/2026, seuls les ordres posés par HyperChart (identifiant client à préfixe propre, `ours`) sont
 * recalés : jamais un ordre posé depuis l'interface d'Hyperliquid ou un autre outil.
 */
export function protectionResizes(
  orders: HlOrder[],
  position: number,
  szDecimals: number,
  minNotional = MIN_NOTIONAL,
): { order: HlOrder; size: number }[] {
  const pos = Math.abs(position);
  if (!(pos > 0)) return [];
  const k = 10 ** szDecimals;
  const step = 1 / k;
  const closingBuy = position < 0;
  const out: { order: HlOrder; size: number }[] = [];
  const { full, fullSize } = tpSplit(orders, pos, szDecimals);
  if (
    full?.ours &&
    full.buy === closingBuy &&
    fullSize > 0 &&
    Math.abs(full.size - fullSize) >= step / 2 &&
    fullSize * full.price >= minNotional
  )
    out.push({ order: full, size: fullSize });
  const posSize = Math.floor(pos * k + 1e-6) / k;
  for (const o of orders) {
    if (!o.ours || !o.trigger || o.position || !o.reduceOnly || o.buy !== closingBuy) continue;
    if (o.kind !== 'tp' && o.kind !== 'sl') continue;
    if (o.size < posSize - step / 2) out.push({ order: o, size: posSize });
  }
  return out;
}
