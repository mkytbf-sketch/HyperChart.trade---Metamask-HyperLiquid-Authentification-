import {
  checkTrigger,
  exitPnl,
  filledPart,
  MARKET_SLIPPAGE,
  MIN_NOTIONAL,
  type HlOrder,
  type HlPosition,
  type HlState,
} from './hyperliquid';
import { buyingPower, planTicket, positionAfter, SIZE_NUDGE, usdcForRisk, type MergedPosition, type TicketPlan } from './ticket';
import { feeText } from './partner';
import * as f from './format';
import { coinQty as btc, shortAddr, signedUsdc as signedUsd, usdc as usd } from './format';

/**
 * Calculs du ticket de trading Hyperliquid, sortis de la fermeture `setupTrading` de `trade-ui.ts` pour être testés
 * sans navigateur (audit du 20/11/2026, Q-02) : lecture de la saisie, conversion d'unité, maximum disponible, taille
 * au risque, bornage du levier, contenu des fenêtres de confirmation (entrée, fermeture, TP / SL, TP partiel,
 * déplacement et annulation d'un ordre). Chaque confirmation nomme l'actif visé, dans son titre et sur sa première
 * ligne « Actif » (audit sécurité du 22/11/2026, SEC-24) : le changement d'actif est rapide, la fenêtre ne doit
 * laisser aucun doute sur le marché touché.
 * Aucune fonction ici ne touche au DOM ni au réseau : `trade-ui.ts` lit l'état, appelle ces fonctions, affiche et
 * envoie. Les tailles sont tronquées aux décimales du contrat (`szDecimals`, celles de l'ordre) ; l'affichage
 * reprend l'actif de la page, le seul sur lequel `Hyperliquid.ready()` laisse partir un ordre.
 */

export interface Ticket {
  /**
   * Montant de l'ordre en USDC (valeur de la position ouverte, avant levier). En unité de l'actif, ce n'est qu'un
   * repère (dernière conversion connue), la taille de l'ordre est `qty`.
   */
  usdc: number;
  /**
   * Quantité de l'actif fixée par l'utilisateur quand l'unité de saisie est celle de l'actif : c'est elle qui part,
   * telle quelle (tronquée au pas du contrat), même si le prix bouge entre la saisie et la confirmation. Absente :
   * la taille se déduit de `usdc` (ticket en USDC, ou ancien ticket enregistré avant cette donnée).
   */
  qty?: number | null;
  leverage: number;
  cross: boolean;
  /** Sens choisi, comme sur Hyperliquid : un seul bouton d'envoi. */
  side: 'buy' | 'sell';
  /** Entrée au marché ou à cours limité. */
  type: 'market' | 'limit';
  /** Unité de saisie de la taille. */
  unit: 'usdc' | 'btc';
  /** TP / SL envoyés avec l'entrée. */
  tpsl: boolean;
  /** Réduire seulement (non retenu : il ne vaut que pour la position du moment). */
  reduce: boolean;
  /** Risque visé pour « Taille au risque », en % de la valeur du compte. */
  riskPct: number;
  /** Prix du moment (non retenus d'une session à l'autre : un vieux prix serait dangereux). */
  limitPx?: number | null;
  tp?: number | null;
  sl?: number | null;
}

/** Ticket par défaut, avant toute préférence enregistrée. */
export const DEFAULT_TICKET: Ticket = {
  usdc: 100,
  leverage: 5,
  cross: true,
  side: 'buy',
  type: 'market',
  unit: 'usdc',
  tpsl: false,
  reduce: false,
  riskPct: 1,
};

/** Ce que les calculs du ticket lisent de l'état d'un compte. */
export type AccountView = Pick<HlState, 'mid' | 'trade' | 'withdrawable' | 'accountValue'> & {
  position: Pick<HlPosition, 'size' | 'entry' | 'leverage' | 'cross'> | null;
};

/** Problème qui empêche l'action : le message est montré tel quel, rien n'est envoyé. */
export interface Refusal {
  problem: string;
}
export const refused = <T extends object>(r: T | Refusal): r is Refusal => 'problem' in r;

/** Levier ramené à un entier entre 1 et le maximum du contrat ; illisible → levier par défaut, borné aussi. */
export function leverageBound(lev: unknown, max: number): number {
  const v = typeof lev === 'number' && Number.isFinite(lev) ? Math.round(lev) : DEFAULT_TICKET.leverage;
  return Math.min(Math.max(1, max), Math.max(1, v));
}

/**
 * Ticket repris des préférences enregistrées. Les prix (limite, TP, SL) et « Réduire seulement » ne sont jamais
 * repris : ils ne valent que pour le marché et la position du moment. La clé de stockage est commune à tous les
 * actifs : le levier enregistré est borné au maximum du contrat affiché (`maxLeverage`), jamais repris tel quel ;
 * `trade-ui.ts` le reborne dès que le maximum réel du contrat est lu chez Hyperliquid. La quantité de l'actif n'est
 * reprise qu'en unité de l'actif ; un ticket enregistré sans elle garde son montant en USDC.
 */
export function restoreTicket(json: string | null, maxLeverage = Infinity): Ticket {
  const d = DEFAULT_TICKET;
  try {
    const saved = JSON.parse(json ?? '{}') as Partial<Ticket>;
    const unit = saved.unit === 'btc' ? 'btc' : 'usdc';
    const qty = unit === 'btc' && typeof saved.qty === 'number' && saved.qty > 0 && Number.isFinite(saved.qty) ? saved.qty : null;
    return {
      usdc: saved.usdc && saved.usdc > 0 ? saved.usdc : d.usdc,
      ...(qty !== null ? { qty } : {}),
      leverage: leverageBound(saved.leverage ?? d.leverage, maxLeverage),
      cross: saved.cross ?? d.cross,
      side: saved.side === 'sell' ? 'sell' : 'buy',
      type: saved.type === 'limit' ? 'limit' : 'market',
      unit,
      tpsl: !!saved.tpsl,
      reduce: false,
      riskPct: saved.riskPct && saved.riskPct > 0 ? saved.riskPct : d.riskPct,
    };
  } catch {
    return { ...d, leverage: leverageBound(d.leverage, maxLeverage) };
  }
}

/** Quantité de l'actif fixée par le ticket (unité de l'actif seulement), ou null. */
const fixedQty = (t: Pick<Ticket, 'unit' | 'qty'>): number | null =>
  t.unit === 'btc' && t.qty != null && t.qty > 0 && Number.isFinite(t.qty) ? t.qty : null;

/** Montant de l'ordre en USDC au prix `px` : la quantité fixée × le prix, sinon le montant du ticket. Prix inconnu → 0. */
export function orderUsdc(t: Pick<Ticket, 'unit' | 'qty' | 'usdc'>, px: number): number {
  const q = fixedQty(t);
  return q === null ? t.usdc : px > 0 ? q * px : 0;
}

/**
 * Règle la taille par un montant en USDC (curseur, molette, taille au risque). En unité de l'actif, ce montant est
 * converti une fois, au prix du moment, en une quantité qui ne bouge plus ensuite ; prix inconnu : pas de quantité,
 * le montant sert jusqu'à la prochaine saisie.
 */
export function setUsdc(t: Ticket, usdc: number, px: number): void {
  t.usdc = usdc;
  t.qty = t.unit === 'btc' && px > 0 ? usdc / px : null;
}

/** Taille saisie dans le champ, dans l'unité du ticket (déjà lue par `parseSize`). */
export function setSize(t: Ticket, v: number, px: number): void {
  if (t.unit === 'btc') {
    t.qty = v;
    // Repère en USDC seulement : la taille de l'ordre reste `qty`.
    if (px > 0) t.usdc = v * px;
  } else {
    t.usdc = v;
    t.qty = null;
  }
}

/** Bascule USDC ⇄ unité de l'actif : la taille du moment est gardée, exprimée dans la nouvelle unité. */
export function switchUnit(t: Ticket, px: number): void {
  const usdc = orderUsdc(t, px);
  if (t.unit === 'btc') {
    if (px > 0 || fixedQty(t) === null) t.usdc = usdc;
    t.unit = 'usdc';
    t.qty = null;
  } else {
    t.unit = 'btc';
    t.qty = px > 0 ? usdc / px : null;
  }
}

// ───────────── Prix, levier, maximum ─────────────

/** Prix d'entrée du ticket : le prix visé (`at`, clic droit), le prix limite, ou le prix Hyperliquid au marché. */
export const entryPrice = (t: Pick<Ticket, 'type' | 'limitPx'>, mid: number | null, at?: number): number | null =>
  at ?? (t.type === 'limit' ? (t.limitPx ?? null) : mid);
/** Prix servant à convertir USDC et unités de l'actif : l'entrée si elle est connue, sinon le prix Hyperliquid, sinon 0. */
export const refPrice = (t: Pick<Ticket, 'type' | 'limitPx'>, mid: number | null): number => entryPrice(t, mid) ?? mid ?? 0;
/** Levier de l'ordre : celui de la position ouverte (non modifiable tant qu'elle l'est), sinon celui du ticket. */
export const effectiveLeverage = (t: Pick<Ticket, 'leverage'>, position: Pick<HlPosition, 'leverage'> | null): number =>
  position?.leverage ?? t.leverage;

/**
 * Montant maximal d'un ordre dans un sens, en USDC, comme l'annonce Hyperliquid (« disponible pour trader ») : la
 * taille maximale qu'il calcule si le levier du ticket est le sien, sinon sa marge disponible × le levier du
 * ticket. Avec « Réduire seulement », c'est la position qu'on peut réduire (0 dans le sens qui l'augmenterait).
 */
export function maxUsd(t: Pick<Ticket, 'type' | 'limitPx' | 'reduce' | 'leverage'>, s: AccountView, buy: boolean): number {
  const px = refPrice(t, s.mid);
  const pos = s.position;
  if (t.reduce) return pos && pos.size > 0 !== buy ? Math.abs(pos.size) * px : 0;
  const tr = s.trade;
  const lev = effectiveLeverage(t, pos);
  if (tr) return tr.leverage === lev && px ? tr.maxSz[buy ? 0 : 1] * px : tr.avail[buy ? 0 : 1] * lev;
  return buyingPower(s.withdrawable, lev);
}

/** Marge disponible pour trader dans un sens (USDC). */
export const availUsd = (s: Pick<HlState, 'trade' | 'withdrawable'>, buy: boolean): number | null =>
  s.trade?.avail[buy ? 0 : 1] ?? s.withdrawable;
/** TP et SL du ticket, seulement s'ils sont activés et que l'ordre n'est pas « Réduire seulement ». */
export const tpOf = (t: Pick<Ticket, 'tpsl' | 'reduce' | 'tp'>): number | null => (t.tpsl && !t.reduce ? (t.tp ?? null) : null);
export const slOf = (t: Pick<Ticket, 'tpsl' | 'reduce' | 'sl'>): number | null => (t.tpsl && !t.reduce ? (t.sl ?? null) : null);

/**
 * Valeur du compte pour le risque en % : celle du compte perpétuel ; sur un compte unifié (USDC côté comptant,
 * compte perpétuel à zéro sans position), à défaut, la marge disponible pour trader.
 */
export const equity = (s: Pick<HlState, 'accountValue' | 'trade'>): number | null =>
  (s.accountValue ?? 0) > 0 ? s.accountValue : s.trade ? Math.max(...s.trade.avail) : null;

/** Plan de l'ordre du ticket à ce prix d'entrée : taille tronquée au pas du contrat, risque, gain, refus éventuel. */
export const plan = (t: Ticket, s: AccountView, buy: boolean, entry: number, szDecimals: number): TicketPlan =>
  planTicket({
    buy,
    entry,
    usdc: t.usdc,
    qty: fixedQty(t),
    tp: tpOf(t),
    sl: slOf(t),
    accountValue: equity(s),
    szDecimals,
    minNotional: MIN_NOTIONAL,
  });

/** Part du compte, sans signe, espace ordinaire avant « % » (affichage d'origine de la carte, pas `format.pct`). */
export const pctText = (share: number) => `${(share * 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
/** Rapport gain / risque à une décimale. */
export const rrText = (rr: number) => rr.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

// ───────────── Saisie ─────────────

/**
 * Taille saisie dans le champ du ticket : virgule décimale française, espaces (y compris insécables) ignorés. Rend
 * null pour une saisie vide, nulle, négative, illisible ou infinie : le ticket garde alors sa taille.
 */
export function parseSize(text: string): number | null {
  const v = +text.replace(',', '.').replace(/\s/g, '');
  return v > 0 && Number.isFinite(v) ? v : null;
}

/**
 * Texte du champ « Taille » : USDC arrondis au dollar, ou quantité de l'actif tronquée au pas du contrat, avec la
 * même marge d'arrondi que `planTicket` pour que le champ montre exactement la taille qui partira.
 */
export function sizeText(t: Pick<Ticket, 'usdc' | 'qty' | 'unit' | 'type' | 'limitPx'>, mid: number | null, szDecimals: number): string {
  if (t.unit === 'usdc') return String(Math.round(t.usdc));
  const k = 10 ** szDecimals;
  const q = fixedQty(t);
  const px = refPrice(t, mid);
  const raw = q ?? (px ? t.usdc / px : null);
  return raw === null ? '' : String(Math.floor(raw * k * (1 + SIZE_NUDGE)) / k);
}

/** Prix saisi (limite, TP, SL) : null s'il n'est pas strictement positif. */
export const priceInput = (v: string): number | null => (+v > 0 ? +v : null);
/** Risque saisi en % du compte, plafonné à 100 ; null (saisie ignorée) s'il n'est pas strictement positif. */
export const riskPctInput = (v: string): number | null => (+v > 0 ? Math.min(100, +v) : null);
/** Levier saisi : entier de 1 au maximum du contrat ; vide ou illisible → 1. */
export const leverageInput = (v: string, max: number): number => Math.min(max, Math.max(1, Math.round(+v || 1)));
/** Levier à la molette : un cran de plus ou de moins, dans les mêmes bornes. */
export const leverageStep = (lev: number, dir: number, max: number): number => Math.min(max, Math.max(1, lev + dir));

/**
 * « Taille au risque » : montant qui fait perdre `riskPct` % du compte si le stop est touché, ramené au maximum
 * disponible (au dollar inférieur), et jamais sous le minimum d'Hyperliquid. `warning` : message si le montant visé
 * a dû être réduit, ou relevé au minimum (le risque réel dépasse alors celui demandé : il est chiffré).
 */
export function riskSize(t: Ticket, s: AccountView, buy: boolean): Refusal | { usdc: number; wanted: number; warning: string | null } {
  const entry = entryPrice(t, s.mid);
  const sl = slOf(t);
  const eq = equity(s);
  if (!sl || !entry || !eq) return { problem: 'Indique d’abord un stop loss (et un prix limite pour un ordre limite).' };
  const wanted = usdcForRisk(t.riskPct, eq, entry, sl);
  const max = maxUsd(t, s, buy);
  const usdc = Math.max(MIN_NOTIONAL, max > 0 ? Math.min(wanted, Math.floor(max)) : wanted);
  let warning: string | null = null;
  if (max > 0 && wanted > max)
    warning = `La taille visée (${usd(wanted)}) dépasse le maximum disponible : ramenée à ${usd(usdc)}. Stop trop proche pour ce risque, ou levier trop bas.`;
  else if (wanted > 0 && usdc > wanted) {
    const loss = (usdc / entry) * Math.abs(entry - sl);
    warning = `La taille visée (${usd(wanted)}) est sous le minimum d’Hyperliquid : relevée à ${usd(usdc)}. Perte au stop ≈ ${usd(loss)}, soit ${pctText(loss / eq)} du compte au lieu de ${pctText(t.riskPct / 100)}.`;
  }
  return { usdc, wanted, warning };
}

// ───────────── Confirmation d'une entrée ─────────────

export type Tone = 'up' | 'down' | 'flat';
export type Row = [string, string];

/** Contenu d'une fenêtre de confirmation. */
export interface Confirmation {
  title: string;
  rows: Row[];
  warn: string;
  tone: Tone;
  ok: string;
}

/** Première ligne de toute confirmation d'ordre : l'actif visé (SEC-24). */
export const assetRow = (coin: string): Row => ['Actif', coin];

export interface EntryInput {
  /** Actif de l'ordre, nommé dans la confirmation. */
  coin: string;
  buy: boolean;
  /** Prix limite visé au clic droit ; absent : celui du ticket (ordre limite) ou le marché. */
  at?: number;
  ticket: Ticket;
  state: AccountView & Pick<HlState, 'orders'>;
  /** Décimales de taille du contrat de l'ordre. */
  szDecimals: number;
  /** TP limite complet en place (`Hyperliquid.tpSplit().full`), déplacé par un TP posé sur la position fusionnée. */
  tpFull: HlOrder | undefined;
  /** Frais d'interface en dixièmes de point de base, s'il est autorisé par le compte ; null sinon. */
  builderFee: number | null;
  /** Taille maximale par ordre fixée par l'utilisateur (USDC), ou null / absente : pas de plafond. */
  maxOrderUsd?: number | null;
}

export interface EntryOrder extends Confirmation {
  /** Libellé de l'action (titre du message de résultat). */
  label: string;
  limit: boolean;
  entry: number;
  plan: TicketPlan;
  tp: number | null;
  sl: number | null;
  /** Position obtenue, quand le TP / SL du ticket s'appliquera à toute la position (entrée au marché sur une position ouverte). */
  merged: MergedPosition | null;
  /**
   * Prix limite à plus de `FAR_LIMIT` du prix actuel (faute de frappe probable) : confirmation renforcée à demander
   * après la première (`farPriceConfirmation`). Null sinon.
   */
  far: Confirmation | null;
}

/**
 * Entrée depuis le ticket ou le clic droit : refus éventuel, sinon ordre à envoyer et contenu de sa confirmation.
 * Entrée au marché avec TP / SL alors qu'une position est ouverte : sur Hyperliquid, ils portent sur toute la
 * position obtenue et remplacent ceux en place ; le risque affiché est donc celui de cette position-là.
 */
export function prepareEntry(i: EntryInput): Refusal | EntryOrder {
  const { coin, buy, at, ticket: t, state: s } = i;
  const m = s.mid;
  const limit = at !== undefined || t.type === 'limit';
  const entry = entryPrice(t, m, at);
  if (!entry)
    return {
      problem: limit
        ? 'Indique un prix limite dans le ticket (ou clic droit sur le graphique).'
        : 'Le prix Hyperliquid n’est pas encore reçu.',
    };
  const pl = plan(t, s, buy, entry, i.szDecimals);
  if (pl.problem) return { problem: pl.problem };
  const tooBig = overMaxOrder(pl.notional, i.maxOrderUsd ?? null);
  if (tooBig) return { problem: tooBig };
  const crossing = limit && m !== null && (buy ? entry >= m : entry <= m);
  const total = maxUsd(t, s, buy);
  const tp = tpOf(t);
  const sl = slOf(t);
  const avail = availUsd(s, buy);
  const pos = s.position;
  const merged = !limit && !t.reduce && pos && (tp || sl) ? positionAfter(pos, buy, pl.size, entry) : null;
  if (merged && !merged.coherent)
    return {
      problem:
        'Cet ordre réduit la position ouverte : le TP / SL du ticket ne peut pas s’y appliquer. Décoche « TP / SL », ou pose-le sur la position (clic droit sur le graphique).',
    };
  const mergedSize = merged ? Math.abs(merged.size) : 0;
  const mergedResult = (price: number) => (merged ? (price - merged.entry) * Math.sign(merged.size) * mergedSize : 0);
  const oldSl = merged ? s.orders.find(o => o.kind === 'sl') : undefined;
  const oldTp = merged ? i.tpFull : undefined;
  const account = equity(s);
  // Le minimum d'Hyperliquid fait perdre au stop plus que le risque visé (compte petit ou stop lointain) : quelle que
  // soit la façon dont la taille a été réglée, le risque réel est dit en clair avant l'envoi.
  const overMinRisk =
    !merged &&
    sl &&
    account &&
    pl.risk !== null &&
    pl.riskShare !== null &&
    usdcForRisk(t.riskPct, account, entry, sl) < MIN_NOTIONAL &&
    pl.riskShare * 100 > t.riskPct
      ? `Attention : le minimum d’Hyperliquid (${MIN_NOTIONAL} USDC) dépasse la taille au risque visé : perte au stop ${usd(pl.risk)}, soit ${pctText(pl.riskShare)} du compte au lieu de ${pctText(t.riskPct / 100)}.`
      : '';
  const rows: Row[] = [
    assetRow(coin),
    ['Sens', `${buy ? 'Achat (long)' : 'Vente (short)'}${t.reduce ? ', réduisant seulement' : ''}`],
    ['Montant', `${usd(pl.notional)} (${btc(pl.size)})`],
    limit
      ? ['Prix limite', `${f.price(entry)} (prix Hyperliquid, ${m ? `${f.price(m)} actuellement` : 'prix actuel inconnu'})`]
      : [
          'Prix',
          `marché, ${f.price(entry)} actuellement, au plus ${f.price(entry * (buy ? 1 + MARKET_SLIPPAGE : 1 - MARKET_SLIPPAGE))} (tolérance ${MARKET_SLIPPAGE * 100} %)`,
        ],
    leverageRow(t, pos),
    [
      'Marge engagée',
      t.reduce
        ? 'aucune (réduit la position)'
        : `≈ ${usd(pl.notional / effectiveLeverage(t, pos))}${avail !== null ? ` sur ${usd(avail)} disponibles` : ''}`,
    ],
  ];
  if (i.builderFee !== null)
    rows.push(['Frais d’interface', `${feeText(i.builderFee)}, ≈ ${usd((pl.notional * i.builderFee) / 100_000)} à l’exécution`]);
  if (merged)
    rows.push([
      'Position après l’ordre',
      `${merged.size > 0 ? 'Long' : 'Short'} ${btc(mergedSize)}, entrée moyenne ≈ ${f.price(merged.entry)}`,
    ]);
  if (sl && merged) {
    const result = mergedResult(sl);
    rows.push([
      'Stop loss',
      `${f.price(sl)} sur TOUTE la position (${btc(mergedSize)}) : ${signedUsd(result)}${account && result < 0 ? ` (${pctText(-result / account)} du compte)` : ''}`,
    ]);
    if (oldSl) rows.push(['Remplace', `le stop actuel à ${f.price(oldSl.price)}`]);
  } else if (sl)
    rows.push([
      'Stop loss',
      `${f.price(sl)} : ${signedUsd(-(pl.risk ?? 0))}${pl.riskShare !== null ? ` (${pctText(pl.riskShare)} du compte)` : ''}`,
    ]);
  if (tp && merged) {
    rows.push([
      'Take profit',
      `${f.price(tp)}, limite réduisant seulement, sur toute la position hors TP partiels : ${signedUsd(mergedResult(tp))} si tout est exécuté`,
    ]);
    if (oldTp) rows.push(['Déplace', `le TP limite actuel à ${f.price(oldTp.price)}`]);
  } else if (tp)
    rows.push([
      'Take profit',
      `${f.price(tp)}, limite réduisant seulement : ${signedUsd(pl.reward ?? 0)}${pl.rr !== null ? ` · gain / risque ${rrText(pl.rr)}` : ''}`,
    ]);
  const warn = [
    crossing
      ? `Attention : ce prix est ${buy ? 'au-dessus' : 'au-dessous'} du prix actuel, l’ordre s’exécutera tout de suite au marché.`
      : '',
    total > 0 && pl.notional > total * 1.001
      ? 'Attention : montant supérieur au maximum disponible, Hyperliquid refusera probablement l’ordre.'
      : '',
    overMinRisk,
    sl || t.reduce ? '' : 'Sans stop loss.',
    merged
      ? 'Attention : une position est déjà ouverte. Le TP / SL du ticket s’applique à toute la position obtenue et remplace ceux en place : le résultat au stop est calculé sur cette position entière.'
      : '',
    limit && (tp || sl)
      ? 'TP et SL sont rattachés à l’entrée et restent EN ATTENTE : Hyperliquid ne les place qu’une fois l’ordre ENTIÈREMENT exécuté, pour sa taille. Une exécution partielle n’est pas protégée, et annuler le reste de l’entrée annule aussi ce TP et ce SL. Le TP se déclenche à son prix et pose alors un ordre limite réduisant seulement à ce prix.'
      : '',
    limit
      ? 'Ordre réel sur Hyperliquid, laissé dans le carnet jusqu’à exécution ou annulation.'
      : 'Ordre réel sur Hyperliquid, exécuté immédiatement.',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    title: limit ? `${buy ? 'Achat' : 'Vente'} limite ${coin} à ${f.price(entry)}` : `${buy ? 'Acheter' : 'Vendre'} ${coin} au marché`,
    rows,
    warn,
    tone: buy ? 'up' : 'down',
    ok: buy ? 'Confirmer l’achat' : 'Confirmer la vente',
    label: limit ? `${buy ? 'Achat' : 'Vente'} limite` : `${buy ? 'Achat' : 'Vente'} au marché`,
    limit,
    entry,
    plan: pl,
    tp,
    sl,
    merged,
    far: limit && m ? farPriceConfirmation(coin, buy, entry, m) : null,
  };
}

// ───────────── Garde-fous contre les fautes de frappe (23/11/2026) ─────────────
//
// Partie Application (trading) de docs/AUDIT-PASSAGE-A-L-ECHELLE-2026-11-23.md : aucun garde-fou n'arrêtait un prix
// limite tapé avec un zéro de trop ou de moins, ni une taille hors de proportion.

/** Écart au prix actuel au-delà duquel un prix limite demande une confirmation renforcée : 10 %. */
export const FAR_LIMIT = 0.1;

/** Écart relatif d'un prix au prix actuel (0,12 : 12 % au-dessus), ou null si l'un des deux est illisible. */
export function priceGap(price: number, mid: number | null): number | null {
  if (!(price > 0) || !(mid !== null && mid > 0)) return null;
  return price / mid - 1;
}

/** Écart signé en pourcentage, à la française (« +12,5 % », « −35 % »). */
export const gapText = (gap: number): string =>
  `${gap >= 0 ? '+' : '−'}${(Math.abs(gap) * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;

/**
 * Confirmation renforcée d'un ordre limite dont le prix s'écarte de plus de `FAR_LIMIT` du prix actuel, ou null si
 * l'écart est raisonnable. Elle s'affiche après la confirmation ordinaire et dit l'écart en clair : un achat très
 * au-dessus du marché (ou une vente très au-dessous) s'exécuterait tout de suite, au pire prix accepté.
 */
export function farPriceConfirmation(coin: string, buy: boolean, price: number, mid: number | null): Confirmation | null {
  const gap = priceGap(price, mid);
  // Marge de 1e-9 : 110 000 / 100 000 − 1 vaut 0,1000…09 en virgule flottante, et 10 % tout rond reste permis.
  if (gap === null || Math.abs(gap) <= FAR_LIMIT + 1e-9) return null;
  const crossing = buy ? gap > 0 : gap < 0;
  return {
    title: `Prix ${coin} très éloigné du marché : ${gapText(gap)}`,
    rows: [
      assetRow(coin),
      ['Prix limite', f.price(price)],
      ['Prix actuel', f.price(mid!)],
      ['Écart', `${gapText(gap)} ${gap > 0 ? 'au-dessus' : 'au-dessous'} du prix actuel`],
    ],
    warn: crossing
      ? `Vérifie le prix : à ${gapText(gap)} du marché, ${buy ? 'cet achat' : 'cette vente'} s’exécuterait tout de suite, jusqu’à ce prix limite. Une faute de frappe (zéro en trop ou en moins) coûterait cher.`
      : `Vérifie le prix : à ${gapText(gap)} du marché, l’ordre restera probablement longtemps dans le carnet. Une faute de frappe (zéro en trop ou en moins) ?`,
    tone: 'down',
    ok: 'Oui, ce prix est voulu',
  };
}

/** Plus petite taille maximale par ordre acceptée : le minimum d'Hyperliquid (un plafond plus bas bloquerait tout). */
export const MAX_ORDER_FLOOR = MIN_NOTIONAL;

/** Taille maximale par ordre saisie dans la carte (USDC) : vide, nulle ou illisible → pas de plafond (null). */
export function maxOrderInput(v: string | null | undefined): number | null {
  const n = Number(
    String(v ?? '')
      .replace(/\s/g, '')
      .replace(',', '.'),
  );
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(MAX_ORDER_FLOOR, Math.round(n));
}

/** Refus d'un ordre au-delà de la taille maximale fixée par l'utilisateur, ou null s'il passe (ou sans plafond). */
export function overMaxOrder(notional: number, max: number | null): string | null {
  if (max === null || !(max > 0) || !(notional > max)) return null;
  return `Ordre refusé : ${usd(notional)} dépasse ta taille maximale par ordre (${usd(max)}). Réduis la taille, ou change ce plafond dans la carte (Garde-fous).`;
}

/**
 * Levier de l'ordre : avec une position ouverte, celui de la position (Hyperliquid ne permet pas de changer de
 * mode croisé / isolé tant qu'elle est ouverte) ; sinon celui du ticket, appliqué juste avant l'ordre.
 */
const leverageRow = (t: Pick<Ticket, 'leverage' | 'cross'>, p: Pick<HlPosition, 'leverage' | 'cross'> | null): Row =>
  p
    ? ['Levier', `${p.leverage}× ${p.cross ? 'croisé' : 'isolé'} (celui de la position)`]
    : ['Levier', `${t.leverage}× ${t.cross ? 'croisé' : 'isolé'} (appliqué avant l’ordre)`];

// ───────────── Fermeture, déplacement ─────────────

/**
 * Fermeture d'une part (0 à 1) de la position au marché. La part est bornée comme dans `Hyperliquid.close`, pour
 * que la confirmation annonce ce qui sera réellement envoyé ; une part nulle ou illisible est refusée (Hyperliquid
 * refuserait un ordre de taille 0).
 */
export function closeConfirmation(
  coin: string,
  p: Pick<HlPosition, 'size' | 'pnl'>,
  mid: number,
  fraction: number,
): Refusal | Confirmation {
  const share = Math.min(1, Math.max(0, fraction));
  const size = Math.abs(p.size) * share;
  if (!(size > 0)) return { problem: 'Part à fermer invalide.' };
  return {
    title: share >= 1 ? `Fermer la position ${coin}` : `Fermer ${Math.round(share * 100)} % de la position ${coin}`,
    rows: [
      assetRow(coin),
      ['Position', `${p.size > 0 ? 'Long' : 'Short'} ${usd(Math.abs(p.size) * mid)}`],
      ['Ferme', `${usd(size * mid)} au marché (tolérance ${MARKET_SLIPPAGE * 100} %)`],
      ['PnL latent', `${signedUsd(p.pnl)} sur toute la position`],
    ],
    warn: 'Ordre réel sur Hyperliquid, exécuté immédiatement.',
    tone: 'flat',
    ok: 'Confirmer la fermeture',
  };
}

/**
 * Ligne d'ordre glissée sur le graphique : son identifiant porte le rang du compte (« 1:o:123 »), pour que le
 * déplacement vise toujours le compte qui porte l'ordre, pas forcément l'onglet choisi.
 */
export function parseLineId(id: string): { account: number; key: string } {
  const [k, ...rest] = id.split(':');
  return { account: Number(k), key: rest.join(':') };
}

/**
 * Déplacement d'un ordre au prix où sa ligne a été lâchée (déjà arrondi au pas de saisie). Refusé si le prix n'est
 * pas strictement positif (ligne lâchée sous zéro) ou, pour un TP / SL, s'il est du mauvais côté du prix actuel.
 */
export function moveConfirmation(
  coin: string,
  o: HlOrder,
  price: number,
  position: Pick<HlPosition, 'size' | 'entry'> | null,
  mid: number | null,
  mark: number | null = null,
): Refusal | Confirmation {
  if (!(price > 0)) return { problem: 'Prix invalide : lâche l’ordre sur un prix positif.' };
  // TP / SL : contrôlés sur le mark price, qui les déclenche chez Hyperliquid (23/11/2026) ; le milieu en repli.
  const ref = mark ?? mid;
  if ((o.kind === 'tp' || o.kind === 'sl') && position && ref) {
    const wrong = checkTrigger(position.size > 0, o.kind, price, ref);
    if (wrong) return { problem: wrong };
  }
  const crossing = o.kind === 'limit' && mid !== null && (o.buy ? price >= mid : price <= mid);
  const from = exitPnl(position, o, o.price);
  const to = exitPnl(position, o, price);
  return {
    title: `Déplacer : ${o.label} ${coin}`,
    rows: [
      assetRow(coin),
      ['De', `${f.price(o.price)}${from !== null ? ` (${signedUsd(from)})` : ''}`],
      ['À', `${f.price(price)}${to !== null ? ` (${signedUsd(to)} hors frais)` : ''}`],
      ['Montant', o.position ? 'toute la position' : usd(o.size * price)],
    ],
    warn: crossing ? 'Attention : à ce prix, l’ordre s’exécutera tout de suite au marché.' : '',
    tone: o.kind === 'tp' ? 'up' : o.kind === 'sl' ? 'down' : o.buy ? 'up' : 'down',
    ok: 'Confirmer le déplacement',
  };
}

/**
 * Annulation d'un ordre (bouton × de la carte ou du panneau, clic droit sur sa ligne). Entrée avec TP / SL rattachés
 * (23/11/2026) : ils sont EN ATTENTE et seront annulés avec elle ; si l'entrée est déjà exécutée en partie, la
 * confirmation dit la position résiduelle et l'état réel de son stop, et annonce la proposition qui suivra (poser un
 * stop loss sur la position au prix du SL rattaché).
 */
export function cancelConfirmation(
  coin: string,
  o: Pick<HlOrder, 'label' | 'price' | 'size' | 'position'> & Partial<Pick<HlOrder, 'origSize' | 'children'>>,
  position: Pick<HlPosition, 'size'> | null = null,
  activeSl: Pick<HlOrder, 'price'> | null = null,
): Confirmation {
  const rows: Row[] = [assetRow(coin), ['Montant', o.position ? 'toute la position' : usd(o.size * o.price)]];
  const children = o.children ?? [];
  const warn: string[] = [];
  if (children.length) {
    rows.push(['Annule aussi', children.map(c => `${c.label} en attente à ${f.price(c.price)}`).join(', ')]);
    warn.push('Les TP / SL rattachés à cette entrée sont annulés avec elle.');
  }
  const filled = filledPart({ size: o.size, origSize: o.origSize });
  if (filled > 0) {
    rows.push(['Déjà exécuté', `${btc(filled)} sur ${btc(o.origSize!)}`]);
    rows.push(['Position actuelle', position ? `${position.size > 0 ? 'Long' : 'Short'} ${btc(Math.abs(position.size))}` : 'aucune']);
    rows.push(['Stop actif sur la position', activeSl ? f.price(activeSl.price) : 'AUCUN']);
    const sl = children.find(c => c.kind === 'sl');
    if (position && !activeSl)
      warn.push(
        sl
          ? `Attention : la position résiduelle n’a AUCUN stop actif (le SL rattaché n’était qu’en attente). Après l’annulation, HyperChart te proposera de poser un stop loss à ${f.price(sl.price)} sur la position.`
          : 'Attention : la position résiduelle n’a AUCUN stop actif.',
      );
  }
  return {
    title: `Annuler : ${o.label} ${coin} à ${f.price(o.price)}`,
    rows,
    warn: warn.join(' '),
    tone: 'flat',
    ok: 'Annuler l’ordre',
  };
}

/**
 * Après l'annulation d'une entrée exécutée en partie dont le SL n'était qu'en attente (23/11/2026) : prix du stop loss
 * à proposer sur la position résiduelle (le même). Null s'il n'y a rien à proposer (pas de position, stop déjà actif,
 * pas de SL rattaché, entrée pas exécutée).
 */
export function residualStop(
  o: Pick<HlOrder, 'size'> & Partial<Pick<HlOrder, 'origSize' | 'children'>>,
  position: Pick<HlPosition, 'size'> | null,
  activeSl: unknown,
): number | null {
  const sl = o.children?.find(c => c.kind === 'sl');
  if (!sl || !position || activeSl || !(filledPart({ size: o.size, origSize: o.origSize }) > 0)) return null;
  return sl.price;
}

/** Date lisible (« 8 décembre 2026 »). */
export const dateText = (t: number) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Révocation de l'agent HyperChart d'un compte (23/11/2026) : possible même quand sa clé est perdue, la signature
 * étant celle du compte (MetaMask).
 */
export function revokeConfirmation(agent: { address: string | null; until: number | null }): Confirmation {
  return {
    title: 'Révoquer l’agent de trading',
    rows: [
      ['Agent', agent.address ? shortAddr(agent.address) : 'adresse inconnue'],
      ['Autorisé jusqu’au', agent.until ? dateText(agent.until) : 'échéance inconnue'],
      ['Signature', 'une, dans MetaMask, par le compte'],
    ],
    warn: 'La révocation remplace l’agent HyperChart du compte par un agent dont la clé est jetée aussitôt : l’ancienne clé, même copiée, ne peut plus rien signer. Un agent HyperChart activé sur un autre navigateur est révoqué lui aussi. Les ordres déjà dans le carnet restent en place.',
    tone: 'flat',
    ok: 'Révoquer',
  };
}

/**
 * Avant l'activation du trading (23/11/2026) : ce qui doit être su AVANT de signer. Null quand il n'y a rien à
 * signaler (coffre disponible, aucun autre agent HyperChart autorisé).
 */
export function activationConfirmation(check: {
  sessionOnly: boolean;
  replaced: { address: string; validUntil: number | null; here: boolean }[] | null;
}): Confirmation | null {
  const others = (check.replaced ?? []).filter(a => !a.here);
  if (!check.sessionOnly && check.replaced !== null && !others.length) return null;
  const rows: Row[] = [];
  const warn: string[] = [];
  if (check.sessionOnly) {
    rows.push(['Clé de l’agent', 'en mémoire seulement, pour cette session']);
    warn.push(
      'Le chiffrement est indisponible dans ce navigateur (navigation privée ?) : la clé de l’agent ne sera gardée qu’en mémoire. Après un rechargement de la page, il faudra réautoriser le trading (nouvelle signature).',
    );
  }
  if (check.replaced === null) {
    rows.push(['Agents déjà autorisés', 'liste illisible pour l’instant']);
    warn.push(
      'Si un agent HyperChart est déjà actif sur un autre navigateur ou appareil, cette activation le remplacera et il ne pourra plus trader.',
    );
  } else
    for (const a of others)
      rows.push(['Remplace', `l’agent ${shortAddr(a.address)}${a.validUntil ? `, valable jusqu’au ${dateText(a.validUntil)}` : ''}`]);
  if (others.length)
    warn.push(
      'Un agent HyperChart est déjà autorisé pour ce compte, sans doute depuis un autre navigateur ou appareil : Hyperliquid n’en garde qu’un sous ce nom. L’activer ici le remplacera, et le trading s’arrêtera là-bas.',
    );
  return { title: 'Avant d’activer le trading', rows, warn: warn.join(' '), tone: 'flat', ok: 'Continuer vers MetaMask' };
}

// ───────────── Take profit, stop loss ─────────────

/**
 * Avertissement d'un stop loss (23/11/2026) : formulation prudente. Le stop est déclenché sur le mark price puis
 * exécuté au marché : le prix obtenu peut différer du stop, et l'exécution peut être partielle, voire ne pas avoir
 * lieu (marché très rapide, tolérance de prix dépassée).
 */
export const SL_WARN =
  'Ordre réel sur Hyperliquid, réduisant seulement la position. Déclenché sur le mark price puis exécuté au marché : le prix obtenu peut différer du stop (glissement), et l’exécution peut être partielle, voire ne pas avoir lieu dans un marché très rapide.';

/** Répartition des TP limite de la position (`tpSplit` de hyperliquid.ts). */
export interface TpSplitView {
  full: HlOrder | undefined;
  partials: readonly HlOrder[];
  partialSize: number;
  fullSize: number;
}

export interface ProtectInput {
  coin: string;
  tpsl: 'tp' | 'sl';
  price: number;
  position: Pick<HlPosition, 'size' | 'entry' | 'liquidation'>;
  mid: number;
  /** Mark price (23/11/2026) : c'est lui qui déclenche les TP / SL ; le milieu `mid` ne sert qu'en repli. */
  mark?: number | null;
  split: TpSplitView;
  /** Stop loss en place, remplacé par le nouveau. */
  currentSl: HlOrder | undefined;
}

/**
 * TP limite complet (le reste après les TP partiels) ou stop loss sur la position au prix visé (clic droit, stop au
 * point mort) : refus éventuel (mauvais côté du prix, TP partiels couvrant déjà tout), sinon la confirmation.
 */
export function protectConfirmation(i: ProtectInput): Refusal | Confirmation {
  const { coin, tpsl, price, position: p, mid, split } = i;
  const long = p.size > 0;
  const wrong = checkTrigger(long, tpsl, price, i.mark ?? mid);
  if (wrong) return { problem: wrong };
  if (tpsl === 'tp' && !(split.fullSize > 0))
    return { problem: 'Les TP partiels couvrent déjà toute la position : déplace ou annule l’un d’eux.' };
  const size = tpsl === 'tp' ? split.fullSize : Math.abs(p.size);
  const result = (price - p.entry) * Math.sign(p.size) * size;
  const existing = tpsl === 'tp' ? split.full : i.currentSl;
  const beyondLiq = tpsl === 'sl' && p.liquidation !== null && (long ? price <= p.liquidation : price >= p.liquidation);
  return {
    title: `${tpsl === 'tp' ? 'Take profit' : 'Stop loss'} ${coin} à ${f.price(price)}`,
    rows: [
      assetRow(coin),
      ['Position', `${long ? 'Long' : 'Short'} ${btc(Math.abs(p.size))} (${usd(Math.abs(p.size) * p.entry)}), entrée ${f.price(p.entry)}`],
      tpsl === 'tp'
        ? [
            'Ordre',
            `limite à ${f.price(price)}, réduisant seulement, ${btc(size)} (${usd(size * price)})${split.partialSize > 0 ? ` : le reste après ${btc(split.partialSize)} de TP partiels` : ''} ; exécuté à ce prix ou mieux, sans glissement`,
          ]
        : ['Déclenchement', `${f.price(price)} (mark price Hyperliquid), puis clôture au marché`],
      ['Résultat estimé', `${signedUsd(result)} hors frais`],
      ...(existing ? [[tpsl === 'tp' ? 'Déplace' : 'Remplace', `${existing.label} à ${f.price(existing.price)}`] as Row] : []),
    ],
    warn: beyondLiq
      ? 'Attention : ce stop est au-delà du prix de liquidation, la position serait liquidée avant.'
      : tpsl === 'tp'
        ? 'Ordre réel sur Hyperliquid. Les TP partiels ne sont pas touchés. Si tu renforces la position, déplace le TP pour qu’il reprenne le reste. Si le prix ne fait que toucher ce niveau, l’ordre peut n’être exécuté qu’en partie.'
        : SL_WARN,
    tone: tpsl === 'tp' ? 'up' : 'down',
    ok: 'Confirmer',
  };
}

export interface PartialTpInput {
  coin: string;
  price: number;
  /** Part de la position visée (0,25 pour 25 %). */
  share: number;
  position: Pick<HlPosition, 'size' | 'entry'>;
  mid: number;
  /** Mark price (23/11/2026), prix de déclenchement d'Hyperliquid ; `mid` en repli. */
  mark?: number | null;
  /** Décimales de taille du contrat. */
  szDecimals: number;
  split: TpSplitView;
}

/**
 * TP partiel : ordre limite réduisant seulement pour une part de la position, en plus des autres TP, borné à ce qui
 * reste à couvrir ; le TP complet, s'il existe, est réduit d'autant. Refus éventuel, sinon la taille à envoyer et
 * la confirmation.
 */
export function partialTpConfirmation(i: PartialTpInput): Refusal | (Confirmation & { size: number }) {
  const { coin, price, share, position: p, mid, split } = i;
  const long = p.size > 0;
  const wrong = checkTrigger(long, 'tp', price, i.mark ?? mid);
  if (wrong) return { problem: wrong };
  const k = 10 ** i.szDecimals;
  const pos = Math.abs(p.size);
  const { full, partialSize, partials } = split;
  const room = Math.floor((pos - partialSize) * k + 1e-6) / k;
  const size = Math.min(Math.floor(pos * share * k) / k, room);
  if (!(size > 0)) return { problem: 'Les TP partiels couvrent déjà toute la position : déplace ou annule l’un d’eux.' };
  if (size * price < MIN_NOTIONAL)
    return { problem: `Hyperliquid refuse les ordres de moins de ${MIN_NOTIONAL} USDC (${usd(size * price)} ici).` };
  const left = Math.floor((room - size) * k + 1e-6) / k;
  return {
    size,
    title: `TP partiel ${Math.round(share * 100)} % ${coin} à ${f.price(price)}`,
    rows: [
      assetRow(coin),
      ['Position', `${long ? 'Long' : 'Short'} ${btc(pos)}, entrée ${f.price(p.entry)}`],
      [
        'Ordre',
        `limite à ${f.price(price)}, réduisant seulement, ${btc(size)} (${usd(size * price)})${size < pos * share - 1 / k ? ', limité à ce qui reste à couvrir' : ''}`,
      ],
      ['Résultat estimé', `${signedUsd((price - p.entry) * Math.sign(p.size) * size)} hors frais`],
      ...(partials.length ? [['TP partiels déjà posés', `${partials.length}, ${btc(partialSize)}`] as Row] : []),
      ...(full
        ? [
            [
              'TP complet',
              left * full.price >= MIN_NOTIONAL
                ? `à ${f.price(full.price)}, ramené de ${btc(full.size)} à ${btc(left)}`
                : `à ${f.price(full.price)}, annulé : plus rien à couvrir`,
            ] as Row,
          ]
        : left > 0
          ? [['Reste sans TP', `${btc(left)} (pose un TP complet pour le couvrir)`] as Row]
          : []),
    ],
    warn: 'Ordre réel sur Hyperliquid, ajouté aux autres TP. Partiels et TP complet ensemble ne dépassent jamais la position.',
    tone: 'up',
    ok: 'Confirmer',
  };
}
