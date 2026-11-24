/**
 * Types du compte Hyperliquid (positions, ordres, exécutions, état publié, contrats, ordres bruts) : découpés de
 * hyperliquid.ts (Q-01, 24/11/2026), qui les réexporte.
 */

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

/** Caractéristiques d'un contrat : rang dans la liste des actifs, décimales de taille, levier maximal. */
export interface AssetBase {
  index: number;
  szDecimals: number;
  maxLeverage: number;
}

/** Contrat de l'actif d'un compte, avec son nom : vérifié avant chaque envoi (`guard`). */
export interface Asset extends AssetBase {
  coin: string;
}

/** Ordres ouverts tels que publiés par Hyperliquid, ramenés à ce que le graphique affiche. */
/** Ordre ouvert tel que publié par Hyperliquid (frontendOpenOrders, flux openOrders). */
export type RawOrder = {
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

/** Levier et mode (croisé ou isolé) voulus pour une entrée, appliqués juste avant l'envoi (`enter`, audit M-08). */
export interface EntryLeverage {
  leverage: number;
  cross: boolean;
}

/** Options d'une entrée (`Hyperliquid.enter`). */
export interface EntryOptions {
  price?: number | null;
  tp?: number | null;
  sl?: number | null;
  reduce?: boolean;
  expectedMid?: number | null;
  leverage?: EntryLeverage | null;
}
