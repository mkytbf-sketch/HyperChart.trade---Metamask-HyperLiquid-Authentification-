import { feeRate, PARTNER } from './partner';
import { ExchangeClient, HttpTransport, InfoClient, SubscriptionClient, WebSocketTransport, type ISubscription } from '@nktkas/hyperliquid';
import { formatSize } from '@nktkas/hyperliquid/utils';
import { getAddress, type EIP1193Provider } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assetFallback, asset as shown } from './asset';
import { shortAddr } from './format';
import { HL_SLOT_KEYS } from './storage-keys';
import { asSealed, openSecret, sealSecret, vaultAvailable, type SealedSecret } from './agent-vault';
import {
  AGENT_GONE_NOTE,
  AGENT_TTL_MS,
  agentName,
  agentStatus,
  agentVerdict,
  KEY_LOST_NOTE,
  KEY_SESSION_NOTE,
  ourAgents,
  revokeNamedAgent,
  type ListedAgent,
  type Saved,
} from './hl-agent';
import {
  CoinChangedError,
  checkConfirmedPrice,
  definitive,
  describe,
  describeBracket,
  describeFound,
  message,
  orderStatuses,
  PendingOrderError,
  UnprotectedError,
} from './hl-errors';
import {
  ACTION_SKEW_MS,
  ACTION_TTL_MS,
  intentsKey,
  legacyPendingKey,
  LEGACY_UNKNOWN_MS,
  readIntents,
  writeIntents,
  type Intent,
} from './hl-intents';
import { metamaskSigner, permittedAccounts, pickAccounts, provider, walletVerdict } from './hl-metamask';
import { parseOrders, parseOtherOrders, protectionResizes } from './hl-orders';
import type { Asset, EntryLeverage, EntryOptions, HlOrder, HlPosition, HlState, RawOrder } from './hl-types';
import {
  bracketWires,
  entryCloid,
  limitWire,
  marketWire,
  MIN_NOTIONAL,
  protectCloid,
  rewire,
  tpCloid,
  tpLimitWire,
  tpSplit,
  triggerRef,
  triggerWire,
} from './hl-wires';

// Modules découpés de ce fichier (Q-01, 24/11/2026) : leurs noms restent importables d'ici, comme avant.
export {
  AGENT_DAYS,
  AGENT_GONE_NOTE,
  AGENT_NAME,
  agentName,
  agentStatus,
  agentVerdict,
  KEY_LOST_NOTE,
  KEY_PLAIN_NOTE,
  KEY_SESSION_NOTE,
  ourAgents,
  revokeNamedAgent,
} from './hl-agent';
export type { ListedAgent } from './hl-agent';
export {
  checkConfirmedPrice,
  CoinChangedError,
  CONFIRM_DRIFT,
  describeBracket,
  describeFound,
  message,
  orderStatuses,
  PendingOrderError,
  PriceMovedError,
  UnprotectedError,
} from './hl-errors';
export { ACTION_SKEW_MS, ACTION_TTL_MS } from './hl-intents';
export { metamaskSigner, permittedIn, walletVerdict } from './hl-metamask';
export { filledPart, parseOrders, parseOtherOrders, protectionResizes } from './hl-orders';
export type {
  EntryLeverage,
  EntryOptions,
  HlAnyPosition,
  HlFill,
  HlOrder,
  HlOrderKind,
  HlOtherOrder,
  HlPosition,
  HlState,
} from './hl-types';
export {
  bracketWires,
  checkTrigger,
  entryCloid,
  exitPnl,
  limitWire,
  MARKET_SLIPPAGE,
  marketWire,
  MIN_NOTIONAL,
  ownCloid,
  protectCloid,
  rewire,
  tpCloid,
  tpLimitWire,
  tpSplit,
  triggerRef,
  triggerWire,
} from './hl-wires';
export type { OrderWire } from './hl-wires';

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

/**
 * Âge maximal du prix Hyperliquid pour envoyer un ordre : au-delà, prix, position et ordres sont relus avant
 * l'envoi (après une veille ou une coupure du flux, le dernier prix reçu peut dater de plusieurs minutes).
 */
const FRESH_MS = 5_000;
/** Mark price plus vieux que cela : le milieu du carnet le remplace pour contrôler un TP / SL. */
const MARK_FRESH_MS = 15_000;
/** Attente maximale du verrou de trading du compte, partagé entre onglets (Web Locks). */
const LOCK_WAIT_MS = 15_000;
/** Sans prix reçu depuis ce délai, le flux est tenu pour coupé : la pastille du compte passe au gris. */
const STALE_MS = 15_000;

// ───────────── Compte ─────────────

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

  /** Intentions en cours, relues du stockage à chaque fois (`readIntents`) ; stockage illisible : celles gardées en mémoire. */
  private loadIntents(): Intent[] {
    return readIntents(this.storeKey, this.saved.address, this.memIntents);
  }

  private saveIntents(list: Intent[]): void {
    this.memIntents = list;
    writeIntents(this.storeKey, list);
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
  private async send(
    ex: ExchangeClient,
    params: Parameters<ExchangeClient['order']>[0],
    coin: string,
    beforeSend?: () => Promise<void>,
  ): Promise<unknown[]> {
    const reducing = params.orders.every(o => o.r);
    if (!reducing) await this.settleIntents();
    // Étape préalable à l'envoi (levier du ticket, audit M-08) : après tous les contrôles, dans la même section
    // critique ; un refus plus haut la laisse sans effet chez Hyperliquid.
    if (beforeSend) {
      this.guard(coin);
      await beforeSend();
    }
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
    const acct = this.acctGen;
    const replacement = await revokeNamedAgent(new ExchangeClient({ transport: this.http, wallet: metamaskSigner(eth, owner) }));
    // Compte suivi changé pendant la signature (audit M-09) : la clé et les métadonnées d'ici sont celles du nouveau
    // compte, elles ne sont pas effacées (et « Oublier » s'arrête là, sans oublier le nouveau compte).
    if (acct !== this.acctGen)
      throw new Error(
        `Révocation signée pour l’ancien compte ${shortAddr(owner)}, mais le compte suivi a changé pendant la signature : rien n’a été effacé ici. Vérifie la liste des agents de ${shortAddr(owner)} sur app.hyperliquid.xyz (More, API).`,
      );
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
      localStorage.removeItem(intentsKey(this.storeKey));
      localStorage.removeItem(legacyPendingKey(this.storeKey));
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
    // Compte suivi au moment de la signature (audit M-09) : s'il change pendant que MetaMask attend (autre onglet,
    // « Oublier », autre compte saisi), la clé n'est écrite pour aucun des deux.
    const acct = this.acctGen;
    await master.approveAgent({ agentAddress: agent.address, agentName: agentName(until) });
    if (acct !== this.acctGen)
      throw new Error(
        `L’agent a été autorisé pour l’ancien compte ${shortAddr(owner)}, mais le compte suivi a changé pendant la signature : rien n’a été enregistré ici et sa clé est abandonnée (inutilisable, elle expire d’elle-même). Reviens sur le compte voulu et réactive le trading.`,
      );
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

  /**
   * Levier voulu pour une entrée (audit M-08), appliqué par `enterNow` juste avant l'envoi, après tous les contrôles
   * et sous le même verrou que l'ordre. Rien à faire si une position est ouverte (c'est son levier qui vaut) ou si le
   * levier et le mode de l'actif sont déjà ceux demandés.
   */
  private async entryLeverageNow(ex: ExchangeClient, asset: Asset, want: EntryLeverage | null | undefined): Promise<void> {
    if (!want || this.state.position) return;
    const t = this.state.trade;
    if (t && t.leverage === want.leverage && t.cross === want.cross) return;
    await ex.updateLeverage({ asset: asset.index, isCross: want.cross, leverage: Math.round(want.leverage) }, this.expiry());
    void this.refreshAvailable();
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
   *  - `leverage` : levier et mode du ticket, appliqués dans la même section critique que l'ordre, juste avant l'envoi
   *    (audit M-08) : un ordre refusé avant l'envoi (prix bougé, frais d'interface, ordre en suspens, relecture
   *    impossible) laisse le levier inchangé. Sans effet pour un ordre « réduire seulement ».
   */
  enter(coin: string, buy: boolean, size: number, opts: EntryOptions): Promise<string> {
    return this.act(false, () => this.enterNow(coin, buy, size, opts));
  }

  private async enterNow(coin: string, buy: boolean, size: number, opts: EntryOptions): Promise<string> {
    const { ex, asset } = this.ready(coin);
    const leverage = () => this.entryLeverageNow(ex, asset, opts.leverage);
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
      const statuses = await this.send(
        ex,
        { orders, grouping: orders.length > 1 ? 'normalTpsl' : 'na', ...this.builderParam() },
        coin,
        leverage,
      );
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
      leverage,
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
