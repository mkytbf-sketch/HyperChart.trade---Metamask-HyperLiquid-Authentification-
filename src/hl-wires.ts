import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';
import type { AssetBase, HlOrder, HlPosition, HlState } from './hl-types';

/**
 * Construction des ordres envoyés à Hyperliquid (fils d'ordre, arrondis, identifiants clients) et contrôles purs des
 * TP / SL : découpés de hyperliquid.ts (Q-01, 24/11/2026), qui les réexporte.
 */

/** Écart toléré par un ordre au marché par rapport au milieu du carnet. */
export const MARKET_SLIPPAGE = 0.01;
/** Écart toléré à l'exécution d'un stop ou d'un take profit déclenché (ordre au marché). */
export const TRIGGER_SLIPPAGE = 0.1;
/** Valeur minimale d'un ordre sur Hyperliquid, en dollars. */
export const MIN_NOTIONAL = 10;

/** Identifiant client d'un ordre d'entrée : préfixe propre, le reste au hasard (une intention = un identifiant). */
export function entryCloid(): `0x${string}` {
  return cloidWith(CLOID_ENTRY);
}

/**
 * Identifiant client d'un stop loss (autonome ou rattaché à une entrée) ou d'un TP déclenché rattaché à une entrée
 * limite (23/11/2026) : tous les ordres posés par HyperChart en portent un, pour être rapprochés après une réponse
 * perdue et reconnus comme les siens par le recalage automatique.
 */
export function protectCloid(tpsl: 'tp' | 'sl'): `0x${string}` {
  return cloidWith(tpsl === 'sl' ? CLOID_SL : CLOID_TP_TRIGGER);
}

function cloidWith(prefix: string): `0x${string}` {
  const rnd = [...crypto.getRandomValues(new Uint8Array(14))].map(b => b.toString(16).padStart(2, '0')).join('');
  return `0x${prefix}${rnd}`;
}

/** Ordre posé par HyperChart (préfixe d'identifiant client propre) : seul ordre que le recalage automatique touche. */
export function ownCloid(cloid: string | null | undefined): boolean {
  return !!cloid && OWN_PREFIXES.some(p => cloid.toLowerCase().startsWith(`0x${p}`));
}

// ───────────── Construction des ordres (fonctions pures, testées) ─────────────

export type OrderWire = {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: 'Gtc' | 'Ioc' | 'Alo' } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: 'tp' | 'sl' } };
  /** Identifiant client (0x + 32 hexadécimaux). */
  c?: `0x${string}`;
};

/**
 * Identifiants clients des take profit limite posés par HyperDashboard : les 4 premiers chiffres disent leur rôle, le reste
 * est tiré au hasard. Ils permettent de reconnaître le TP complet parmi les TP partiels après un rechargement.
 */
export const CLOID_FULL = 'f011';
export const CLOID_PARTIAL = '9a57';
const CLOID_ENTRY = 'e17e';
/** Stop loss posé par HyperChart (23/11/2026). */
const CLOID_SL = '5105';
/** Take profit déclenché rattaché à une entrée limite, posé par HyperChart (23/11/2026). */
const CLOID_TP_TRIGGER = '7e1d';
const OWN_PREFIXES = [CLOID_FULL, CLOID_PARTIAL, CLOID_ENTRY, CLOID_SL, CLOID_TP_TRIGGER];
export function tpCloid(role: 'full' | 'partial'): `0x${string}` {
  return cloidWith(role === 'full' ? CLOID_FULL : CLOID_PARTIAL);
}

/**
 * Répartition des take profit limite d'une position : le TP complet (marqué comme tel, ou à défaut un TP non
 * marqué qui couvre au moins le reste), les TP partiels (tous les autres), la taille qu'ils couvrent, et la taille
 * que doit avoir le TP complet pour fermer exactement le reste de la position.
 */
export function tpSplit(
  orders: HlOrder[],
  position: number,
  szDecimals: number,
): { full: HlOrder | undefined; partials: HlOrder[]; partialSize: number; fullSize: number } {
  const limits = orders.filter(o => o.kind === 'tp' && !o.trigger);
  const k = 10 ** szDecimals;
  const pos = Math.abs(position);
  const tagged = limits.filter(o => o.tpRole === 'partial').reduce((a, o) => a + o.size, 0);
  let full = limits.find(o => o.tpRole === 'full');
  if (!full) {
    // Ancien TP sans marque : le plus gros, s'il couvre (à peu près) tout ce que les partiels laissent.
    const legacy = limits.filter(o => !o.tpRole).sort((a, b) => b.size - a.size)[0];
    if (legacy && legacy.size >= (pos - tagged) * 0.999 - 1 / k) full = legacy;
  }
  const partials = limits.filter(o => o !== full);
  const partialSize = partials.reduce((a, o) => a + o.size, 0);
  return { full, partials, partialSize, fullSize: Math.max(0, Math.floor((pos - partialSize) * k + 1e-6) / k) };
}

/** Prix limite d'un ordre au marché : le milieu décalé de la tolérance, du côté défavorable. */
function slippagePrice(mid: number, buy: boolean, slippage: number, szDecimals: number): string {
  return formatPrice(mid * (buy ? 1 + slippage : 1 - slippage), szDecimals);
}

export function marketWire(asset: AssetBase, buy: boolean, size: number, mid: number, reduceOnly = false): OrderWire {
  return {
    a: asset.index,
    b: buy,
    p: slippagePrice(mid, buy, MARKET_SLIPPAGE, asset.szDecimals),
    s: formatSize(size, asset.szDecimals),
    r: reduceOnly,
    t: { limit: { tif: 'Ioc' } },
  };
}

export function limitWire(asset: AssetBase, buy: boolean, size: number, price: number, reduceOnly = false): OrderWire {
  return {
    a: asset.index,
    b: buy,
    p: formatPrice(price, asset.szDecimals),
    s: formatSize(size, asset.szDecimals),
    r: reduceOnly,
    t: { limit: { tif: 'Gtc' } },
  };
}

/**
 * Take profit d'une position en ordre limite : ordre de sens opposé, réduisant seulement, posé dans le carnet au
 * prix visé (Gtc). Exécuté à ce prix ou mieux, jamais au marché : pas de glissement, frais de teneur de marché
 * s'il attend dans le carnet. Sa taille est fixe : elle ne suit pas un renforcement de la position.
 */
export function tpLimitWire(asset: AssetBase, long: boolean, size: number, price: number): OrderWire {
  return limitWire(asset, !long, size, price, true);
}

/**
 * Take profit rattaché à un ordre d'entrée limite (groupe « normalTpsl ») : Hyperliquid n'accepte, avant que la
 * position existe, que des ordres conditionnels. Celui-ci est un conditionnel limite (isMarket faux) : déclenché au
 * prix visé, il pose un ordre limite réduisant seulement à ce même prix, sans glissement.
 */
function tpTriggerLimitWire(asset: AssetBase, long: boolean, size: number, price: number): OrderWire {
  return {
    a: asset.index,
    b: !long,
    p: formatPrice(price, asset.szDecimals),
    s: formatSize(size, asset.szDecimals),
    r: true,
    t: { trigger: { isMarket: false, triggerPx: formatPrice(price, asset.szDecimals), tpsl: 'tp' } },
  };
}

/**
 * Ordre d'entrée limite avec son take profit et son stop loss rattachés (groupe « normalTpsl ») : les deux ne
 * s'activent qu'une fois l'entrée exécutée, pour la taille de l'entrée.
 */
export function bracketWires(
  asset: AssetBase,
  buy: boolean,
  size: number,
  price: number,
  tp?: number | null,
  sl?: number | null,
): OrderWire[] {
  const out = [limitWire(asset, buy, size, price)];
  if (tp) out.push(tpTriggerLimitWire(asset, buy, size, tp));
  if (sl) out.push(triggerWire(asset, buy, size, sl, 'sl'));
  return out;
}

/**
 * Stop loss (et ancien take profit déclenché) d'une position : ordre de sens opposé, réduisant seulement, exécuté au marché quand
 * le prix de déclenchement est touché (avec une tolérance large pour être sûr d'être exécuté).
 */
export function triggerWire(asset: AssetBase, long: boolean, size: number, trigger: number, tpsl: 'tp' | 'sl'): OrderWire {
  const buy = !long;
  return {
    a: asset.index,
    b: buy,
    p: slippagePrice(trigger, buy, TRIGGER_SLIPPAGE, asset.szDecimals),
    s: formatSize(size, asset.szDecimals),
    r: true,
    t: { trigger: { isMarket: true, triggerPx: formatPrice(trigger, asset.szDecimals), tpsl } },
  };
}

/**
 * Ordre ouvert re-décrit à un autre prix et / ou une autre taille, en conservant tout le reste (23/11/2026, déplacement
 * d'une ligne et recalage) : sens, réduisant seulement, nature (limite, déclenché au marché, déclenché limite), durée
 * de validité (Gtc, Alo) et identifiant client. Un déclenché limite garde l'écart entre son prix limite et son prix
 * de déclenchement. Lève une erreur, et rien n'est envoyé, si une propriété ne peut pas être conservée.
 */
export function rewire(asset: AssetBase, o: HlOrder, price: number, size: number): OrderWire {
  const c = o.cloid ? { c: o.cloid as `0x${string}` } : {};
  const base = { a: asset.index, b: o.buy, s: formatSize(size, asset.szDecimals), r: o.reduceOnly };
  if (!o.trigger) {
    // Champ absent (ancienne lecture) : Gtc, la seule durée que HyperChart pose sur un ordre qui attend au carnet.
    const tif = o.tif === undefined ? 'Gtc' : o.tif;
    if (tif !== 'Gtc' && tif !== 'Alo')
      throw new Error(
        `Durée de validité « ${tif ?? 'inconnue'} » de cet ordre non conservable : rien n’a été déplacé. Annule-le et repose-le.`,
      );
    return { ...base, p: formatPrice(price, asset.szDecimals), t: { limit: { tif } }, ...c };
  }
  const tpsl = o.kind === 'tp' ? 'tp' : 'sl';
  if (o.market === undefined) throw new Error('Type d’exécution de cet ordre conditionnel inconnu : rien n’a été déplacé.');
  let p: string;
  if (o.market) p = slippagePrice(price, o.buy, TRIGGER_SLIPPAGE, asset.szDecimals);
  else {
    if (!(o.limitPx && o.limitPx > 0)) throw new Error('Prix limite de cet ordre conditionnel inconnu : rien n’a été déplacé.');
    const limit = o.limitPx + (price - o.price);
    if (!(limit > 0)) throw new Error('Le prix limite décalé de cet ordre deviendrait négatif : rien n’a été déplacé.');
    p = formatPrice(limit, asset.szDecimals);
  }
  return { ...base, p, t: { trigger: { isMarket: o.market, triggerPx: formatPrice(price, asset.szDecimals), tpsl } }, ...c };
}

/** Un TP doit être du côté du gain, un SL du côté de la perte ; null si le prix est acceptable, sinon la raison. */
export function checkTrigger(long: boolean, tpsl: 'tp' | 'sl', trigger: number, mark: number): string | null {
  const above = trigger > mark;
  if (tpsl === 'tp' && above !== long)
    return long ? 'Un take profit de long doit être au-dessus du prix.' : 'Un take profit de short doit être au-dessous du prix.';
  if (tpsl === 'sl' && above === long)
    return long ? 'Un stop loss de long doit être au-dessous du prix.' : 'Un stop loss de short doit être au-dessus du prix.';
  return null;
}

/**
 * Prix de référence d'un TP / SL (23/11/2026) : Hyperliquid les déclenche sur le mark price. Le milieu du carnet ne
 * sert qu'en repli, quand le mark price n'est pas (encore) connu.
 */
export function triggerRef(s: Pick<HlState, 'mark' | 'mid'>): number | null {
  return s.mark ?? s.mid;
}

/**
 * Résultat d'un take profit ou d'un stop loss exécuté au prix `at`, hors frais : (prix − entrée) × taille signée,
 * sur la part qu'il ferme (toute la position pour un TP / SL de position). null pour un autre ordre.
 */
export function exitPnl(
  position: Pick<HlPosition, 'size' | 'entry'> | null,
  order: Pick<HlOrder, 'kind' | 'position' | 'size'>,
  at: number,
): number | null {
  if (!position || (order.kind !== 'tp' && order.kind !== 'sl')) return null;
  const size = order.position ? Math.abs(position.size) : Math.min(order.size, Math.abs(position.size));
  return (at - position.entry) * Math.sign(position.size) * size;
}
