import { feeRate, PARTNER } from './partner';
import { ExchangeClient, HttpTransport, InfoClient, SubscriptionClient, WebSocketTransport, type ISubscription } from '@nktkas/hyperliquid';
import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';
import { getAddress, type EIP1193Provider } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assetFallback, asset as shown } from './asset';
import { shortAddr } from './format';
import { HL_SLOT_KEYS } from './storage-keys';
import { asSealed, openSecret, sealSecret, vaultAvailable, type SealedSecret } from './agent-vault';

/**
 * Compte Hyperliquid : suivi en direct de la position de l'actif affiché, des ordres et des exécutions d'une adresse,
 * et passage d'ordres. Les positions et ordres des autres actifs sont aussi gardés, pour l'affichage seul (panneau
 * des positions sous le graphique) : aucun ordre ne part pour un autre actif que celui affiché.
 *
 * Changement d'actif sans rechargement (docs/CHANGEMENT-ACTIF-A-CHAUD.md) : le compte, sa connexion et son agent
 * restent ouverts ; `setCoin` ne change que ce qui dépend de l'actif (contrat, prix, position, ordres, disponible).
 * Chaque ordre porte l'actif que l'utilisateur avait sous les yeux en le confirmant ; `guard` le compare à l'actif
 * du compte et à l'actif affiché juste avant chaque envoi : un écart, et rien ne part.
 *
 * Lecture : les positions et ordres d'une adresse sont publics sur Hyperliquid, aucune signature n'est demandée.
 * MetaMask sert seulement à connaître l'adresse.
 *
 * Trading : Hyperliquid fait signer chaque ordre par une clé. Plutôt que de solliciter MetaMask à chaque ordre
 * (il refuse d'ailleurs de signer pour une autre chaîne que la sienne), le compte autorise une fois, par une
 * signature MetaMask, un « portefeuille agent » créé dans ce navigateur. C'est le fonctionnement de
 * l'interface d'Hyperliquid : l'agent peut passer et annuler des ordres, mais ne peut ni retirer ni transférer
 * de fonds. Sa clé reste dans ce navigateur : chiffrée dans le stockage local depuis le 23/11/2026 (`agent-vault.ts`,
 * E1 de docs/AUDIT-PASSAGE-A-L-ECHELLE-2026-11-23.md), ou seulement en mémoire, pour la session, quand le coffre est
 * indisponible (jamais en clair dans le stockage, 23/11/2026). L'application ne l'envoie à aucun serveur. Ce
 * chiffrement protège contre la copie isolée du stockage local (sauvegarde, extension qui le lit), pas contre la
 * copie du profil complet du navigateur (qui emporte aussi la clé du coffre), ni contre un script injecté dans la
 * page : celui-ci peut trader directement avec l'agent, comme l'application, et pourrait même faire sortir la clé
 * par des champs publics des ordres (identifiant client, par exemple). Qui détient la clé peut trader pour le
 * compte, donc lui faire perdre son solde par des ordres défavorables. « Oublier » révoque donc l'agent chez
 * Hyperliquid (`revokeAgent`) avant d'effacer la clé ; la révocation reste possible même si la clé est perdue
 * (elle est signée par le compte, dans MetaMask) ; Hyperliquid permet aussi de le retirer depuis son interface (API).
 *
 * Nom de l'agent (23/11/2026) : il reste `HyperDashboard`, ancien nom de l'application devenue HyperChart. Hyperliquid
 * remplace un agent nommé quand un autre est autorisé sous le même nom : changer ce nom laisserait les agents déjà
 * autorisés sous l'ancien hors d'atteinte de la révocation par remplacement. Le nom technique est donc gardé ; les
 * textes affichés parlent de l'« agent HyperChart ».
 */

/** Écart toléré par un ordre au marché par rapport au milieu du carnet. */
export const MARKET_SLIPPAGE = 0.01;
/**
 * Écart maximal entre le prix montré dans la confirmation d'un ordre au marché et le prix relu juste avant l'envoi
 * (audit H-02, 24/11/2026) : au-delà, l'ordre est refusé avant tout envoi et doit être reconfirmé.
 */
export const CONFIRM_DRIFT = 0.005;
/** Écart toléré à l'exécution d'un stop ou d'un take profit déclenché (ordre au marché). */
const TRIGGER_SLIPPAGE = 0.1;
/** Valeur minimale d'un ordre sur Hyperliquid, en dollars. */
export const MIN_NOTIONAL = 10;
/**
 * Nom technique de l'agent tel qu'Hyperliquid l'affiche dans la liste des agents autorisés du compte. Ancien nom de
 * l'application, gardé exprès (voir l'en-tête) : la révocation remplace l'agent de même nom.
 */
export const AGENT_NAME = 'HyperDashboard';
/**
 * Durée de validité de l'agent, en jours : passé ce délai, Hyperliquid le refuse d'office et une nouvelle signature
 * MetaMask est demandée. Une clé d'agent dérobée cesse ainsi d'être utilisable d'elle-même. 7 jours (audit S-01,
 * 23/11/2026, 15 jours avant) : compromis entre le temps pendant lequel une clé volée resterait utilisable et la
 * fréquence des signatures. L'échéance est écrite chez Hyperliquid dans le nom de l'agent (`valid_until`) et gardée
 * en absolu (`agentUntil`) : un agent approuvé avant le changement reste valable jusqu'à sa propre échéance.
 */
export const AGENT_DAYS = 7;
const AGENT_TTL_MS = AGENT_DAYS * 86_400_000;
/** Durée de validité de l'agent de remplacement posé par une révocation (sa clé n'existe plus : simple ménage). */
const REVOKE_TTL_MS = 3_600_000;
/**
 * Âge maximal du prix Hyperliquid pour envoyer un ordre : au-delà, prix, position et ordres sont relus avant
 * l'envoi (après une veille ou une coupure du flux, le dernier prix reçu peut dater de plusieurs minutes).
 */
const FRESH_MS = 5_000;
/**
 * Échéance des actions envoyées à Hyperliquid (`expiresAfter`, 23/11/2026) : une action reçue après est refusée par
 * Hyperliquid. Une réponse perdue n'est donc plus incertaine indéfiniment : passé l'échéance (plus une marge pour
 * l'écart d'horloge), un ordre toujours inconnu d'Hyperliquid n'a pas été reçu et ne le sera plus.
 */
export const ACTION_TTL_MS = 30_000;
/** Marge ajoutée à l'échéance avant de conclure qu'un ordre inconnu n'a pas été reçu (horloge du poste décalée). */
export const ACTION_SKEW_MS = 30_000;
/**
 * Intention enregistrée avant le 23/11/2026, sans échéance d'action : tranchée, comme avant, une minute après son
 * envoi (Hyperliquid traite un ordre en une ou deux secondes).
 */
const LEGACY_UNKNOWN_MS = 60_000;
/** Mark price plus vieux que cela : le milieu du carnet le remplace pour contrôler un TP / SL. */
const MARK_FRESH_MS = 15_000;
/** Attente maximale du verrou de trading du compte, partagé entre onglets (Web Locks). */
const LOCK_WAIT_MS = 15_000;
/** Sans prix reçu depuis ce délai, le flux est tenu pour coupé : la pastille du compte passe au gris. */
const STALE_MS = 15_000;

/**
 * Ordre d'entrée exécuté, mais une protection demandée avec lui (stop loss, take profit) n'a pas pu être posée.
 * Ce n'est pas un échec de l'ordre : la position est ouverte, et il ne faut pas le renvoyer.
 */
export class UnprotectedError extends Error {
  constructor(
    readonly done: string,
    readonly missing: string[],
  ) {
    super(`${done}. ${missing.join(' ; ')}`);
    this.name = 'UnprotectedError';
  }
}

/**
 * Ordre dont la réponse s'est perdue (réseau coupé, délai dépassé) et qu'Hyperliquid n'a pas pu confirmer ni
 * démentir : il a peut-être été reçu. Aucun nouvel envoi n'est permis tant qu'il n'est pas retrouvé ou écarté.
 */
export class PendingOrderError extends Error {
  constructor(
    readonly cloid: string,
    cause: string,
  ) {
    super(
      `Réponse d’Hyperliquid perdue (${cause}) : l’ordre a peut-être été reçu. Aucun nouvel ordre d’ouverture ne partira tant que son sort n’est pas tranché (fermer, annuler et poser un stop restent possibles) ; vérifie la liste des ordres et la position, puis « Vérifier l’ordre en suspens » dans la carte.`,
    );
    this.name = 'PendingOrderError';
  }
}

/**
 * Statuts d'un envoi d'ordres. Le SDK lève `ApiRequestError` dès qu'un seul des ordres d'un groupe est refusé, en
 * gardant la réponse complète dans `error.response` : une entrée acceptée avec une protection refusée doit être lue
 * comme telle, pas comme un échec global (la renvoyer doublerait l'exposition). null : pas de statuts lisibles.
 */
export function orderStatuses(err: unknown): unknown[] | null {
  const s = (err as { response?: { response?: { data?: { statuses?: unknown } } } } | null)?.response?.response?.data?.statuses;
  return Array.isArray(s) ? s : null;
}

/** Erreur dont on sait que l'ordre n'est pas parti, ou a été refusé par Hyperliquid (réponse reçue). */
function definitive(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'ApiRequestError' || name === 'ValidationError' || name === 'PendingOrderError';
}

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

/** Ordre retrouvé par son identifiant client : ce qu'on peut en dire à l'utilisateur. */
export function describeFound(status: string): string {
  if (status === 'filled') return 'Ordre exécuté';
  if (status === 'open' || status === 'triggered') return 'Ordre placé dans le carnet';
  if (status === 'canceled' || status.endsWith('Canceled')) return `Ordre reçu puis annulé (${status})`;
  if (status === 'rejected' || status.endsWith('Rejected')) throw new Error(`Ordre refusé par Hyperliquid (${status})`);
  return `Ordre reçu (${status})`;
}

/** Nom sous lequel l'agent est autorisé : le nom affiché par Hyperliquid, suivi de sa fin de validité (ms). */
export const agentName = (until: number) => `${AGENT_NAME} valid_until ${until}`;

/**
 * Révoque l'agent HyperDashboard du compte. Hyperliquid désinscrit un agent nommé dès qu'un autre agent est
 * autorisé sous le même nom (documentation « Nonces and API wallets ») : on autorise donc, par une signature du
 * compte, un agent de remplacement dont la clé est tirée au hasard et jamais conservée. L'ancienne clé, où qu'elle
 * se trouve, ne peut plus rien signer ; la nouvelle n'existe plus, et son autorisation s'éteint en une heure.
 */
export async function revokeNamedAgent(master: Pick<ExchangeClient, 'approveAgent'>, now = Date.now()): Promise<`0x${string}`> {
  const discarded = privateKeyToAccount(generatePrivateKey());
  await master.approveAgent({ agentAddress: discarded.address, agentName: agentName(now + REVOKE_TTL_MS) });
  return discarded.address;
}

/** Agent autorisé d'un compte, tel que listé par Hyperliquid (info `extraAgents`). */
export interface ListedAgent {
  address: string;
  name: string;
  /** Fin de validité (ms) ; null pour un agent sans expiration. */
  validUntil: number | null;
}

/** Nom de base d'un agent listé, sans un éventuel suffixe « valid_until … ». */
const baseName = (name: string) => name.replace(/ valid_until \d+$/, '');

/**
 * Agents HyperChart (nom technique `AGENT_NAME`) encore valables parmi ceux d'un compte (23/11/2026) : ceux
 * qu'une nouvelle autorisation sous ce nom remplacerait.
 */
export function ourAgents(list: readonly ListedAgent[], now = Date.now()): ListedAgent[] {
  return list.filter(a => baseName(a.name) === AGENT_NAME && (a.validUntil === null || a.validUntil > now));
}

/**
 * État chez Hyperliquid de l'agent `address` (23/11/2026) : autorisé et valable (avec sa fin de validité), ou non
 * (absent de la liste : remplacé, révoqué, jamais enregistré ; ou périmé). Sert avant de réutiliser une clé
 * enregistrée et après une révocation.
 */
export function agentStatus(
  list: readonly ListedAgent[],
  address: string,
  now = Date.now(),
): { valid: true; until: number | null } | { valid: false; why: 'absent' | 'expired' } {
  const a = list.find(x => x.address.toLowerCase() === address.toLowerCase());
  if (!a) return { valid: false, why: 'absent' };
  if (a.validUntil !== null && a.validUntil <= now) return { valid: false, why: 'expired' };
  return { valid: true, until: a.validUntil };
}

export interface HlPosition {
  /** Taille signée, dans l'unité de l'actif : positive pour un long. */
  size: number;
  entry: number;
  liquidation: number | null;
  pnl: number;
  roe: number;
  leverage: number;
  cross: boolean;
  margin: number;
  value: number;
}

/**
 * Position d'un actif quelconque du compte (panneau des positions, sous le graphique) : mêmes champs que
 * `HlPosition`, plus le nom de l'actif. La position de l'actif affiché reste aussi dans `HlState.position`.
 */
export interface HlAnyPosition extends HlPosition {
  coin: string;
}

export type HlOrderKind = 'limit' | 'tp' | 'sl' | 'stop';

export interface HlOrder {
  oid: number;
  kind: HlOrderKind;
  /** Achat ? */
  buy: boolean;
  /** Prix affiché : prix de déclenchement d'un ordre conditionnel, prix limite sinon. */
  price: number;
  size: number;
  reduceOnly: boolean;
  /** TP / SL rattaché à la position (sa taille suit celle de la position). */
  position: boolean;
  /** Ordre conditionnel (déclenché à un prix) ; faux pour un ordre limite, y compris un TP limite. */
  trigger: boolean;
  label: string;
  /** Identifiant client posé par HyperDashboard (TP complet ou partiel), s'il y en a un. */
  cloid?: string;
  /** TP limite : complet (couvre le reste de la position) ou partiel (taille fixe, en plus). */
  tpRole?: 'full' | 'partial';
  /** Ordre conditionnel exécuté au marché une fois déclenché (faux : il pose un ordre limite). */
  market?: boolean;
  /** Prix limite publié (ordre limite, ou conditionnel limite une fois déclenché) ; sert à le conserver au déplacement. */
  limitPx?: number;
  /** Durée de validité publiée par Hyperliquid (Gtc, Alo, Ioc…), quand elle l'est. */
  tif?: string | null;
  /** Taille d'origine (une entrée partiellement exécutée a `size` < `origSize`). */
  origSize?: number;
  /** Posé par HyperChart (identifiant client à préfixe propre) : seul ordre que le recalage automatique touche. */
  ours?: boolean;
  /**
   * TP / SL rattachés à cette entrée (groupe « normalTpsl ») et encore EN ATTENTE : Hyperliquid ne les place qu'une
   * fois l'entrée entièrement exécutée ; annuler l'entrée les annule aussi (23/11/2026).
   */
  children?: HlOrder[];
}

/** Ordre ouvert sur un autre actif que celui affiché : lecture seule, pour le panneau des positions. */
export interface HlOtherOrder extends HlOrder {
  coin: string;
}

export interface HlFill {
  t: number;
  price: number;
  size: number;
  buy: boolean;
  dir: string;
  pnl: number;
}

export interface HlState {
  address: string | null;
  /** Trading activé : un agent autorisé est enregistré. */
  trading: boolean;
  /** Fin de validité de l'agent enregistré (ms) ; null sans agent, ou pour un agent autorisé sans expiration. */
  agentUntil: number | null;
  /** Connexion du flux en direct. */
  live: boolean;
  accountValue: number | null;
  withdrawable: number | null;
  /** Marge utilisée par l'ensemble des positions (marginSummary.totalMarginUsed), null si absente. */
  marginUsed: number | null;
  position: HlPosition | null;
  /** Toutes les positions ouvertes du compte, tous actifs confondus (celle de l'actif affiché comprise). */
  positions: HlAnyPosition[];
  orders: HlOrder[];
  /** Ordres ouverts des autres actifs que celui affiché (lecture seule). */
  otherOrders: HlOtherOrder[];
  fills: HlFill[];
  /** Milieu du carnet BTC sur Hyperliquid. */
  mid: number | null;
  /**
   * Mark price de l'actif (flux `activeAssetCtx`) : c'est lui qui déclenche les TP / SL chez Hyperliquid (23/11/2026).
   * Null tant qu'il n'est pas reçu ; `triggerRef` retombe alors sur le milieu du carnet.
   */
  mark: number | null;
  /**
   * Agent enregistré pour ce compte dont la clé n'est pas utilisable ici (clé perdue, illisible) mais qui reste
   * autorisé chez Hyperliquid jusqu'à `until` (null : sans expiration connue). Il reste révocable (« Révoquer »).
   */
  orphanAgent: { address: string | null; until: number | null } | null;
  /** Ordres dont la réponse s'est perdue et dont le sort n'est pas encore tranché (23/11/2026). */
  intents: { cloid: string; coin: string; at: number }[];
  /**
   * Ce qu'Hyperliquid annonce comme « disponible pour trader » sur le BTC, par sens (achat, vente) : marge
   * disponible en USDC et taille maximale (dans l'unité de l'actif) au levier réglé sur Hyperliquid. Tient compte d'un compte unifié
   * (USDC côté comptant), ce que le simple « retirable » du compte perpétuel ne fait pas.
   */
  trade: { avail: [number, number]; maxSz: [number, number]; leverage: number; cross: boolean } | null;
  /** Frais d'interface autorisé par ce compte, au moins au taux demandé (null : pas encore lu, ou sans objet). */
  builderApproved: boolean | null;
  /** Parrain du compte : son code, « aucun » si le compte n'en a pas, null tant qu'il n'est pas lu. */
  referredBy: string | 'aucun' | null;
  maxLeverage: number;
  error: string | null;
  /**
   * Remarque sur la garde de la clé de l'agent, affichée dans la carte : clé gardée en mémoire seulement (coffre
   * indisponible dans ce navigateur) ou clé chiffrée devenue illisible. Null : rien à signaler.
   */
  keyNote: string | null;
  /**
   * Audit S-02 (23/11/2026) : remarque sur le compte que MetaMask expose à cette page quand ce n'est plus le compte
   * suivi (ordres et signatures gelés jusqu'à confirmation), ou quand MetaMask est verrouillé ou déconnecté. Null : rien.
   */
  walletNote: string | null;
}

/**
 * Connexion gardée dans le stockage local, une par emplacement (`HL_SLOT_KEYS`). En mémoire, `agentKey` est la clé de
 * l'agent en clair ; dans le stockage, seule sa forme chiffrée (`agentSealed`) est écrite. Sans coffre, la clé n'est
 * gardée qu'en mémoire, pour la session (23/11/2026 : plus jamais en clair dans le stockage). Les métadonnées de
 * l'agent (adresse, compte, échéance) sont gardées indépendamment de la clé : un agent dont la clé est perdue reste
 * connu, donc révocable.
 */
interface Saved {
  address?: string;
  agentKey?: `0x${string}`;
  /** Clé de l'agent chiffrée (`agent-vault.ts`) : seule forme de la clé écrite dans le stockage. */
  agentSealed?: SealedSecret;
  /** Adresse publique de l'agent (23/11/2026) : gardée même si la clé est perdue, pour la révocation et l'affichage. */
  agentAddress?: string;
  agentFor?: string;
  /** Fin de validité de l'agent (ms) ; absente pour un agent autorisé avant l'ajout de l'expiration. */
  agentUntil?: number;
}

/**
 * Coffre indisponible (navigation privée, navigateur ancien) : la clé de l'agent n'est gardée qu'en mémoire, jamais en
 * clair dans le stockage (23/11/2026). Dit avant l'activation et dans la carte.
 */
export const KEY_SESSION_NOTE =
  'Chiffrement indisponible dans ce navigateur (navigation privée ?) : la clé de l’agent n’est gardée qu’en mémoire, pour cette session. Après un rechargement de la page, il faudra réautoriser le trading (nouvelle signature MetaMask).';
/** Ancien nom (clé en clair), gardé pour les imports existants : c'est désormais la clé en mémoire seulement. */
export const KEY_PLAIN_NOTE = KEY_SESSION_NOTE;
/** Clé chiffrée devenue illisible (données du site effacées, coffre inaccessible) : l'agent reste autorisé, révocable. */
export const KEY_LOST_NOTE =
  'La clé de l’agent n’a pas pu être déchiffrée (données du navigateur effacées ou coffre inaccessible) : ce navigateur ne peut plus trader avec. L’agent reste autorisé chez Hyperliquid jusqu’à son échéance : révoque-le (« Révoquer ») ou réactive le trading, ce qui le remplace.';
/** Agent enregistré absent de la liste d'Hyperliquid, ou périmé : sa clé n'est pas réutilisée (23/11/2026). */
export const AGENT_GONE_NOTE =
  'L’agent enregistré dans ce navigateur n’est plus autorisé chez Hyperliquid (remplacé depuis un autre navigateur, révoqué ou expiré) : sa clé est abandonnée. Réactive le trading pour trader d’ici.';

/** Caractéristiques d'un contrat : rang dans la liste des actifs, décimales de taille, levier maximal. */
interface AssetBase {
  index: number;
  szDecimals: number;
  maxLeverage: number;
}

/** Contrat de l'actif d'un compte, avec son nom : vérifié avant chaque envoi (`guard`). */
interface Asset extends AssetBase {
  coin: string;
}

/**
 * Ordre refusé avant tout envoi : il visait un autre actif que celui du compte ou que celui affiché (changement
 * d'actif pendant sa préparation). Rien n'est parti.
 */
/** Prix trop éloigné de celui de la confirmation (ordre au marché) : refusé avant tout envoi, à reconfirmer. */
export class PriceMovedError extends Error {
  constructor(
    readonly expected: number,
    readonly mid: number,
  ) {
    const pct = (Math.abs(mid / expected - 1) * 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
    super(`Le prix a bougé de ${pct} % depuis la confirmation : rien n’a été envoyé. Vérifie le nouveau prix et reconfirme l’ordre.`);
    this.name = 'PriceMovedError';
  }
}

/** Refuse l'ordre au marché si le prix frais s'écarte de plus de `CONFIRM_DRIFT` du prix confirmé (sans prix confirmé : rien). */
export function checkConfirmedPrice(expected: number | null | undefined, mid: number): void {
  if (!expected || !(expected > 0)) return;
  if (Math.abs(mid / expected - 1) > CONFIRM_DRIFT) throw new PriceMovedError(expected, mid);
}

export class CoinChangedError extends Error {
  constructor(
    readonly wanted: string,
    readonly current: string,
  ) {
    super(`Actif changé (${wanted} → ${current}) : rien n’a été envoyé. Vérifie l’ordre sur l’actif affiché et recommence.`);
    this.name = 'CoinChangedError';
  }
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
const CLOID_FULL = 'f011';
const CLOID_PARTIAL = '9a57';
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

/** Ordres ouverts tels que publiés par Hyperliquid, ramenés à ce que le graphique affiche. */
/** Ordre ouvert tel que publié par Hyperliquid (frontendOpenOrders, flux openOrders). */
type RawOrder = {
  coin: string;
  side: 'B' | 'A';
  limitPx: string;
  sz: string;
  oid: number;
  isTrigger: boolean;
  triggerPx: string;
  orderType: string;
  reduceOnly: boolean;
  isPositionTpsl: boolean;
  cloid?: string | null;
  tif?: string | null;
  origSz?: string;
  /** TP / SL rattachés à une entrée pas encore entièrement exécutée (groupe « normalTpsl »). */
  children?: RawOrder[];
};

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

// ───────────── Compte ─────────────

/**
 * Ordre dont la réponse peut se perdre, enregistré AVANT son envoi (23/11/2026) : lié au compte, à l'actif et à son
 * identifiant client, il est levé à la réponse. Une intention restée en place (réponse perdue, page rechargée pendant
 * l'envoi) bloque les nouveaux ordres d'ouverture jusqu'à ce que son sort soit tranché.
 */
interface Intent {
  cloid: `0x${string}`;
  at: number;
  coin: string;
  address: string;
  /** Échéance de l'action (`expiresAfter`, ms) ; null pour une intention enregistrée avant le 23/11/2026. */
  expiresAt: number | null;
}

/**
 * Verdict sur un agent enregistré, d'après la liste des agents du compte chez Hyperliquid (23/11/2026) :
 *  - `valid` : listé et valable ;
 *  - `gone` : périmé, ou absent alors qu'un autre agent HyperChart est listé (remplacé depuis un autre navigateur),
 *    ou absent et sans échéance locale (ancien agent qu'on ne peut pas confirmer : pas réutilisé) ;
 *  - `unknown` : absent d'une liste sans agent HyperChart, avec une échéance locale encore à venir. Rien n'est conclu
 *    (la liste d'Hyperliquid n'est pas tenue pour exhaustive tant que ce n'est pas vérifié sur un vrai compte).
 */
export function agentVerdict(
  list: readonly ListedAgent[],
  address: string,
  hasLocalUntil: boolean,
  now = Date.now(),
): { verdict: 'valid'; until: number | null } | { verdict: 'gone' | 'unknown' } {
  const st = agentStatus(list, address, now);
  if (st.valid) return { verdict: 'valid', until: st.until };
  if (st.why === 'expired') return { verdict: 'gone' };
  if (ourAgents(list, now).length > 0 || !hasLocalUntil) return { verdict: 'gone' };
  return { verdict: 'unknown' };
}

export class Hyperliquid {
  state: HlState = {
    address: null,
    trading: false,
    agentUntil: null,
    live: false,
    accountValue: null,
    withdrawable: null,
    marginUsed: null,
    position: null,
    positions: [],
    orders: [],
    otherOrders: [],
    fills: [],
    mid: null,
    mark: null,
    orphanAgent: null,
    intents: [],
    trade: null,
    builderApproved: null,
    referredBy: null,
    maxLeverage: 40,
    error: null,
    keyNote: null,
    walletNote: null,
  };
  private saved: Saved = {};
  /** Audit S-02 : écouteurs de MetaMask posés (une fois par objet). */
  private walletHooked = false;
  /** Audit S-02 : MetaMask n'expose plus le compte suivi (autre compte choisi) : ordres et signatures gelés. */
  private walletFrozen = false;
  /**
   * Lecture de la clé de l'agent au chargement (déchiffrement, ou migration d'une clé en clair) : asynchrone. Les
   * méthodes qui lisent ou réécrivent la connexion l'attendent ; tant qu'elle dure, le trading reste inactif.
   */
  private keyLoad: Promise<void> = Promise.resolve();
  /** Vrai pendant la lecture (ou la vérification) de la clé de l'agent : la carte l'affiche au lieu de proposer d'activer le trading. */
  keyPending = false;
  /** Forme chiffrée de la clé en mémoire (`key`) : écrite à sa place dans le stockage. */
  private sealed: { key: string; box: SealedSecret } | null = null;
  /**
   * Forme chiffrée illisible au chargement (coffre momentanément inaccessible ?) : gardée telle quelle dans le
   * stockage, pour un prochain chargement, jusqu'à révocation, réactivation ou oubli (23/11/2026).
   */
  private keptBox: SealedSecret | null = null;
  /** Agent (adresse, en minuscules) confirmé valable par la liste d'Hyperliquid pendant cette session. */
  private verifiedAgent: string | null = null;
  private asset: Asset | null = null;
  /** Actif du compte : celui affiché, changé par `setCoin` (changement d'actif sans rechargement). */
  coin: string = shown.coin;
  /** Incrémenté à chaque `setCoin` : une lecture propre à l'ancien actif arrivée ensuite est ignorée. */
  private coinGen = 0;
  /**
   * Incrémenté à chaque changement de compte suivi (`watch`, `forget`, 23/11/2026) : une réponse ou un message de flux
   * arrivé pour l'ancien compte est ignoré.
   */
  private acctGen = 0;
  /** Liste des contrats d'Hyperliquid (`meta`), lue une fois : rang et décimales de chaque actif. */
  private universe: { name: string; szDecimals: number; maxLeverage: number }[] | null = null;
  /** Derniers états bruts du compte (tous actifs) : position et ordres se recalculent au changement d'actif. */
  private lastCh: Parameters<Hyperliquid['applyClearinghouse']>[0] | null = null;
  private lastOrders: RawOrder[] | null = null;
  /** Abonnements propres à l'actif (disponible pour trader, mark price) : refaits à chaque `setCoin`. */
  private activeSubs: ISubscription[] = [];
  /**
   * Gel (début d'un changement d'actif) : aucune nouvelle action ne commence. Une action déjà commencée (entrée puis
   * TP et SL, recalage) va à son terme sur son actif ; `drain()` l'attend.
   */
  frozen = false;
  /** Actions de trading en cours (la plus extérieure seulement), attendues par `drain()`. */
  private readonly running = new Set<Promise<unknown>>();
  private readonly http = new HttpTransport();
  private readonly info = new InfoClient({ transport: this.http });
  private ws: WebSocketTransport | null = null;
  private subs: ISubscription[] = [];
  private exchange: ExchangeClient | null = null;
  /** Heure de réception du dernier prix Hyperliquid (ms) : sert au contrôle de fraîcheur avant un ordre. */
  private midAt = 0;
  /** Heure de réception du dernier mark price (ms). */
  private markAt = 0;
  private staleTimer: ReturnType<typeof setInterval> | undefined;
  /** Intentions gardées en mémoire quand le stockage local est indisponible. */
  private memIntents: Intent[] = [];
  /** Délai avant de relire un ordre introuvable juste après une réponse perdue (le temps qu'il soit traité). */
  lookupDelayMs = 1_500;
  /** TP / SL recalés automatiquement sur la position : compte rendu (ok faux : un recalage a échoué). */
  onProtectSync: (text: string, ok: boolean) => void = () => {};
  /** Attente avant le recalage, le temps que position et ordres rattachés à l'entrée arrivent tous les deux. */
  syncDelayMs = 1_500;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private syncing = false;
  /** Recalages refusés (ordre et taille visée) : pas retentés en boucle. */
  private syncFailed = new Set<string>();

  /**
   * Un objet par compte suivi, chacun avec sa clé de stockage (adresse et agent). Le compte suivi ne change pas
   * quand on choisit un autre compte dans MetaMask : son agent reste valable quel que soit le compte affiché
   * par MetaMask, et plusieurs comptes peuvent être suivis à la fois.
   */
  constructor(
    private readonly onChange: () => void,
    private readonly storeKey = HL_SLOT_KEYS[0],
  ) {
    try {
      this.saved = JSON.parse(localStorage.getItem(storeKey) ?? '{}') as Saved;
    } catch {
      this.saved = {};
    }
    this.keyLoad = this.loadKey();
    this.listenWallet();
    if (this.saved.address) void this.watch(this.saved.address);
  }

  // ───────────── Événements de MetaMask (audit S-02, 23/11/2026) ─────────────

  /**
   * Écoute `accountsChanged` et `disconnect` du fournisseur, une fois par objet. `chainChanged` n'est pas écouté :
   * chaque signature MetaMask relit le réseau au moment de signer (`getChainId`), et les ordres de l'agent ne passent
   * pas par MetaMask. Le compte suivi n'est jamais changé ni oublié ici, et l'agent n'est jamais effacé.
   */
  private listenWallet(): void {
    if (this.walletHooked || typeof window === 'undefined') return;
    const eth = provider();
    if (typeof eth?.on !== 'function') return;
    this.walletHooked = true;
    eth.on('accountsChanged', accounts => this.walletAccounts(accounts));
    eth.on('disconnect', () => this.walletAccounts(null));
  }

  /**
   * Comptes que MetaMask expose désormais à la page (`accountsChanged`) ; null : MetaMask déconnecté (`disconnect`).
   *  - le compte suivi en fait partie : rien à signaler, un gel précédent est levé ;
   *  - un autre compte seulement : ordres et signatures gelés, message clair, jusqu'au retour sur le compte suivi ou à
   *    la confirmation (`confirmWallet`) ;
   *  - aucun compte (MetaMask verrouillé, page déconnectée) : simple remarque, rien n'est gelé (les ordres passent par
   *    l'agent du compte suivi, sans MetaMask ; une signature MetaMask redemandera le compte).
   */
  walletAccounts(accounts: unknown): void {
    const followed = this.state.address;
    const v = accounts === null ? 'none' : walletVerdict(accounts, followed);
    if (!followed || v === 'ok') {
      this.walletFrozen = false;
      this.state.walletNote = null;
    } else if (v === 'other') {
      const shown = shortAddr(String((accounts as string[])[0]));
      const mine = shortAddr(followed);
      this.walletFrozen = true;
      this.state.walletNote = `MetaMask est passé sur ${shown}, qui n’est pas le compte suivi ici (${mine}). Par sécurité, les ordres et signatures de ${mine} sont suspendus : reviens sur ${mine} dans MetaMask, ou confirme « Continuer avec ${mine} » dans la carte. L’autorisation de trading de ${mine} reste valable.`;
    } else {
      this.state.walletNote = `MetaMask est verrouillé ou n’expose plus ${shortAddr(followed)} à cette page : une signature MetaMask (activer, révoquer) le redemandera. Les ordres passent toujours par l’agent de ce compte.`;
    }
    this.emit();
  }

  /** Gel S-02 en cours : MetaMask expose un autre compte que le compte suivi. */
  get walletMismatch(): boolean {
    return this.walletFrozen;
  }

  /** « Continuer avec ce compte » : l'utilisateur confirme le compte suivi malgré le compte affiché par MetaMask. */
  confirmWallet(): void {
    this.walletFrozen = false;
    this.state.walletNote = null;
    this.emit();
  }

  // ───────────── Intentions d'envoi (réponses perdues) ─────────────

  private get intentsKey(): string {
    return `${this.storeKey}:intents`;
  }

  /** Ancienne forme (avant le 23/11/2026) : une seule incertitude, sans actif ni échéance. */
  private get legacyPendingKey(): string {
    return `${this.storeKey}:pending`;
  }

  /**
   * Intentions en cours, relues du stockage à chaque fois : un autre onglet a pu en ajouter ou en lever une. Une
   * intention de plus d'un jour est abandonnée (son sort est de toute façon tranché depuis longtemps).
   */
  private loadIntents(): Intent[] {
    const fresh = (i: Intent) =>
      typeof i?.cloid === 'string' && /^0x[0-9a-f]{32}$/.test(i.cloid) && typeof i.at === 'number' && Date.now() - i.at < 86_400_000;
    try {
      const list = (JSON.parse(localStorage.getItem(this.intentsKey) ?? '[]') as Intent[]).filter(fresh);
      const legacy = JSON.parse(localStorage.getItem(this.legacyPendingKey) ?? 'null') as { cloid: `0x${string}`; at: number } | null;
      if (legacy && this.saved.address)
        list.push({ cloid: legacy.cloid, at: legacy.at, coin: '', address: this.saved.address, expiresAt: null });
      return list.filter(fresh);
    } catch {
      return this.memIntents;
    }
  }

  private saveIntents(list: Intent[]): void {
    this.memIntents = list;
    try {
      if (list.length) localStorage.setItem(this.intentsKey, JSON.stringify(list));
      else localStorage.removeItem(this.intentsKey);
      localStorage.removeItem(this.legacyPendingKey);
    } catch {
      /* stockage indisponible : l'état reste en mémoire pour cet onglet */
    }
    this.showIntents(list);
  }

  private showIntents(list = this.loadIntents()): void {
    this.state.intents = list.filter(i => this.mine(i)).map(i => ({ cloid: i.cloid, coin: i.coin, at: i.at }));
  }

  private mine(i: Pick<Intent, 'address'>): boolean {
    return !!this.state.address && i.address.toLowerCase() === this.state.address.toLowerCase();
  }

  private addIntent(i: Intent): void {
    this.saveIntents([...this.loadIntents().filter(x => x.cloid !== i.cloid), i]);
  }

  private dropIntent(cloid: string): void {
    const list = this.loadIntents();
    if (list.some(x => x.cloid === cloid)) this.saveIntents(list.filter(x => x.cloid !== cloid));
  }

  /** Ordre recherché par son identifiant client : texte à afficher, ou null s'il est inconnu d'Hyperliquid. */
  private async lookup(cloid: `0x${string}`): Promise<string | null> {
    const user = this.state.address as `0x${string}` | null;
    if (!user) throw new Error('aucun compte suivi');
    const r = await this.info.orderStatus({ user, oid: cloid });
    if (r.status !== 'order') return null;
    return describeFound(r.order.status);
  }

  /**
   * Avant un ordre d'ouverture : chaque intention en suspens de ce compte doit être tranchée. Retrouvée chez
   * Hyperliquid, ou toujours inconnue après son échéance d'action (plus la marge d'horloge) : levée. Sinon (Hyperliquid
   * injoignable, ou échéance pas encore passée), rien ne part. Aucun délai ne lève une intention sans cette vérification.
   */
  private async settleIntents(): Promise<void> {
    for (const p of this.loadIntents().filter(i => this.mine(i))) {
      let found: string | null;
      try {
        found = await this.lookup(p.cloid);
      } catch (err) {
        if (/refusé par Hyperliquid/.test(message(err))) {
          this.dropIntent(p.cloid);
          continue;
        }
        throw new PendingOrderError(p.cloid, `vérification impossible : ${message(err)}`);
      }
      const deadline = p.expiresAt !== null ? p.expiresAt + ACTION_SKEW_MS : p.at + LEGACY_UNKNOWN_MS;
      if (found !== null || Date.now() > deadline) {
        this.dropIntent(p.cloid);
        continue;
      }
      const when = new Date(deadline).toLocaleTimeString('fr-FR');
      throw new PendingOrderError(p.cloid, `ordre pas encore visible chez Hyperliquid ; son sort sera tranché après ${when}`);
    }
  }

  /**
   * « Vérifier l'ordre en suspens » (carte) : rapproche chaque intention de ce compte avec Hyperliquid (identifiant
   * client). Lève `PendingOrderError` si l'une ne peut pas encore être tranchée.
   */
  async checkPending(): Promise<string> {
    const before = this.state.intents.length;
    try {
      await this.settleIntents();
    } finally {
      this.showIntents();
      this.emit();
    }
    return before
      ? 'Ordre en suspens rapproché : vérifie la position et la liste des ordres. La voie est libre.'
      : 'Aucun ordre en suspens.';
  }

  /**
   * Envoie un groupe d'ordres et renvoie leurs statuts, un par ordre. Un refus partiel n'est pas une exception
   * (`orderStatuses`). L'intention est écrite AVANT l'envoi (compte, actif, identifiant client du premier ordre) et
   * levée à la réponse ; l'envoi porte une échéance (`expiresAfter`). Une réponse perdue est rapprochée : l'ordre est
   * recherché chez Hyperliquid ; retrouvé, son état remplace la réponse ([{ found }]) ; introuvable ou recherche
   * impossible, l'intention reste (même après rechargement) et bloque les ordres d'ouverture. Un envoi qui ne fait que
   * réduire la position (tous ses ordres « réduisant seulement » : fermeture, stop, TP) n'est jamais bloqué.
   */
  private async send(ex: ExchangeClient, params: Parameters<ExchangeClient['order']>[0], coin: string): Promise<unknown[]> {
    const reducing = params.orders.every(o => o.r);
    if (!reducing) await this.settleIntents();
    const cloid = params.orders[0]?.c as `0x${string}` | undefined;
    // Dernier contrôle, après toutes les attentes : l'actif visé est toujours celui du compte et celui affiché.
    this.guard(coin);
    const address = this.state.address;
    const expiresAt = Date.now() + ACTION_TTL_MS;
    if (cloid && address) this.addIntent({ cloid, at: Date.now(), coin, address, expiresAt });
    try {
      const r = await ex.order(params, { expiresAfter: expiresAt });
      if (cloid) this.dropIntent(cloid);
      return r.response.data.statuses;
    } catch (err) {
      const statuses = orderStatuses(err);
      if (statuses || !cloid || definitive(err)) {
        if (cloid) this.dropIntent(cloid);
        if (statuses) return statuses;
        throw err;
      }
      for (let i = 0; i < 2; i++) {
        if (this.lookupDelayMs > 0) await new Promise(r => setTimeout(r, this.lookupDelayMs));
        let found: string | null;
        try {
          found = await this.lookup(cloid);
        } catch (e) {
          if (/refusé par Hyperliquid/.test(message(e))) {
            this.dropIntent(cloid);
            throw e;
          }
          throw new PendingOrderError(cloid, message(err));
        }
        if (found !== null) {
          this.dropIntent(cloid);
          return [{ found: `${found} (réponse perdue, ordre retrouvé)` }];
        }
      }
      throw new PendingOrderError(cloid, message(err));
    }
  }

  /** Options d'envoi communes : échéance de l'action (une action arrivée après est refusée par Hyperliquid). */
  private expiry(): { expiresAfter: number } {
    return { expiresAfter: Date.now() + ACTION_TTL_MS };
  }

  // ───────────── Clé de l'agent ─────────────

  /**
   * Écrit la connexion. La clé de l'agent n'y figure que chiffrée ; sans coffre, elle n'est pas écrite du tout (gardée
   * en mémoire pour la session). Les métadonnées de l'agent (adresse, compte, échéance) sont toujours écrites.
   */
  private store(): void {
    const { address, agentKey, agentAddress, agentFor, agentUntil } = this.saved;
    const out: Saved = { address, agentAddress, agentFor, agentUntil };
    if (agentKey && this.sealed?.key === agentKey) out.agentSealed = this.sealed.box;
    else if (!agentKey && this.keptBox) out.agentSealed = this.keptBox;
    // Jamais `agentKey` en clair (23/11/2026).
    try {
      if (address) localStorage.setItem(this.storeKey, JSON.stringify(out));
      else localStorage.removeItem(this.storeKey);
    } catch {
      /* stockage indisponible : la connexion durera le temps de la session */
    }
  }

  /**
   * Lecture de la clé de l'agent au chargement (E1, 23/11/2026) :
   *  - clé chiffrée : déchiffrée en mémoire ; illisible, elle n'est pas utilisable, mais l'agent reste connu (adresse,
   *    échéance) et révocable, et la forme chiffrée est gardée pour un prochain chargement ;
   *  - clé en clair (enregistrée avant le 23/11/2026) : chiffrée dans le coffre et le clair effacé ; sans coffre, elle
   *    est gardée en mémoire pour la session et le clair est effacé quand même.
   * Rend tout de suite, sans rien toucher, quand aucune clé n'est enregistrée.
   */
  private async loadKey(): Promise<void> {
    const box = asSealed(this.saved.agentSealed);
    const plain = this.saved.agentKey;
    delete this.saved.agentSealed;
    if (!box && !plain) return;
    this.keyPending = true;
    try {
      if (box) {
        const key = await openSecret(box, this.storeKey);
        if (key && /^0x[0-9a-fA-F]{64}$/.test(key)) {
          this.saved.agentKey = key as `0x${string}`;
          this.saved.agentAddress ??= privateKeyToAccount(key as `0x${string}`).address;
          this.sealed = { key, box };
        } else {
          delete this.saved.agentKey;
          this.sealed = null;
          this.keptBox = box;
          this.state.keyNote = KEY_LOST_NOTE;
          this.store();
        }
      } else if (plain && /^0x[0-9a-fA-F]{64}$/.test(plain)) {
        this.saved.agentAddress ??= privateKeyToAccount(plain).address;
        const sealedBox = await sealSecret(plain, this.storeKey);
        this.sealed = sealedBox ? { key: plain, box: sealedBox } : null;
        this.state.keyNote = sealedBox ? null : KEY_SESSION_NOTE;
        // Réécrit sans la clé en clair : chiffrée si le coffre fonctionne, absente sinon (gardée en mémoire).
        this.store();
      } else {
        delete this.saved.agentKey;
        this.store();
      }
    } finally {
      this.keyPending = false;
    }
  }

  /** Attend la fin de la lecture de la clé de l'agent (chargement de la page). */
  whenKeyReady(): Promise<void> {
    return this.keyLoad;
  }

  private emit(): void {
    this.onChange();
  }

  /**
   * Adresse du compte via MetaMask (aucune signature). `exclude` : comptes déjà suivis ailleurs. S'il y en a,
   * MetaMask ouvre son choix des comptes, et le premier compte autorisé qui n'est pas déjà suivi est retenu.
   */
  async connect(exclude: string[] = []): Promise<void> {
    const eth = provider();
    if (!eth) throw new Error('MetaMask n’est pas détecté dans ce navigateur.');
    this.listenWallet();
    const picked = exclude.length ? await pickAccounts(eth) : [];
    const accounts = await permittedAccounts(eth, picked);
    if (!accounts.length) throw new Error('Aucun compte autorisé dans MetaMask.');
    // Le compte affiché dans MetaMask d'abord, sinon le premier compte connecté qui n'est pas déjà suivi.
    const next = accounts.find(a => !exclude.includes(a));
    if (!next)
      throw new Error(
        `MetaMask ne donne que ${accounts.map(shortAddr).join(', ')}, déjà suivi. Dans la fenêtre de MetaMask, coche aussi l’autre adresse ; ou affiche-la dans MetaMask (choix du compte en haut), puis clique de nouveau sur « Connecter MetaMask ».`,
      );
    await this.watch(next);
  }

  /** Suivi d'une adresse saisie à la main (lecture seule). */
  async watchAddress(address: string, exclude: string[] = []): Promise<void> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) throw new Error('Adresse invalide : 0x suivi de 40 caractères hexadécimaux.');
    const a = getAddress(address.trim());
    if (exclude.includes(a)) throw new Error('Cette adresse est déjà suivie dans l’autre compte.');
    await this.watch(a);
  }

  /** Liste des agents autorisés du compte chez Hyperliquid (info `extraAgents`). */
  private async listAgents(user: string): Promise<ListedAgent[]> {
    return (await this.info.extraAgents({ user: user as `0x${string}` })) as ListedAgent[];
  }

  /**
   * Avant l'activation (23/11/2026) : ce que l'utilisateur doit savoir AVANT de signer. `sessionOnly` : coffre
   * indisponible, la clé ne sera gardée qu'en mémoire (à réautoriser après rechargement). `replaced` : agents
   * HyperChart déjà autorisés pour ce compte, qu'une nouvelle autorisation remplacera (`here` : celui de ce navigateur) ;
   * null si la liste n'a pas pu être lue.
   */
  async activationCheck(): Promise<{ sessionOnly: boolean; replaced: (ListedAgent & { here: boolean })[] | null }> {
    await this.keyLoad;
    const sessionOnly = !(await vaultAvailable());
    const user = this.state.address;
    let replaced: (ListedAgent & { here: boolean })[] | null = null;
    if (user)
      try {
        const mineAddr = (this.saved.agentAddress ?? '').toLowerCase();
        replaced = ourAgents(await this.listAgents(user)).map(a => ({ ...a, here: !!mineAddr && a.address.toLowerCase() === mineAddr }));
      } catch {
        replaced = null;
      }
    return { sessionOnly, replaced };
  }

  /**
   * Révoque chez Hyperliquid l'agent HyperChart de ce compte (une signature MetaMask du COMPTE : possible même si la
   * clé de l'agent est perdue), efface sa clé et ses métadonnées d'ici, puis revérifie la liste des agents du compte
   * (23/11/2026). Le compte reste suivi, en lecture seule. Rend le compte rendu de la vérification.
   */
  async revokeAgent(): Promise<{ verified: boolean | null; text: string }> {
    await this.keyLoad;
    const eth = provider();
    if (!eth) throw new Error('MetaMask n’est pas détecté dans ce navigateur.');
    const owner = await this.connectedOwner(eth);
    const old = this.saved.agentAddress ?? (this.saved.agentKey ? privateKeyToAccount(this.saved.agentKey).address : null);
    const replacement = await revokeNamedAgent(new ExchangeClient({ transport: this.http, wallet: metamaskSigner(eth, owner) }));
    this.saved = { address: this.saved.address };
    this.sealed = null;
    this.keptBox = null;
    this.verifiedAgent = null;
    if (this.state.keyNote === KEY_LOST_NOTE || this.state.keyNote === AGENT_GONE_NOTE) this.state.keyNote = null;
    this.store();
    this.setupAgent();
    this.emit();
    let list: ListedAgent[];
    try {
      list = await this.listAgents(owner);
    } catch {
      return {
        verified: null,
        text: 'Révocation signée. Vérification impossible pour l’instant : contrôle la liste des agents sur app.hyperliquid.xyz (More, API).',
      };
    }
    const stillOld = old ? agentStatus(list, old).valid : false;
    const others = ourAgents(list).filter(a => a.address.toLowerCase() !== replacement.toLowerCase());
    if (stillOld || others.length)
      return {
        verified: false,
        text: `Révocation signée, mais Hyperliquid liste toujours ${[...(stillOld && old ? [old] : []), ...others.map(a => a.address)].map(shortAddr).join(', ')} : retire-le depuis app.hyperliquid.xyz (More, API).`,
      };
    return { verified: true, text: 'Agent révoqué : il n’apparaît plus dans la liste des agents du compte chez Hyperliquid.' };
  }

  /** Oublie l'adresse et efface la clé de l'agent de ce navigateur, sans le révoquer chez Hyperliquid. */
  async forget(): Promise<void> {
    await this.keyLoad;
    await this.stop();
    this.acctGen++;
    this.saved = {};
    this.sealed = null;
    this.keptBox = null;
    this.verifiedAgent = null;
    this.store();
    try {
      localStorage.removeItem(this.intentsKey);
      localStorage.removeItem(this.legacyPendingKey);
    } catch {
      /* rien */
    }
    this.memIntents = [];
    this.exchange = null;
    this.lastCh = null;
    this.lastOrders = null;
    this.state = {
      ...this.state,
      address: null,
      trading: false,
      agentUntil: null,
      live: false,
      accountValue: null,
      withdrawable: null,
      marginUsed: null,
      position: null,
      positions: [],
      orders: [],
      otherOrders: [],
      fills: [],
      mark: null,
      orphanAgent: null,
      intents: [],
      trade: null,
      builderApproved: null,
      referredBy: null,
      error: null,
      keyNote: null,
      walletNote: null,
    };
    this.walletFrozen = false;
    this.emit();
  }

  private async stop(): Promise<void> {
    clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    clearInterval(this.staleTimer);
    this.staleTimer = undefined;
    this.midAt = 0;
    this.markAt = 0;
    const subs = [...this.subs, ...this.activeSubs];
    this.subs = [];
    this.activeSubs = [];
    await Promise.allSettled(subs.map(s => s.unsubscribe()));
    if (this.ws) {
      void this.ws.close?.();
      this.ws = null;
    }
  }

  private async watch(address: string): Promise<void> {
    // La connexion enregistrée n'est relue ou réécrite qu'une fois la clé de l'agent lue (déchiffrée ou migrée).
    await this.keyLoad;
    await this.stop();
    const gen = ++this.acctGen;
    // États bruts du compte précédent : `setCoin` ne doit jamais les réappliquer à celui-ci.
    this.lastCh = null;
    this.lastOrders = null;
    if (this.saved.address !== address) {
      this.saved = { address };
      this.sealed = null;
      this.keptBox = null;
      this.verifiedAgent = null;
      // Nouveau compte suivi, choisi par l'utilisateur : une remarque S-02 sur l'ancien n'a plus d'objet.
      this.walletFrozen = false;
      this.state.walletNote = null;
    }
    this.store();
    this.state = {
      ...this.state,
      address,
      trading: false,
      live: false,
      position: null,
      positions: [],
      orders: [],
      otherOrders: [],
      fills: [],
      mark: null,
      trade: null,
      builderApproved: null,
      referredBy: null,
      error: null,
    };
    this.showIntents();
    this.setupAgent();
    this.emit();
    void this.verifyAgent(gen);
    // Message ou réponse arrivé après un changement de compte : ignoré.
    const live = () => gen === this.acctGen;
    try {
      await this.loadAsset();
      const [ch, orders, fills] = await Promise.all([
        this.info.clearinghouseState({ user: address as `0x${string}` }),
        this.info.frontendOpenOrders({ user: address as `0x${string}` }),
        this.info.userFills({ user: address as `0x${string}` }),
      ]);
      if (!live()) return;
      this.applyClearinghouse(ch);
      this.applyOrders(orders);
      this.applyFills(fills, true);
      this.emit();
      this.ws = new WebSocketTransport();
      const sub = new SubscriptionClient({ transport: this.ws });
      const user = address as `0x${string}`;
      const subs = await Promise.all([
        sub.clearinghouseState({ user }, e => {
          if (!live()) return;
          this.applyClearinghouse(e.clearinghouseState);
          this.emit();
          this.scheduleSync();
        }),
        sub.openOrders({ user }, e => {
          if (!live()) return;
          this.applyOrders(e.orders);
          this.emit();
          this.scheduleSync();
        }),
        sub.userFills({ user }, e => {
          if (!live()) return;
          this.applyFills(e.fills, !!e.isSnapshot);
          this.emit();
        }),
        sub.allMids(e => {
          if (!live()) return;
          const m = +(e.mids as Record<string, string>)[this.coin];
          if (m > 0) {
            this.state.mid = m;
            this.midAt = Date.now();
            // Le flux reprend de lui-même après une coupure : la pastille redevient verte.
            this.state.live = true;
            this.emit();
          }
        }),
      ]);
      if (!live()) return void Promise.allSettled(subs.map(s => s.unsubscribe()));
      this.subs = subs;
      // Disponible pour trader et mark price : lus à part, pour qu'un refus de ces flux ne coupe pas le reste.
      void this.watchAvailable(user);
      void this.readPartner();
      this.state.live = true;
      this.state.error = null;
      // Flux muet (veille de l'ordinateur, réseau coupé) : l'état affiché n'est plus garanti, la pastille le dit.
      this.staleTimer = setInterval(() => {
        if (this.state.mark !== null && Date.now() - this.markAt > MARK_FRESH_MS) {
          this.state.mark = null;
          this.emit();
        }
        if (this.state.live && this.midAt > 0 && Date.now() - this.midAt > STALE_MS) {
          this.state.live = false;
          this.emit();
        }
      }, 5_000);
    } catch (err) {
      if (!live()) return;
      this.state.error = `Lecture du compte impossible : ${message(err)}`;
    }
    this.emit();
  }

  /**
   * Vérifie chez Hyperliquid l'agent enregistré pour ce compte (23/11/2026, `agentVerdict`) : valable, sa clé sert (et
   * son échéance est reprise de la liste) ; remplacé ou périmé, sa clé n'est pas réutilisée ; liste illisible : rien
   * n'est conclu. Un agent sans échéance locale (ancien) n'est utilisé qu'une fois confirmé ici.
   */
  private async verifyAgent(gen = this.acctGen): Promise<void> {
    const addr = this.saved.agentAddress;
    const user = this.state.address;
    if (!addr || !user || this.saved.agentFor !== user) return;
    const unconfirmed = this.saved.agentUntil === undefined && !!this.saved.agentKey;
    if (unconfirmed) {
      this.keyPending = true;
      this.emit();
    }
    try {
      let list: ListedAgent[];
      try {
        list = await this.listAgents(user);
      } catch {
        return;
      }
      if (gen !== this.acctGen || this.saved.agentAddress !== addr) return;
      const v = agentVerdict(list, addr, this.saved.agentUntil !== undefined);
      if (v.verdict === 'valid') {
        this.verifiedAgent = addr.toLowerCase();
        if (v.until !== null && this.saved.agentUntil !== v.until) {
          this.saved.agentUntil = v.until;
          this.store();
        }
      } else if (v.verdict === 'gone') {
        const hadKey = !!this.saved.agentKey;
        this.saved = { address: this.saved.address };
        this.sealed = null;
        this.keptBox = null;
        this.verifiedAgent = null;
        this.state.keyNote = hadKey ? AGENT_GONE_NOTE : null;
        this.store();
      }
    } finally {
      if (unconfirmed) this.keyPending = false;
      if (gen === this.acctGen) {
        this.setupAgent();
        this.emit();
      }
    }
  }

  private async watchAvailable(user: `0x${string}`): Promise<void> {
    const gen = this.coinGen;
    const acct = this.acctGen;
    const coin = this.coin;
    const live = () => gen === this.coinGen && acct === this.acctGen;
    try {
      const first = await this.info.activeAssetData({ user, coin });
      if (!live()) return;
      this.applyActive(first);
      this.emit();
      if (!this.ws) return;
      const sub = new SubscriptionClient({ transport: this.ws });
      const active = await sub.activeAssetData({ user, coin }, e => {
        if (!live()) return;
        this.applyActive(e);
        this.emit();
      });
      // Actif changé pendant l'abonnement : celui-ci ne sert plus.
      if (!live() || !this.ws) return void active.unsubscribe().catch(() => {});
      this.activeSubs.push(active);
      // Mark price : c'est lui qui déclenche les TP / SL chez Hyperliquid (23/11/2026).
      const ctx = await sub.activeAssetCtx({ coin }, e => {
        if (!live()) return;
        const m = +(e.ctx as { markPx?: string }).markPx!;
        if (m > 0) {
          this.state.mark = m;
          this.markAt = Date.now();
        }
      });
      if (!live() || !this.ws) return void ctx.unsubscribe().catch(() => {});
      this.activeSubs.push(ctx);
    } catch (err) {
      console.warn('[Hyperliquid] disponible pour trader ou mark price indisponible', err);
    }
  }

  private applyActive(d: {
    leverage: { type: string; value: number };
    maxTradeSzs: [string, string];
    availableToTrade: [string, string];
  }): void {
    this.state.trade = {
      avail: [+d.availableToTrade[0], +d.availableToTrade[1]],
      maxSz: [+d.maxTradeSzs[0], +d.maxTradeSzs[1]],
      leverage: d.leverage.value,
      cross: d.leverage.type === 'cross',
    };
  }

  /** Relit le disponible pour trader (après un changement de levier, par exemple). */
  async refreshAvailable(): Promise<void> {
    if (!this.state.address) return;
    try {
      const gen = this.coinGen;
      const acct = this.acctGen;
      const d = await this.info.activeAssetData({ user: this.state.address as `0x${string}`, coin: this.coin });
      if (gen !== this.coinGen || acct !== this.acctGen) return;
      this.applyActive(d);
      this.emit();
    } catch {
      /* le flux reprendra */
    }
  }

  /** Lit si le compte a autorisé le frais d'interface, et s'il a déjà un parrain. */
  async readPartner(): Promise<void> {
    const user = this.state.address as `0x${string}` | null;
    if (!user) return;
    const acct = this.acctGen;
    try {
      if (PARTNER.builder) {
        const max = await this.info.maxBuilderFee({ user, builder: PARTNER.builder.address });
        if (acct !== this.acctGen) return;
        this.state.builderApproved = Number(max) >= PARTNER.builder.fee;
      }
      if (PARTNER.referral) {
        const r = (await this.info.referral({ user })) as { referredBy: { code?: string } | null };
        if (acct !== this.acctGen) return;
        this.state.referredBy = r.referredBy ? (r.referredBy.code ?? 'parrainé') : 'aucun';
      }
      this.emit();
    } catch {
      /* relu à la prochaine connexion, ou avant le prochain ordre d'ouverture (`feeGate`) */
    }
  }

  /** Paramètre « builder » des ordres : le frais d'interface, si le compte l'a autorisé. */
  private builderParam(): { builder?: { b: `0x${string}`; f: number } } {
    return PARTNER.builder && this.state.builderApproved === true
      ? { builder: { b: PARTNER.builder.address, f: PARTNER.builder.fee } }
      : {};
  }

  /**
   * Autorise le frais d'interface (signature MetaMask du compte, comme l'agent) : Hyperliquid l'ajoute alors à
   * chaque ordre passé par cette interface, au plus au taux autorisé. Signé par le compte suivi, qui doit être
   * connecté à cette page dans MetaMask (`connectedOwner`, comme l'activation du trading, 23/11/2026).
   */
  async approveBuilder(): Promise<void> {
    if (!PARTNER.builder) return;
    const eth = provider();
    if (!eth) throw new Error('MetaMask n’est pas détecté dans ce navigateur.');
    if (!this.state.address) throw new Error('Aucun compte connecté.');
    const owner = await this.connectedOwner(eth);
    if (owner.toLowerCase() !== this.state.address.toLowerCase()) throw new Error('Le compte signataire n’est pas le compte suivi.');
    const acct = this.acctGen;
    const master = new ExchangeClient({ transport: this.http, wallet: metamaskSigner(eth, owner) });
    await master.approveBuilderFee({ maxFeeRate: feeRate(PARTNER.builder.fee), builder: PARTNER.builder.address });
    if (acct !== this.acctGen) return;
    this.state.builderApproved = true;
    this.emit();
  }

  /**
   * Ordre d'ouverture (23/11/2026) : le frais d'interface obligatoire doit être autorisé. État inconnu (pas encore lu,
   * lecture échouée) : relu ; toujours inconnu ou refusé, l'ouverture est refusée. Fermer, annuler et poser ou
   * déplacer une protection ne passent jamais par ici.
   */
  private async feeGate(): Promise<void> {
    if (!PARTNER.builder || !PARTNER.required) return;
    if (this.state.builderApproved === null) await this.readPartner();
    if (this.state.builderApproved === true) return;
    throw new Error(
      this.state.builderApproved === false
        ? 'Le frais d’interface n’est pas encore autorisé : bouton « Autoriser » dans la carte Hyperliquid. Fermer, annuler et poser un stop restent possibles.'
        : 'Autorisation du frais d’interface illisible pour l’instant (réseau ?) : aucun ordre d’ouverture n’est parti. Fermer, annuler et poser un stop restent possibles. Réessaie dans un instant.',
    );
  }

  /** Attribue le code de parrainage de l'interface (signé par l'agent, sans fenêtre MetaMask). */
  async useReferral(): Promise<void> {
    if (!PARTNER.referral) return;
    const { ex } = this.ready(this.coin);
    await ex.setReferrer({ code: PARTNER.referral });
    this.state.referredBy = PARTNER.referral;
    this.emit();
  }

  /** Nouvelle lecture du contrat en cours (une seule à la fois), lancée par `ready` quand il manque. */
  private assetRetry: Promise<void> | null = null;

  /**
   * Contrat absent au moment d'agir (lecture refusée après un `setCoin`, réseau coupé) : il est relu en arrière-plan,
   * une lecture à la fois. L'action en cours est refusée quand même ; la suivante trouvera le contrat chargé.
   */
  private retryAsset(): void {
    if (this.assetRetry) return;
    const gen = this.coinGen;
    const coin = this.coin;
    this.assetRetry = this.loadAsset()
      .then(
        () => {
          if (gen !== this.coinGen || this.asset?.coin !== coin) return;
          if (this.state.error?.startsWith(`Lecture du contrat ${coin} `)) this.state.error = null;
          this.emit();
        },
        err => console.warn(`[Hyperliquid] contrat ${coin} toujours illisible`, err),
      )
      .finally(() => {
        this.assetRetry = null;
      });
  }

  private async loadAsset(): Promise<void> {
    const coin = this.coin;
    if (this.asset?.coin === coin) return;
    this.universe ??= (await this.info.meta()).universe;
    // Actif changé pendant la lecture : c'est le `setCoin` suivant qui charge le sien.
    if (coin !== this.coin) return;
    const index = this.universe.findIndex(u => u.name === coin);
    if (index < 0) throw new Error(`contrat ${coin} introuvable`);
    const u = this.universe[index];
    this.asset = { coin, index, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage };
    this.state.maxLeverage = u.maxLeverage;
  }

  /**
   * Change l'actif du compte (changement d'actif sans rechargement de la page). Le compte, sa connexion et son agent
   * restent ouverts ; ce qui dépend de l'actif est remis à zéro ou relu : contrat (rang, décimales, levier maximal),
   * prix, disponible pour trader, position, ordres et exécutions. Le recalage TP / SL prévu pour l'ancien actif est
   * annulé. À appeler après `drain()` : aucune action de l'ancien actif n'est alors en cours.
   */
  async setCoin(coin: string): Promise<void> {
    if (coin === this.coin && this.asset?.coin === coin) return;
    this.coin = coin;
    const gen = ++this.coinGen;
    clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    this.syncFailed.clear();
    this.asset = null;
    this.state.mid = null;
    this.state.mark = null;
    this.midAt = 0;
    this.markAt = 0;
    this.state.trade = null;
    this.state.fills = [];
    this.state.error = null;
    if (this.lastCh) this.applyClearinghouse(this.lastCh);
    else this.state.position = null;
    if (this.lastOrders) this.applyOrders(this.lastOrders);
    else this.state.orders = [];
    this.emit();
    const old = this.activeSubs;
    this.activeSubs = [];
    for (const s of old) void s.unsubscribe().catch(() => {});
    const user = this.state.address as `0x${string}` | null;
    if (!user) return;
    try {
      await this.loadAsset();
      if (gen !== this.coinGen) return;
      const fills = await this.info.userFills({ user });
      if (gen !== this.coinGen) return;
      this.applyFills(fills, true);
    } catch (err) {
      if (gen === this.coinGen) this.state.error = `Lecture du contrat ${coin} impossible : ${message(err)}`;
    }
    if (gen !== this.coinGen) return;
    this.emit();
    if (this.subs.length) void this.watchAvailable(user);
  }

  /**
   * Gèle le compte (début d'un changement d'actif) et attend la fin des actions déjà commencées : une entrée suivie
   * de son TP et de son SL va à son terme sur l'actif pour lequel elle a été confirmée. Aucune nouvelle action ne
   * commence tant que `frozen` est vrai ; `unfreeze` (fin de la bascule, ou bascule abandonnée) les permet de nouveau.
   */
  async drain(): Promise<void> {
    this.frozen = true;
    while (this.running.size || this.syncing) {
      await Promise.allSettled([...this.running]);
      if (this.syncing) await new Promise(r => setTimeout(r, 50));
    }
  }

  unfreeze(): void {
    this.frozen = false;
    // Recalage TP / SL écarté pendant le gel (`scheduleSync` ne prévoit rien de gelé) : reprogrammé s'il manque.
    if (this.state.address) this.scheduleSync();
  }

  /**
   * Défense en profondeur, juste avant chaque envoi à Hyperliquid : l'actif visé par l'ordre doit être celui du
   * compte, celui de son contrat chargé et celui affiché. Sinon `CoinChangedError`, et rien ne part.
   */
  private guard(coin: string): void {
    const current = shown.coin;
    if (coin !== this.coin || coin !== current || this.asset?.coin !== coin) throw new CoinChangedError(coin, current);
  }

  /** Nom du verrou de trading du compte, partagé par tous les onglets de cette origine (Web Locks). */
  private lockName(): string | null {
    const a = this.state.address;
    return a ? `hyperchart-trade:${a.toLowerCase()}` : null;
  }

  /**
   * Exécute `fn` sous le verrou de trading du compte (23/11/2026) : deux onglets ne modifient jamais en même temps les
   * ordres d'un même compte (Web Locks API, nom incluant l'adresse). Attente bornée (`LOCK_WAIT_MS`) ; sans Web Locks
   * (navigateur ancien), repli sur le seul verrou de l'onglet. `ifAvailable` : rien n'est fait si le verrou est pris
   * (recalage automatique, refait plus tard) et la fonction rend undefined.
   */
  private async locked<T>(fn: () => Promise<T>, ifAvailable = false): Promise<T | undefined> {
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    const name = this.lockName();
    if (!locks?.request || !name) return fn();
    if (ifAvailable) return locks.request(name, { ifAvailable: true }, lock => (lock ? fn() : undefined));
    let granted = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LOCK_WAIT_MS);
    try {
      return await locks.request(name, { signal: ctrl.signal }, () => {
        granted = true;
        clearTimeout(timer);
        return fn();
      });
    } catch (err) {
      if (!granted)
        throw new Error('Un autre onglet de HyperChart envoie un ordre sur ce compte : rien n’a été envoyé. Réessaie dans un instant.');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Action de trading publique : refusée si le compte est gelé, sérialisée entre onglets (`locked`), suivie pour
   * `drain()`. `nested` : appelée par une action déjà en cours (TP et SL d'une entrée, fermeture au marché) : permise
   * même gelée, déjà suivie et déjà sous le verrou.
   */
  private act<T>(nested: boolean, fn: () => Promise<T>): Promise<T> {
    if (nested) return fn();
    if (this.frozen) return Promise.reject(new CoinChangedError(this.coin, `${shown.coin} (changement d’actif en cours)`));
    const job = this.locked(fn) as Promise<T>;
    this.running.add(job);
    const done = () => void this.running.delete(job);
    job.then(done, done);
    return job;
  }

  /** Ordres ouverts : ceux de l'actif affiché (trading) et, à part, ceux des autres actifs (affichage seul). */
  private applyOrders(raw: RawOrder[]): void {
    this.lastOrders = raw;
    this.state.orders = parseOrders(raw, this.coin);
    this.state.otherOrders = parseOtherOrders(raw, this.coin);
  }

  private applyClearinghouse(ch: {
    marginSummary: { accountValue: string; totalMarginUsed?: string };
    withdrawable: string;
    assetPositions: {
      position: {
        coin: string;
        szi: string;
        entryPx: string;
        liquidationPx: string | null;
        unrealizedPnl: string;
        returnOnEquity: string;
        leverage: { type: string; value: number };
        marginUsed: string;
        positionValue: string;
      };
    }[];
  }): void {
    this.lastCh = ch;
    this.state.accountValue = +ch.marginSummary.accountValue;
    this.state.withdrawable = +ch.withdrawable;
    const used = ch.marginSummary.totalMarginUsed;
    this.state.marginUsed = used === undefined || !Number.isFinite(+used) ? null : +used;
    // Toutes les positions du compte (panneau sous le graphique) ; celle de l'actif affiché reste à part dans
    // `position`, lue partout ailleurs (ticket, lignes du graphique, confirmations).
    type Raw = (typeof ch.assetPositions)[number]['position'];
    const positionOf = (p: Raw): HlPosition => ({
      size: +p.szi,
      entry: +p.entryPx,
      liquidation: p.liquidationPx === null ? null : +p.liquidationPx,
      pnl: +p.unrealizedPnl,
      roe: +p.returnOnEquity,
      leverage: p.leverage.value,
      cross: p.leverage.type === 'cross',
      margin: +p.marginUsed,
      value: +p.positionValue,
    });
    const open = ch.assetPositions.map(a => a.position).filter(p => +p.szi !== 0);
    this.state.positions = open.map(p => ({ coin: p.coin, ...positionOf(p) }));
    const p = open.find(x => x.coin === this.coin);
    this.state.position = p ? positionOf(p) : null;
  }

  private applyFills(
    raw: { coin: string; px: string; sz: string; side: 'B' | 'A'; time: number; dir: string; closedPnl: string }[],
    snapshot: boolean,
  ): void {
    const fresh = raw
      .filter(f => f.coin === this.coin)
      .map(f => ({ t: Math.floor(f.time / 1000), price: +f.px, size: +f.sz, buy: f.side === 'B', dir: f.dir, pnl: +f.closedPnl }));
    const all = snapshot ? fresh : [...this.state.fills, ...fresh];
    this.state.fills = all.sort((a, b) => a.t - b.t).slice(-500);
  }

  // ───────────── Trading ─────────────

  private agentExpired(): boolean {
    return this.saved.agentUntil !== undefined && Date.now() >= this.saved.agentUntil;
  }

  /**
   * Agent de ce compte utilisable pour trader : clé en mémoire, autorisé pour le compte suivi, et soit avec une
   * échéance locale connue, soit confirmé par la liste d'Hyperliquid (ancien agent sans échéance, 23/11/2026).
   */
  private agentUsable(): boolean {
    const s = this.saved;
    if (!s.agentKey || s.agentFor !== this.state.address) return false;
    return s.agentUntil !== undefined || (!!s.agentAddress && this.verifiedAgent === s.agentAddress.toLowerCase());
  }

  private setupAgent(): void {
    if (this.agentExpired() && (this.saved.agentKey || this.saved.agentAddress || this.keptBox)) {
      // Agent périmé : Hyperliquid le refuse, plus rien à révoquer ; clé et métadonnées sont effacées du stockage.
      this.saved = { address: this.saved.address };
      this.sealed = null;
      this.keptBox = null;
      this.store();
    }
    const s = this.saved;
    if (this.agentUsable()) {
      this.exchange = new ExchangeClient({ transport: this.http, wallet: privateKeyToAccount(s.agentKey!) });
      this.state.trading = true;
      this.state.agentUntil = s.agentUntil ?? null;
      this.state.orphanAgent = null;
    } else {
      this.exchange = null;
      this.state.trading = false;
      this.state.agentUntil = null;
      // Plus de clé : la remarque « en mémoire seulement » n'a plus d'objet (celle d'une clé perdue reste affichée).
      if (this.state.keyNote === KEY_SESSION_NOTE && !s.agentKey) this.state.keyNote = null;
      // Agent connu sans clé utilisable ici : toujours autorisé chez Hyperliquid, donc à révoquer.
      const known = !s.agentKey && (s.agentAddress || this.keptBox) && (!s.agentFor || s.agentFor === this.state.address);
      this.state.orphanAgent = known ? { address: s.agentAddress ?? null, until: s.agentUntil ?? null } : null;
    }
  }

  /**
   * Compte qui signe dans MetaMask : le compte suivi, qui doit être connecté à cette page (pas forcément le compte
   * affiché) ; sinon MetaMask propose de choisir les comptes connectés. Sans compte suivi, le compte affiché.
   */
  private async connectedOwner(eth: EIP1193Provider): Promise<string> {
    let accounts = await permittedAccounts(eth);
    const wanted = this.state.address;
    if (wanted && !accounts.includes(wanted)) {
      accounts = await permittedAccounts(eth, await pickAccounts(eth));
      if (!accounts.includes(wanted))
        throw new Error(
          `le compte ${shortAddr(wanted)} n’est pas connecté à cette page dans MetaMask : coche-le dans la fenêtre de MetaMask, ou affiche-le dans MetaMask, puis réessaie`,
        );
    }
    const owner = wanted ?? accounts[0];
    if (!owner) throw new Error('Aucun compte autorisé dans MetaMask.');
    // Le compte suivi est de nouveau connecté à la page (choisi par l'utilisateur au besoin) : gel S-02 levé.
    if (this.walletFrozen || this.state.walletNote) {
      this.walletFrozen = false;
      this.state.walletNote = null;
    }
    return owner;
  }

  /**
   * Autorise un portefeuille agent créé ici : une signature MetaMask, une seule fois. L'agent peut trader mais
   * ne peut pas retirer de fonds. Rien n'est changé localement avant que la signature soit acceptée par Hyperliquid
   * (23/11/2026) : un échec laisse l'état d'avant intact. Le frais d'interface est une seconde signature, à part : son
   * refus n'annule pas l'agent. Rend le résultat de chaque signature.
   */
  async enableTrading(): Promise<{ agent: string; fee: string | null }> {
    await this.keyLoad;
    const eth = provider();
    if (!eth) throw new Error('MetaMask n’est pas détecté dans ce navigateur.');
    // L'autorisation est signée par le compte suivi lui-même.
    const owner = await this.connectedOwner(eth);
    if (owner !== this.state.address) await this.watch(owner);
    const key = generatePrivateKey();
    // Chiffrée avant tout : la clé n'atteint jamais le stockage en clair. Sans coffre, elle restera en mémoire.
    const box = await sealSecret(key, this.storeKey);
    const agent = privateKeyToAccount(key);
    const wallet = metamaskSigner(eth, owner);
    const master = new ExchangeClient({ transport: this.http, wallet });
    const until = Date.now() + AGENT_TTL_MS;
    await master.approveAgent({ agentAddress: agent.address, agentName: agentName(until) });
    // Signature acceptée : la nouvelle clé remplace l'ancienne, d'un seul tenant.
    this.saved = { address: owner, agentKey: key, agentAddress: agent.address, agentFor: owner, agentUntil: until };
    this.sealed = box ? { key, box } : null;
    this.keptBox = null;
    this.verifiedAgent = agent.address.toLowerCase();
    this.state.keyNote = box ? null : KEY_SESSION_NOTE;
    this.store();
    this.setupAgent();
    this.emit();
    const agentText = box
      ? 'Agent autorisé : les ordres partent après confirmation, sans nouvelle signature MetaMask.'
      : 'Agent autorisé pour cette session seulement (clé gardée en mémoire) : après un rechargement, il faudra réautoriser.';
    // Frais d'interface : seconde signature, dans la foulée, si l'interface en demande un et qu'il manque.
    if (!PARTNER.builder) return { agent: agentText, fee: null };
    await this.readPartner();
    if (this.state.builderApproved === true) return { agent: agentText, fee: 'Frais d’interface déjà autorisé.' };
    try {
      await this.approveBuilder();
      return { agent: agentText, fee: 'Frais d’interface autorisé.' };
    } catch (err) {
      return {
        agent: agentText,
        fee: `Frais d’interface NON autorisé (${message(err)})${PARTNER.required ? ' : les ouvertures restent bloquées jusqu’à son autorisation (bouton « Autoriser ») ; fermer, annuler et poser un stop restent possibles.' : '.'}`,
      };
    }
  }

  /** `auto` : recalage automatique des protections (jamais gelé par S-02 : il protège la position du compte suivi). */
  private ready(coin: string, auto = false): { ex: ExchangeClient; asset: Asset } {
    if (this.exchange && this.agentExpired()) {
      this.setupAgent();
      this.emit();
      throw new Error('L’autorisation de trading a expiré : réactive le trading dans la carte Hyperliquid.');
    }
    if (!this.exchange) throw new Error('Trading non activé.');
    // Audit S-02 : MetaMask a basculé sur un autre compte que celui suivi ; rien ne part sans confirmation.
    if (this.walletFrozen && !auto)
      throw new Error(
        `MetaMask affiche un autre compte que ${shortAddr(this.state.address ?? '')} : rien n’a été envoyé. Reviens sur ce compte dans MetaMask, ou confirme « Continuer avec ${shortAddr(this.state.address ?? '')} » dans la carte Hyperliquid.`,
      );
    // Contrat de l'actif pas encore lu (juste après un changement d'actif, ou lecture refusée) : rien ne part.
    if (!this.asset) {
      this.retryAsset();
      throw new Error(`Contrat ${this.coin} en cours de lecture : réessaie dans un instant.`);
    }
    if (assetFallback)
      throw new Error(
        `L’actif ${assetFallback} n’a pas pu être chargé : l’affichage est passé sur ${shown.coin}. Aucun ordre ne part sur un autre actif que celui demandé : choisis ${shown.coin} explicitement dans la liste des actifs, ou recharge la page.`,
      );
    // Le frais d'interface ne bloque plus ici (23/11/2026) : seulement les ouvertures (`feeGate`).
    this.guard(coin);
    return { ex: this.exchange, asset: this.asset };
  }

  /** Prix de référence d'un TP / SL : mark price s'il est frais, milieu du carnet sinon (`triggerRef`). */
  triggerPrice(): number | null {
    return triggerRef(this.state);
  }

  /**
   * Garantit un prix, une position et des ordres à jour avant de préparer ou d'envoyer un ordre. Position et ordres
   * sont toujours relus par HTTP : un prix frais ne dit rien du compte (flux distincts ; position modifiée depuis un
   * autre appareil). Le prix n'est relu que s'il a plus de quelques secondes. Si la relecture échoue, une erreur est
   * levée et aucun ordre ne part.
   */
  async fresh(): Promise<void> {
    const address = this.state.address;
    if (!address) return;
    const user = address as `0x${string}`;
    const priceStale = Date.now() - this.midAt > FRESH_MS;
    const gen = this.coinGen;
    const acct = this.acctGen;
    try {
      const [mids, ch, orders] = await Promise.all([
        priceStale ? this.info.allMids() : null,
        this.info.clearinghouseState({ user }),
        this.info.frontendOpenOrders({ user }),
      ]);
      // Actif changé pendant la lecture : rien n'est retenu de cette réponse, lue pour l'ancien.
      if (this.coinGen !== gen) throw new Error('actif changé pendant la relecture');
      // Le compte a pu changer pendant la lecture (autre onglet) : c'est cette réponse qui fait foi.
      if (this.state.address !== address || this.acctGen !== acct) throw new Error('compte changé pendant la relecture');
      if (mids) {
        const m = +(mids as Record<string, string>)[this.coin];
        if (!(m > 0)) throw new Error('prix absent de la réponse');
        this.state.mid = m;
        this.midAt = Date.now();
      }
      if (this.state.mark !== null && Date.now() - this.markAt > MARK_FRESH_MS) this.state.mark = null;
      this.applyClearinghouse(ch);
      this.applyOrders(orders);
      this.emit();
    } catch (err) {
      throw new Error(
        `${priceStale ? 'Prix Hyperliquid périmé (flux coupé) et relecture' : 'Relecture du compte (position, ordres)'} impossible : rien n’a été envoyé. Vérifie la connexion puis réessaie (${message(err)}).`,
      );
    }
  }

  // Chaque action de trading reçoit `coin`, l'actif que l'utilisateur avait sous les yeux en la confirmant :
  // `ready(coin)` puis `guard(coin)` juste avant chaque envoi refusent tout écart avec l'actif du compte et l'actif
  // affiché (changement d'actif sans rechargement). Les méthodes `…Now` sont les mêmes actions, appelées par une
  // action déjà en cours (TP et SL d'une entrée, fermeture au marché) : elles ne sont ni gelées ni suivies à part.

  /** Change le levier de l'actif affiché (et le mode croisé ou isolé). */
  setLeverage(coin: string, leverage: number, cross: boolean): Promise<void> {
    return this.act(false, async () => {
      const { ex, asset } = this.ready(coin);
      await ex.updateLeverage({ asset: asset.index, isCross: cross, leverage: Math.round(leverage) }, this.expiry());
    });
  }

  /** `expectedMid` : prix montré dans la confirmation ; s'il est donné, un écart de plus de `CONFIRM_DRIFT` refuse l'ordre. */
  market(coin: string, buy: boolean, size: number, reduceOnly = false, expectedMid?: number | null): Promise<string> {
    return this.act(false, () => this.marketNow(coin, buy, size, reduceOnly, expectedMid));
  }

  private async marketNow(coin: string, buy: boolean, size: number, reduceOnly = false, expectedMid?: number | null): Promise<string> {
    const { ex, asset } = this.ready(coin);
    if (!reduceOnly) await this.feeGate();
    await this.fresh();
    if (!this.state.mid) throw new Error('Prix Hyperliquid inconnu pour l’instant.');
    checkConfirmedPrice(expectedMid, this.state.mid);
    const st = await this.send(
      ex,
      {
        orders: [{ ...marketWire(asset, buy, size, this.state.mid, reduceOnly), c: entryCloid() }],
        grouping: 'na',
        ...this.builderParam(),
      },
      coin,
    );
    return describe(st[0]);
  }

  limit(coin: string, buy: boolean, size: number, price: number): Promise<string> {
    return this.act(false, async () => {
      const { ex, asset } = this.ready(coin);
      await this.feeGate();
      const st = await this.send(
        ex,
        {
          orders: [{ ...limitWire(asset, buy, size, price), c: entryCloid() }],
          grouping: 'na',
          ...this.builderParam(),
        },
        coin,
      );
      return describe(st[0]);
    });
  }

  /**
   * Prévoit un recalage des TP / SL si la position (renforcée par un long ou un short exécuté, ou allégée) ne
   * correspond plus à leur taille. Seulement avec le trading activé ; rien n'est envoyé si tout est déjà juste.
   */
  private scheduleSync(): void {
    if (!this.exchange || !this.asset || this.syncing || this.frozen) return;
    if (!protectionResizes(this.state.orders, this.state.position?.size ?? 0, this.asset.szDecimals).length) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.syncProtections(), this.syncDelayMs);
  }

  /**
   * Recale le TP complet et les TP / SL de taille fixe posés par HyperChart sur la position du moment, relue juste
   * avant (jamais sur un état périmé). Chaque ordre garde son prix, sa nature et son identifiant (`rewire`) ; seule sa
   * taille change. Un refus n'est pas retenté en boucle. Sous le verrou du compte, sans l'attendre : si un autre onglet
   * envoie un ordre, le recalage est refait au prochain changement.
   */
  async syncProtections(): Promise<void> {
    // Gelé (changement d'actif en cours) : aucun recalage ne commence ; celui de l'actif suivant se fera au besoin.
    if (this.syncing || this.frozen) return;
    this.syncing = true;
    let skipped = false;
    try {
      skipped = (await this.locked(async () => (await this.syncNow(), true), true)) === undefined;
    } catch {
      // Trading non activé ou compte illisible : rien n'est touché, le prochain changement relancera le recalage.
    } finally {
      this.syncing = false;
    }
    // Verrou pris par un envoi (cet onglet ou un autre) : recalage reprogrammé, sur la position relue d'ici là.
    if (skipped) this.scheduleSync();
  }

  private async syncNow(): Promise<void> {
    const coin = this.coin;
    const { ex, asset } = this.ready(coin, true);
    await this.fresh();
    const pos = this.state.position;
    if (!pos) return;
    const keyOf = (oid: number, size: number) => `${oid}:${size}`;
    const todo = protectionResizes(this.state.orders, pos.size, asset.szDecimals).filter(
      r => !this.syncFailed.has(keyOf(r.order.oid, r.size)),
    );
    if (!todo.length) return;
    const done: string[] = [];
    const failed: string[] = [];
    for (const { order, size } of todo) {
      try {
        const wire = rewire(asset, order, order.price, size);
        this.guard(coin);
        await ex.modify({ oid: order.oid, order: wire }, this.expiry());
        done.push(`${order.label} ${formatSize(size, asset.szDecimals)} ${asset.coin}`);
      } catch (err) {
        this.syncFailed.add(keyOf(order.oid, size));
        failed.push(`${order.label} (${message(err)})`);
      }
    }
    if (done.length)
      this.onProtectSync(
        `Protections recalées sur la position de ${formatSize(Math.abs(pos.size), asset.szDecimals)} ${asset.coin} : ${done.join(', ')}.`,
        true,
      );
    if (failed.length) this.onProtectSync(`Recalage impossible : ${failed.join(', ')}. Vérifie ou repose ces protections.`, false);
  }

  /** Répartition des TP limite de la position (complet, partiels, taille du complet). */
  tpSplit(size = Math.abs(this.state.position?.size ?? 0)) {
    return tpSplit(this.state.orders, size, this.szDecimals);
  }

  /**
   * Pose (ou déplace) le take profit complet ou le stop loss de la position. Le take profit complet est un ordre
   * limite réduisant seulement pour ce que les TP partiels laissent de la position : partiels et complet ensemble
   * ferment exactement la position, sans la dépasser. Le stop loss reste un ordre déclenché au marché, rattaché à
   * la position, avec un identifiant client propre (23/11/2026). `target` donne le sens et la taille quand la position
   * vient de changer et que l'état ne le montre pas encore. Jamais bloqué par le frais d'interface ni par un ordre en
   * suspens : une protection ne fait que réduire le risque.
   */
  protect(coin: string, tpsl: 'tp' | 'sl', trigger: number): Promise<string> {
    return this.act(false, () => this.protectNow(coin, tpsl, trigger));
  }

  private async protectNow(coin: string, tpsl: 'tp' | 'sl', trigger: number, target?: { long: boolean; size: number }): Promise<string> {
    const { ex, asset } = this.ready(coin);
    // Sans `target`, la taille et le sens viennent de l'état : il doit être à jour.
    if (!target) await this.fresh();
    const pos = this.state.position;
    if (!pos && !target) throw new Error('Aucune position ouverte.');
    const long = target ? target.long : pos!.size > 0;
    const size = target ? target.size : Math.abs(pos!.size);
    if (tpsl === 'sl') {
      const previous = this.state.orders.filter(o => o.kind === 'sl');
      const st = await this.send(
        ex,
        {
          orders: [{ ...triggerWire(asset, long, size, trigger, 'sl'), c: protectCloid('sl') }],
          grouping: 'positionTpsl',
          ...this.builderParam(),
        },
        coin,
      );
      const text = describe(st[0]);
      // Le nouveau stop est en place : l'ancien est retiré (la position ne reste jamais sans stop). Si ce retrait
      // échoue, le nouveau stop n'en est pas moins posé : c'est ce qui est dit, pas « échec ».
      if (previous.length) {
        try {
          this.guard(coin);
          await ex.cancel({ cancels: previous.map(o => ({ a: asset.index, o: o.oid })) }, this.expiry());
        } catch (err) {
          return `${text}. L’ancien stop n’a pas pu être retiré (${message(err)}) : annule-le depuis la liste des ordres`;
        }
      }
      return text;
    }
    const { full, partialSize, fullSize } = tpSplit(this.state.orders, size, asset.szDecimals);
    // Tous les contrôles avant le moindre effet sur le compte : un refus ici laisse les protections intactes.
    if (!(fullSize > 0)) throw new Error('Les TP partiels couvrent déjà toute la position : déplace ou annule l’un d’eux.');
    // Anciens TP déclenchés (au marché) : remplacés par le TP limite, mais retirés seulement une fois celui-ci posé.
    const triggered = this.state.orders.filter(o => o.kind === 'tp' && o.trigger);
    const wire = {
      ...tpLimitWire(asset, long, fullSize, trigger),
      c: (full?.tpRole === 'full' ? full.cloid : tpCloid('full')) as `0x${string}`,
    };
    const rest = partialSize > 0 ? ` (le reste après ${formatSize(partialSize, asset.szDecimals)} ${asset.coin} de TP partiels)` : '';
    let text: string;
    if (full) {
      this.guard(coin);
      await ex.modify({ oid: full.oid, order: wire }, this.expiry());
      text = `Take profit limite déplacé, ${formatSize(fullSize, asset.szDecimals)} ${asset.coin}${rest}`;
    } else {
      const st = await this.send(ex, { orders: [wire], grouping: 'na', ...this.builderParam() }, coin);
      text = `${describe(st[0])} : TP limite de ${formatSize(fullSize, asset.szDecimals)} ${asset.coin}${rest}`;
    }
    if (triggered.length) {
      try {
        this.guard(coin);
        await ex.cancel({ cancels: triggered.map(o => ({ a: asset.index, o: o.oid })) }, this.expiry());
      } catch (err) {
        return `${text}. L’ancien TP déclenché n’a pas pu être retiré (${message(err)}) : annule-le depuis la liste des ordres`;
      }
    }
    return text;
  }

  /**
   * Take profit partiel : ordre limite réduisant seulement pour une part fixe de la position, en plus des autres.
   * Le TP complet, s'il existe, est réduit d'autant d'abord (annulé s'il ne reste rien à couvrir), pour que le total
   * des TP ne dépasse jamais la position ; si le partiel est refusé, le TP complet reprend sa taille.
   */
  partialTp(coin: string, price: number, size: number): Promise<string> {
    return this.act(false, () => this.partialTpNow(coin, price, size));
  }

  private async partialTpNow(coin: string, price: number, size: number): Promise<string> {
    const { ex, asset } = this.ready(coin);
    await this.fresh();
    const pos = this.state.position;
    if (!pos) throw new Error('Aucune position ouverte.');
    const long = pos.size > 0;
    const k = 10 ** asset.szDecimals;
    const { full, partialSize } = tpSplit(this.state.orders, Math.abs(pos.size), asset.szDecimals);
    const room = Math.floor((Math.abs(pos.size) - partialSize) * k + 1e-6) / k;
    const qty = Math.min(Math.floor(size * k + 1e-6) / k, room);
    if (!(qty > 0)) throw new Error('Les TP partiels couvrent déjà toute la position.');
    const left = Math.floor((room - qty) * k + 1e-6) / k;
    let fullNote = '';
    let undo: (() => Promise<unknown>) | null = null;
    if (full) {
      const fullWire = (sz: number) => ({
        ...tpLimitWire(asset, long, sz, full.price),
        c: (full.tpRole === 'full' ? full.cloid : tpCloid('full')) as `0x${string}`,
      });
      this.guard(coin);
      if (left * full.price >= MIN_NOTIONAL) {
        await ex.modify({ oid: full.oid, order: fullWire(left) }, this.expiry());
        fullNote = `, TP complet ramené à ${formatSize(left, asset.szDecimals)} ${asset.coin}`;
        undo = () => (this.guard(coin), ex.modify({ oid: full.oid, order: fullWire(full.size) }, this.expiry()));
      } else {
        await ex.cancel({ cancels: [{ a: asset.index, o: full.oid }] }, this.expiry());
        fullNote = ', TP complet annulé (plus rien à couvrir)';
        undo = async () =>
          describe((await this.send(ex, { orders: [fullWire(full.size)], grouping: 'na', ...this.builderParam() }, coin))[0]);
      }
    }
    try {
      const st = await this.send(
        ex,
        {
          orders: [{ ...tpLimitWire(asset, long, qty, price), c: tpCloid('partial') }],
          grouping: 'na',
          ...this.builderParam(),
        },
        coin,
      );
      return `${describe(st[0])} : TP partiel de ${formatSize(qty, asset.szDecimals)} ${asset.coin}${fullNote}`;
    } catch (err) {
      // Le TP complet a déjà été réduit ou annulé : s'il ne reprend pas sa taille, la position est moins couverte
      // qu'avant, et l'utilisateur doit le savoir (pas seulement que le partiel a échoué).
      if (undo) {
        try {
          await undo();
        } catch (e) {
          throw new Error(
            `TP partiel refusé (${message(err)}) ET le TP complet n’a pas pu être rétabli (${message(e)}) : la position n’est plus couverte comme avant, repose le TP complet.`,
          );
        }
      }
      throw err;
    }
  }

  /**
   * Entrée avec take profit et stop loss facultatifs.
   *  - Limite : un seul envoi groupé ; TP et SL restent EN ATTENTE jusqu'à l'exécution complète de l'entrée (ils ne
   *    protègent pas une exécution partielle, et annuler le reste de l'entrée les annule).
   *  - Marché : l'entrée, puis, sur la taille de la position obtenue, le TP en ordre limite réduisant seulement et
   *    le SL déclenché. Si l'un des deux échoue, l'entrée reste faite et l'erreur est remontée.
   */
  enter(
    coin: string,
    buy: boolean,
    size: number,
    opts: { price?: number | null; tp?: number | null; sl?: number | null; reduce?: boolean; expectedMid?: number | null },
  ): Promise<string> {
    return this.act(false, () => this.enterNow(coin, buy, size, opts));
  }

  private async enterNow(
    coin: string,
    buy: boolean,
    size: number,
    opts: { price?: number | null; tp?: number | null; sl?: number | null; reduce?: boolean; expectedMid?: number | null },
  ): Promise<string> {
    const { ex, asset } = this.ready(coin);
    if (opts.reduce) {
      // Réduire seulement : ni TP ni SL rattachés, l'ordre ne peut que diminuer la position.
      if (opts.price) {
        const st = await this.send(
          ex,
          {
            orders: [{ ...limitWire(asset, buy, size, opts.price, true), c: entryCloid() }],
            grouping: 'na',
            ...this.builderParam(),
          },
          coin,
        );
        return describe(st[0]);
      }
      return this.marketNow(coin, buy, size, true, opts.expectedMid);
    }
    await this.feeGate();
    if (opts.price) {
      const orders = bracketWires(asset, buy, size, opts.price, opts.tp, opts.sl);
      // Un identifiant client pour chaque ordre du groupe (23/11/2026) : l'entrée, et ses TP / SL rattachés.
      orders[0] = { ...orders[0], c: entryCloid() };
      for (let i = 1; i < orders.length; i++) {
        const t = orders[i].t;
        orders[i] = { ...orders[i], c: protectCloid('trigger' in t ? t.trigger.tpsl : 'tp') };
      }
      const statuses = await this.send(ex, { orders, grouping: orders.length > 1 ? 'normalTpsl' : 'na', ...this.builderParam() }, coin);
      return describeBracket(statuses, orders.length, !!opts.tp, !!opts.sl);
    }
    await this.fresh();
    if (!this.state.mid) throw new Error('Prix Hyperliquid inconnu pour l’instant.');
    // Prix montré dans la confirmation : un saut depuis refuse l'ordre avant tout envoi (audit H-02).
    checkConfirmedPrice(opts.expectedMid, this.state.mid);
    const before = this.state.position?.size ?? 0;
    // Le TP et le SL d'une entrée au marché sont posés sur la position obtenue. Si l'ordre ne fait que réduire la
    // position ouverte, ils seraient ceux du sens opposé appliqués à ce qu'il en reste : refusé avant tout envoi.
    if ((opts.tp || opts.sl) && before !== 0 && before > 0 !== buy && size <= Math.abs(before) + 1e-12)
      throw new Error(
        'Cet ordre réduit la position ouverte : le TP / SL du ticket ne peut pas s’y appliquer. Retire-le du ticket, ou pose-le sur la position (clic droit sur le graphique).',
      );
    const [st] = await this.send(
      ex,
      {
        orders: [{ ...marketWire(asset, buy, size, this.state.mid), c: entryCloid() }],
        grouping: 'na',
        ...this.builderParam(),
      },
      coin,
    );
    const text = describe(st);
    // Réponse perdue puis ordre retrouvé : la taille exécutée n'est pas connue, les protections ne sont pas posées
    // à l'aveugle ; c'est dit comme une position sans protection, pas comme un échec (ne pas renvoyer l'ordre).
    if (st && typeof st === 'object' && 'found' in st && (opts.tp || opts.sl) && /exécuté/.test(text))
      throw new UnprotectedError(text, ['TP / SL non posés : taille exécutée inconnue après la réponse perdue']);
    const filled = st && typeof st === 'object' && 'filled' in st ? +(st as { filled: { totalSz: string } }).filled.totalSz : 0;
    if (!filled || (!opts.tp && !opts.sl)) return text;
    const after = before + (buy ? filled : -filled);
    if (Math.abs(after) < 1e-9) return text;
    const target = { long: after > 0, size: Math.abs(after) };
    // À partir d'ici l'entrée est exécutée : un refus du SL ou du TP ne doit pas être présenté comme un échec de
    // l'ordre (la position est ouverte, la renvoyer la doublerait), mais comme une position sans protection.
    const done: string[] = [text];
    const missing: string[] = [];
    if (opts.sl) {
      try {
        await this.protectNow(coin, 'sl', opts.sl, target);
        done.push('SL posé');
      } catch (err) {
        missing.push(`STOP LOSS NON POSÉ (${message(err)})`);
      }
    }
    if (opts.tp) {
      try {
        await this.protectNow(coin, 'tp', opts.tp, target);
        done.push('TP limite posé');
      } catch (err) {
        missing.push(`take profit non posé (${message(err)})`);
      }
    }
    if (missing.length) throw new UnprotectedError(done.join(' · '), missing);
    return done.join(' · ');
  }

  /** Déplace un ordre ouvert (glissé sur le graphique). */
  move(coin: string, order: HlOrder, price: number): Promise<void> {
    return this.act(false, () => this.moveNow(coin, order, price));
  }

  /**
   * Déplacement (23/11/2026) : l'ordre est d'abord relu, retrouvé par son numéro (ou son identifiant client) ; c'est
   * cet état courant, pas celui capturé au début du glissement, qui est re-décrit au nouveau prix (`rewire` : nature,
   * durée de validité, réduisant seulement et quantité restante conservés). Ordre disparu ou changé : rien ne part.
   */
  private async moveNow(coin: string, order: HlOrder, price: number): Promise<void> {
    const { ex, asset } = this.ready(coin);
    await this.fresh();
    const cur =
      this.state.orders.find(o => o.oid === order.oid) ?? (order.cloid ? this.state.orders.find(o => o.cloid === order.cloid) : undefined);
    if (!cur) throw new Error('Cet ordre n’est plus ouvert (exécuté, annulé ou remplacé) : rien n’a été déplacé.');
    if (cur.kind !== order.kind || cur.buy !== order.buy || cur.trigger !== order.trigger)
      throw new Error('Cet ordre a changé depuis le début du déplacement : rien n’a été déplacé. Vérifie-le et recommence.');
    const pos = this.state.position;
    let size = cur.size;
    if (cur.kind === 'tp' && !cur.trigger) {
      // TP limite : un partiel garde sa taille ; le complet reprend ce que les partiels laissent de la position
      // (au cas où elle a été renforcée ou allégée).
      const split = tpSplit(this.state.orders, Math.abs(pos?.size ?? cur.size), asset.szDecimals);
      if (split.full === cur && pos && split.fullSize > 0) size = split.fullSize;
    } else if (cur.position && pos) size = Math.abs(pos.size);
    const wire = rewire(asset, cur, price, size);
    this.guard(coin);
    await ex.modify({ oid: cur.oid, order: wire }, this.expiry());
  }

  cancel(coin: string, order: HlOrder): Promise<void> {
    return this.act(false, async () => {
      const { ex, asset } = this.ready(coin);
      await ex.cancel({ cancels: [{ a: asset.index, o: order.oid }] }, this.expiry());
    });
  }

  /** Ferme une part (0 à 1) de la position au marché. */
  close(coin: string, fraction: number): Promise<string> {
    return this.act(false, async () => {
      this.ready(coin);
      // La taille à fermer se lit sur la position : elle doit être celle du moment.
      await this.fresh();
      const pos = this.state.position;
      if (!pos) throw new Error('Aucune position ouverte.');
      const size = Math.abs(pos.size) * Math.min(1, Math.max(0, fraction));
      return this.marketNow(coin, pos.size < 0, size, true);
    });
  }

  get szDecimals(): number {
    return this.asset?.szDecimals ?? 5;
  }
}

/**
 * Signataire MetaMask pour l'autorisation de l'agent. viem refuse, avant même de solliciter le portefeuille, le
 * nom de type « HyperliquidTransaction:ApproveAgent » qu'exige Hyperliquid (deux-points interdit par sa
 * validation) : la signature est donc demandée directement à MetaMask (eth_signTypedData_v4), comme le fait
 * l'interface d'Hyperliquid. L'objet a la forme d'un compte viem JSON-RPC, reconnue par le SDK.
 */
export function metamaskSigner(eth: EIP1193Provider, owner: string) {
  return {
    async signTypedData(args: { domain: unknown; types: unknown; primaryType: string; message: unknown }): Promise<`0x${string}`> {
      const json = JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      return (await eth.request({ method: 'eth_signTypedData_v4', params: [owner as `0x${string}`, json] } as never)) as `0x${string}`;
    },
    async getAddresses(): Promise<`0x${string}`[]> {
      return [owner as `0x${string}`];
    },
    async getChainId(): Promise<number> {
      return parseInt((await eth.request({ method: 'eth_chainId' })) as string, 16);
    },
  };
}

type Permission = { parentCapability?: string; caveats?: { type?: string; value?: unknown }[] };

/** Comptes listés dans une permission eth_accounts de MetaMask (caveat restrictReturnedAccounts). */
export function permittedIn(perms: unknown): string[] {
  if (!Array.isArray(perms)) return [];
  const out: string[] = [];
  for (const p of perms as Permission[]) {
    if (p?.parentCapability !== 'eth_accounts') continue;
    for (const c of p.caveats ?? []) {
      if (c?.type !== 'restrictReturnedAccounts' || !Array.isArray(c.value)) continue;
      for (const a of c.value) if (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)) out.push(getAddress(a));
    }
  }
  return out;
}

/**
 * Ouvre le choix des comptes de MetaMask (wallet_requestPermissions), pour connecter à la page un compte de plus,
 * et renvoie les comptes autorisés qu'il annonce. Vide si le portefeuille ne le permet pas ; un refus est remonté.
 */
async function pickAccounts(eth: EIP1193Provider): Promise<string[]> {
  try {
    return permittedIn(await eth.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] } as never));
  } catch (err) {
    if (/User rejected|denied/i.test(message(err))) throw err;
    return [];
  }
}

/**
 * Tous les comptes connectés à la page. MetaMask ne renvoie souvent par eth_accounts que le compte affiché ;
 * la liste complète est dans ses permissions. Le compte affiché vient en premier.
 */
async function permittedAccounts(eth: EIP1193Provider, extra: string[] = []): Promise<string[]> {
  const shown = ((await eth.request({ method: 'eth_requestAccounts' })) as string[]).map(a => getAddress(a));
  let granted: string[] = [];
  try {
    granted = permittedIn(await eth.request({ method: 'wallet_getPermissions' } as never));
  } catch {
    /* portefeuille sans wallet_getPermissions : le compte affiché seul */
  }
  return [...new Set([...shown, ...extra, ...granted])];
}

/**
 * Audit S-02 (23/11/2026) : verdict sur les comptes que MetaMask expose à la page (`accountsChanged`) au regard du
 * compte suivi. `ok` : pas de compte suivi, ou il est exposé ; `other` : seulement d'autres comptes ; `none` : aucun
 * compte (MetaMask verrouillé, page déconnectée).
 */
export function walletVerdict(accounts: unknown, followed: string | null): 'ok' | 'other' | 'none' {
  if (!followed) return 'ok';
  const list = Array.isArray(accounts) ? accounts.filter((a): a is string => typeof a === 'string').map(a => a.toLowerCase()) : [];
  if (!list.length) return 'none';
  return list.includes(followed.toLowerCase()) ? 'ok' : 'other';
}

function provider(): (EIP1193Provider & { on?: (event: string, cb: (accounts: string[]) => void) => void }) | undefined {
  return (window as unknown as { ethereum?: EIP1193Provider & { on?: (event: string, cb: (accounts: string[]) => void) => void } })
    .ethereum;
}

/**
 * Issue d'une entrée limite groupée avec ses protections : l'entrée d'abord (son refus est une erreur), puis
 * chaque protection, nommée. Une protection refusée n'efface jamais l'entrée acceptée.
 */
export function describeBracket(statuses: unknown[], sent: number, tp: boolean, sl: boolean): string {
  const text = describe(statuses[0]);
  if (sent < 2) return text;
  const names = [tp ? 'TP' : '', sl ? 'SL' : ''].filter(Boolean);
  if (statuses.length < sent) return `${text}. ${names.join(' et ')} à vérifier dans la liste des ordres (réponse incomplète)`;
  const refused: string[] = [];
  statuses.slice(1).forEach((st, i) => {
    try {
      describe(st);
    } catch (err) {
      refused.push(`${names[i] ?? 'protection'} REFUSÉ (${message(err)})`);
    }
  });
  if (refused.length)
    return `${text}, mais ${refused.join(' ; ')} : l’entrée est bien en place, ne la renvoie pas ; pose la protection depuis le graphique`;
  // Rattachés à une entrée qui attend au carnet, TP / SL sont EN ATTENTE : Hyperliquid ne les place qu'une fois
  // l'entrée entièrement exécutée (23/11/2026). Ne jamais les annoncer comme une protection active avant.
  const entryFilled = !!statuses[0] && typeof statuses[0] === 'object' && 'filled' in (statuses[0] as object);
  return entryFilled
    ? `${text}, avec ${names.join(' et ')} rattachés`
    : `${text}, avec ${names.join(' et ')} rattachés EN ATTENTE : actifs seulement quand l’entrée sera entièrement exécutée (une exécution partielle n’est pas protégée)`;
}

function describe(status: unknown): string {
  if (status && typeof status === 'object') {
    if ('found' in status) return (status as { found: string }).found;
    if ('filled' in status) {
      const f = (status as { filled: { totalSz: string; avgPx: string } }).filled;
      const px = +f.avgPx;
      return `Exécuté : ${(+f.totalSz * px).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} USDC à ${px.toLocaleString('fr-FR')}`;
    }
    if ('resting' in status) return 'Ordre placé dans le carnet';
    if ('error' in status) throw new Error((status as { error: string }).error);
  }
  if (status === 'waitingForTrigger') return 'Ordre conditionnel en place';
  if (status === 'waitingForFill') return 'Ordre en attente d’exécution';
  return 'Ordre envoyé';
}

export function message(err: unknown): string {
  // Les erreurs de viem et du SDK portent le détail dans `shortMessage` ou `details`, et la cause en dessous.
  const e = err as { shortMessage?: string; details?: string; message?: string; cause?: unknown } | undefined;
  const inner = e?.cause as { message?: string } | undefined;
  const text = [e?.shortMessage ?? e?.message ?? String(err), e?.details, inner?.message]
    .filter((x, i, all) => x && all.indexOf(x) === i)
    .join(' — ');
  if (/User rejected|denied/i.test(text)) return 'signature refusée dans MetaMask';
  if (/deposit/i.test(text))
    return `ce compte n’a encore rien déposé sur Hyperliquid : un premier dépôt est nécessaire avant d’autoriser un agent (${text})`;
  if (/chainId|chain id/i.test(text)) return `réseau de MetaMask refusé (${text}) : passe MetaMask sur Arbitrum One puis réessaie`;
  if (/does not exist|API wallet/i.test(text)) return 'portefeuille agent inconnu d’Hyperliquid : réactive le trading';
  if (/Insufficient margin/i.test(text)) return 'marge insuffisante';
  // Action reçue après son échéance (`expiresAfter`) : refusée, donc sans effet (23/11/2026).
  if (/expire|stale/i.test(text) && !/agent/i.test(text))
    return `action arrivée après son échéance, refusée par Hyperliquid sans effet (horloge de l’ordinateur décalée ?) : ${text}`;
  if (/could not immediately match/i.test(text)) return 'aucune contrepartie dans la tolérance de prix (1 %)';
  return text;
}
