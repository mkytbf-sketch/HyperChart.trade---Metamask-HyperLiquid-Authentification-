import { HL_SLOT_KEYS } from './storage-keys';
import { EMPTY_HTML, html, setHtml, type SafeHtml } from './safe-html';
import { feeText, PARTNER } from './partner';
import type { ChartView, TradeLine } from './chart';
import * as f from './format';
import {
  AGENT_DAYS,
  checkTrigger,
  CoinChangedError,
  filledPart,
  Hyperliquid,
  message,
  MIN_NOTIONAL,
  PendingOrderError,
  UnprotectedError,
  type HlOrder,
} from './hyperliquid';
import { pctToUsdc, powerPct } from './ticket';
import * as calc from './trade-calc';
import type { Ticket } from './trade-calc';
import { asset } from './asset';
import { connectButton, RISK_ACK_KEY, riskNotice } from './metamask-help';
import { renderPositions } from './ui/positions-panel';
import { createConfirm, exitResult, TradeGate, tpShare, tradeLines } from './trade-switch';
import { coinQty as btc, priceStep, roundStep, shortAddr, signedUsdc as signedUsd, usdc as usd } from './format';

/**
 * Trading Hyperliquid depuis le graphique : carte du compte (position, ordres, ticket au marché), menu du clic
 * droit (ordre limite, take profit, stop loss), lignes de la position et des ordres sur le prix, déplacement d'un
 * ordre en glissant sa ligne. Chaque ordre passe par une fenêtre de confirmation : rien ne part sans « Confirmer ».
 *
 * Deux comptes peuvent être suivis à la fois, chacun avec son propre agent. La carte montre le compte choisi
 * dans ses onglets : le ticket et le clic droit passent les ordres sur ce compte. Le graphique trace les lignes
 * des deux, étiquetées C1 et C2 ; glisser une ligne déplace l'ordre du compte auquel elle appartient.
 *
 * Changement d'actif sans rechargement (docs/CHANGEMENT-ACTIF-A-CHAUD.md, § 3) : chaque action capture l'actif
 * affiché au moment où l'utilisateur voit le prix (clic sur le ticket, ouverture du menu du clic droit, ligne
 * glissée, bouton portant `data-coin`) et le revérifie après chaque attente ; `freeze()` ferme la confirmation
 * ouverte (annulée) et désactive tout, `drain()` attend la fin des envois déjà confirmés, `switched()` passe les
 * comptes et le ticket au nouvel actif.
 */

export interface TradeMenuItem {
  label: string;
  /** Tracé SVG de l'icône, écrit par le gabarit `html` (Trusted Types, 23/11/2026). */
  icon: SafeHtml;
  danger?: boolean;
  /** Entrée grisée : explique pourquoi l'action n'est pas possible à ce prix. */
  disabled?: boolean;
  run: () => void;
}

const TICKET_KEY = 'strate:hl-ticket';
const ACTIVE_KEY = 'strate:hl-active';
/** Taille maximale par ordre (USDC) fixée par l'utilisateur dans la carte, propre à cet appareil (23/11/2026). */
const MAX_ORDER_KEY = 'strate:hl-max-order';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** Sens d'une exécution, tel que publié par Hyperliquid, en français. */
const DIRS: Record<string, string> = {
  'Open Long': 'Ouverture long',
  'Close Long': 'Clôture long',
  'Open Short': 'Ouverture short',
  'Close Short': 'Clôture short',
  'Long > Short': 'Long → short',
  'Short > Long': 'Short → long',
  Liquidation: 'Liquidation',
};
const dir = (d: string) => DIRS[d] ?? d;

/** Ce que la coquille de l'application pilote du trading (menu du clic droit, changement d'actif). */
export interface TradingApi {
  menu: (price: number, line?: TradeLine | null) => TradeMenuItem[];
  /** Début d'une bascule : confirmation ouverte annulée, rien ne peut plus commencer. */
  freeze(): void;
  /** Attend la fin des envois déjà confirmés (entrée puis TP et SL), puis gèle les comptes. */
  drain(): Promise<void>;
  /** Nouvel actif en place : comptes et ticket passés à l'actif affiché, trading dégelé. */
  switched(): void;
  /** Bascule abandonnée (échec ou autre clic) : trading dégelé sur l'actif inchangé. */
  resume(): void;
}

export function setupTrading(chart: ChartView, toast: (title: string, body: string) => void): TradingApi {
  const el = {
    card: $('hl-card'),
    body: $('hl-body'),
    dialog: $<HTMLDialogElement>('trade-dialog'),
    dTitle: $('trade-title'),
    dRows: $('trade-rows'),
    dWarn: $('trade-warn'),
    dOk: $<HTMLButtonElement>('trade-ok'),
    dCancel: $<HTMLButtonElement>('trade-cancel'),
  };
  let ticket: Ticket = { ...calc.DEFAULT_TICKET };
  try {
    ticket = calc.restoreTicket(localStorage.getItem(TICKET_KEY));
  } catch {
    /* stockage inaccessible : réglages par défaut */
  }
  const saveTicket = () => {
    try {
      const { usdc, qty, leverage, cross, side, type, unit, tpsl, riskPct } = ticket;
      localStorage.setItem(TICKET_KEY, JSON.stringify({ usdc, qty, leverage, cross, side, type, unit, tpsl, riskPct }));
    } catch {
      /* rien */
    }
  };
  let busy = false;
  /** Garde-fou facultatif : taille maximale par ordre (USDC), null sans plafond (`calc.maxOrderInput`). */
  let maxOrder: number | null = null;
  try {
    maxOrder = calc.maxOrderInput(localStorage.getItem(MAX_ORDER_KEY));
  } catch {
    /* stockage inaccessible : pas de plafond */
  }
  /** Avertissement de risque ouvert dans la carte, avant la première activation du trading sur cet appareil. */
  let riskOpen = false;
  /** Case « J'ai lu et compris » cochée : gardée hors du DOM, la carte étant redessinée à chaque prix. */
  let riskChecked = false;
  const riskAccepted = () => {
    try {
      return localStorage.getItem(RISK_ACK_KEY) !== null;
    } catch {
      return false;
    }
  };
  /** Gel pendant un changement d'actif : aucune action ne commence, les envois confirmés sont attendus. */
  const gate = new TradeGate();
  const confirmBox = createConfirm({ dialog: el.dialog, ok: el.dOk, cancel: el.dCancel });
  let renderTimer = 0;
  // Le flux des comptes arrive par rafales : un rendu tous les 100 ms au plus (minuterie plutôt qu'image
  // d'animation, suspendue quand l'onglet est en arrière-plan alors que les ordres peuvent s'exécuter).
  const schedule = () => {
    if (renderTimer) return;
    renderTimer = window.setTimeout(() => {
      renderTimer = 0;
      render();
    }, 100);
  };
  const accounts = HL_SLOT_KEYS.map(key => new Hyperliquid(schedule, key));
  // Un long ou un short exécuté sur une position ouverte : TP et SL suivent sa nouvelle taille, et c'est dit.
  for (const hl of accounts) hl.onProtectSync = (text, ok) => toast(ok ? 'TP / SL recalés' : 'TP / SL à vérifier', text);
  let active = 0;
  try {
    active = Math.min(accounts.length - 1, Math.max(0, Number(localStorage.getItem(ACTIVE_KEY)) || 0));
  } catch {
    /* premier compte */
  }
  const setActive = (k: number) => {
    active = k;
    try {
      localStorage.setItem(ACTIVE_KEY, String(k));
    } catch {
      /* rien */
    }
    render();
  };
  const cur = () => accounts[active];
  /**
   * Levier du ticket borné au maximum du contrat affiché (lu chez Hyperliquid ; 40 tant qu'il ne l'est pas) : la clé
   * du ticket est commune à tous les actifs, un levier enregistré sur un autre contrat n'est jamais repris tel quel.
   * Appelé avant tout usage du levier (rendu, résumé du ticket, préparation d'un ordre).
   */
  const boundLeverage = () => {
    ticket.leverage = calc.leverageBound(ticket.leverage, cur().state.maxLeverage);
  };
  /** Plusieurs comptes suivis : les lignes, menus et confirmations nomment le compte. */
  const multi = () => accounts.filter(a => a.state.address).length > 1;
  const tag = (hl: Hyperliquid) => `C${accounts.indexOf(hl) + 1}`;
  const prefix = (hl: Hyperliquid) => (multi() ? `${tag(hl)} · ` : '');
  const others = (hl: Hyperliquid) => accounts.filter(a => a !== hl && a.state.address).map(a => a.state.address!);

  // ───────────── Confirmation ─────────────

  /**
   * Fenêtre de confirmation ; vrai si l'utilisateur confirme. Contenu préparé par `trade-calc.ts`, qui nomme l'actif
   * de chaque ordre (titre et ligne « Actif », SEC-24) ; le compte est ajouté en tête quand plusieurs sont suivis.
   */
  function confirm(hl: Hyperliquid, c: calc.Confirmation): Promise<boolean> {
    const { title, warn, tone, ok } = c;
    let rows = c.rows;
    if (multi()) rows = [['Compte', `${tag(hl)} · ${shortAddr(hl.state.address!)}`], ...rows];
    el.dTitle.textContent = title;
    setHtml(el.dRows, html`${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}`);
    el.dWarn.textContent = warn;
    el.dWarn.hidden = !warn;
    el.dOk.textContent = ok;
    el.dOk.dataset.tone = tone;
    // Gelé (changement d'actif en cours) : la confirmation n'est même pas ouverte.
    if (gate.frozen) return Promise.resolve(false);
    return confirmBox.ask();
  }

  /**
   * L'actif visé est-il toujours celui affiché, et le trading dégelé ? Revérifié après chaque attente (relecture du
   * compte, confirmation) : sinon l'action s'arrête là, avec un mot, et rien ne part.
   */
  function stillOn(hl: Hyperliquid, coin: string): boolean {
    if (coin === asset.coin && hl.coin === coin && !gate.frozen) return true;
    toast('Ordre annulé', `L’actif affiché a changé (${coin} → ${asset.coin}) : rien n’a été envoyé.`);
    return false;
  }

  /**
   * Exécute une action de trading sur un compte, affiche son issue. Refusée pendant un changement d'actif. `kind` :
   * une action sur les ordres (`'order'`) est suivie jusqu'à sa fin, que la bascule attend (`drain`) ; une action du
   * compte (`'account'` : connexion, signature MetaMask, parrainage) ne dépend pas de l'actif et ne la retient pas.
   */
  function run(
    hl: Hyperliquid,
    label: string,
    action: () => Promise<string | void>,
    kind: 'order' | 'account' = 'order',
  ): Promise<boolean> {
    if (gate.frozen) {
      toast(`${prefix(hl)}${label} : non envoyé`, 'Changement d’actif en cours : rien n’a été envoyé.');
      return Promise.resolve(false);
    }
    return gate.track(runNow(hl, label, action), kind);
  }

  /** Vrai si l'action a abouti (23/11/2026 : la suite d'une annulation en dépend). */
  async function runNow(hl: Hyperliquid, label: string, action: () => Promise<string | void>): Promise<boolean> {
    // Une action confirmée ne disparaît jamais sans un mot : si une autre est en cours (signature MetaMask en
    // attente, envoi sur l'autre compte), l'utilisateur est prévenu que celle-ci n'est pas partie.
    if (busy) {
      toast(`${prefix(hl)}${label} : non envoyé`, 'Une autre action est en cours (signature ou envoi). Réessaie dès qu’elle est terminée.');
      return false;
    }
    busy = true;
    hl.state.error = null;
    render();
    const title = `${prefix(hl)}${label}`;
    let ok = false;
    try {
      const result = await action();
      toast(title, result || 'Fait');
      ok = true;
    } catch (err) {
      // Détail complet dans la console, message lisible dans la carte (il y reste jusqu'à la prochaine action).
      console.error(`[Hyperliquid] ${title}`, err);
      if (err instanceof UnprotectedError) {
        // L'ordre est exécuté : ce n'est pas un échec, c'est une position ouverte sans la protection demandée.
        const todo = `${err.missing.join(' ; ')}. Pose-le maintenant (clic droit sur le graphique) ou ferme la position.`;
        hl.state.error = `${label} exécuté, protection manquante : ${todo}`;
        toast(`${title} : EXÉCUTÉ, protection manquante`, `${err.done}. ${todo} Ne renvoie pas l’ordre : la position est ouverte.`);
      } else if (err instanceof CoinChangedError) {
        // Refusé avant tout envoi : l'actif affiché a changé pendant la préparation.
        hl.state.error = null;
        toast(`${title} : non envoyé`, message(err));
      } else if (err instanceof PendingOrderError) {
        // Ni succès ni échec : l'ordre a peut-être été reçu. Le dire comme tel, pour qu'il ne soit pas renvoyé.
        hl.state.error = `${label} : résultat inconnu. ${message(err)}`;
        toast(`${title} : RÉSULTAT INCONNU`, message(err));
      } else {
        hl.state.error = `${label} : ${message(err)}`;
        toast(`${title} : échec`, message(err));
      }
    }
    busy = false;
    render();
    return ok;
  }

  /**
   * Avant de préparer un ordre : prix, position et ordres du compte doivent être ceux du moment. Après une veille
   * ou une coupure du flux, ils sont relus ; si c'est impossible, l'action s'arrête là avec un message.
   */
  async function upToDate(hl: Hyperliquid): Promise<boolean> {
    try {
      await hl.fresh();
      return true;
    } catch (err) {
      toast('Ordre impossible', message(err));
      return false;
    }
  }

  /** Levier du ticket appliqué juste avant l'ordre, sauf position ouverte (c'est alors le sien qui vaut). */
  const applyLeverage = async (hl: Hyperliquid, coin: string) => {
    if (!hl.state.position && (hl.state.trade?.leverage !== ticket.leverage || hl.state.trade?.cross !== ticket.cross)) {
      await hl.setLeverage(coin, ticket.leverage, ticket.cross);
      void hl.refreshAvailable();
    }
  };

  // Calculs du ticket : fonctions pures de `trade-calc.ts`, appliquées au ticket et au compte du moment.
  const effectiveLeverage = (hl: Hyperliquid) => calc.effectiveLeverage(ticket, hl.state.position);
  const entryPrice = (hl: Hyperliquid) => calc.entryPrice(ticket, hl.state.mid);
  const refPrice = (hl: Hyperliquid) => calc.refPrice(ticket, hl.state.mid);
  const maxUsd = (hl: Hyperliquid, buy: boolean) => calc.maxUsd(ticket, hl.state, buy);
  const availUsd = (hl: Hyperliquid, buy: boolean) => calc.availUsd(hl.state, buy);
  const tpOf = () => calc.tpOf(ticket);
  const slOf = () => calc.slOf(ticket);
  const plan = (hl: Hyperliquid, buy: boolean, entry: number) => calc.plan(ticket, hl.state, buy, entry, hl.szDecimals);

  /**
   * Entrée depuis le ticket (ou le menu du clic droit : `at` = prix limite visé), avec le TP et le SL du ticket
   * s'ils sont renseignés. Refus, montant, risque et textes de la confirmation : `calc.prepareEntry`.
   */
  async function openEntry(hl: Hyperliquid, coin: string, buy: boolean, at?: number): Promise<void> {
    if (!(await upToDate(hl)) || !stillOn(hl, coin)) return;
    boundLeverage();
    const d = calc.prepareEntry({
      coin,
      buy,
      at,
      ticket,
      state: hl.state,
      szDecimals: hl.szDecimals,
      tpFull: hl.tpSplit().full,
      builderFee: PARTNER.builder && hl.state.builderApproved ? PARTNER.builder.fee : null,
      maxOrderUsd: maxOrder,
    });
    if (calc.refused(d)) return toast('Ordre impossible', d.problem);
    const { limit, entry, plan: pl, tp, sl } = d;
    const ok = await confirm(hl, d);
    if (!ok || !stillOn(hl, coin)) return;
    // Prix limite à plus de 10 % du marché : seconde confirmation, qui dit l'écart (faute de frappe probable).
    if (d.far && (!(await confirm(hl, d.far)) || !stillOn(hl, coin))) return;
    const reduce = ticket.reduce;
    await run(hl, d.label, async () => {
      await applyLeverage(hl, coin);
      // Ordre parti : les prix du ticket sont vidés, pour ne pas resservir par mégarde.
      const sent = () => {
        ticket.tp = ticket.sl = null;
        if (at === undefined) ticket.limitPx = null;
      };
      try {
        const text = await hl.enter(coin, buy, pl.size, { price: limit ? entry : null, tp, sl, reduce });
        sent();
        return text;
      } catch (err) {
        // Entrée exécutée mais protection refusée, ou peut-être reçue (réponse perdue) : le ticket est vidé aussi,
        // pour qu'un second clic ne renvoie pas le même ordre.
        if (err instanceof UnprotectedError || err instanceof PendingOrderError) sent();
        throw err;
      }
    });
  }

  /**
   * Take profit partiel : ordre limite réduisant seulement pour une part de la position, en plus des autres TP. Le
   * TP complet, s'il existe, est réduit d'autant pour que le total ne dépasse pas la position. Refus, taille et
   * textes de la confirmation : `calc.partialTpConfirmation`.
   */
  async function partialTp(hl: Hyperliquid, coin: string, price: number, share: number): Promise<void> {
    if (!(await upToDate(hl)) || !stillOn(hl, coin)) return;
    const p = hl.state.position;
    const m = hl.state.mid;
    if (!p || !m) return;
    const c = calc.partialTpConfirmation({
      coin,
      price,
      share,
      position: p,
      mid: m,
      mark: hl.state.mark,
      szDecimals: hl.szDecimals,
      split: hl.tpSplit(),
    });
    if (calc.refused(c)) return toast('Ordre impossible', c.problem);
    const ok = await confirm(hl, c);
    if (ok && stillOn(hl, coin)) await run(hl, 'TP partiel', () => hl.partialTp(coin, price, c.size));
  }

  /** TP limite complet ou stop loss sur la position (textes : `calc.protectConfirmation`). */
  async function protect(hl: Hyperliquid, coin: string, tpsl: 'tp' | 'sl', price: number): Promise<void> {
    if (!(await upToDate(hl)) || !stillOn(hl, coin)) return;
    const p = hl.state.position;
    const m = hl.state.mid;
    if (!p || !m) return;
    const c = calc.protectConfirmation({
      coin,
      tpsl,
      price,
      position: p,
      mid: m,
      mark: hl.state.mark,
      split: hl.tpSplit(),
      currentSl: hl.state.orders.find(o => o.kind === 'sl'),
    });
    if (calc.refused(c)) return toast('Ordre impossible', c.problem);
    const ok = await confirm(hl, c);
    if (ok && stillOn(hl, coin)) await run(hl, tpsl === 'tp' ? 'Take profit' : 'Stop loss', () => hl.protect(coin, tpsl, price));
  }

  async function closePosition(hl: Hyperliquid, coin: string, fraction: number): Promise<void> {
    if (!(await upToDate(hl)) || !stillOn(hl, coin)) return;
    const p = hl.state.position;
    const m = hl.state.mid;
    if (!p || !m) return;
    const c = calc.closeConfirmation(coin, p, m, fraction);
    if (calc.refused(c)) return toast('Ordre impossible', c.problem);
    const ok = await confirm(hl, c);
    if (ok && stillOn(hl, coin)) await run(hl, 'Fermeture', () => hl.close(coin, fraction));
  }

  /**
   * Annulation d'un ordre. Entrée exécutée en partie dont le SL rattaché n'était qu'en attente (23/11/2026) : la
   * confirmation dit la position résiduelle et l'état de son stop ; après l'annulation, la position est relue et, si
   * elle n'a toujours aucun stop, un stop loss au même prix est proposé (sa propre confirmation, signé par l'agent).
   */
  async function cancelOrder(hl: Hyperliquid, coin: string, o: HlOrder): Promise<void> {
    if (!stillOn(hl, coin)) return;
    const activeSl = () => hl.state.orders.find(x => x.kind === 'sl') ?? null;
    const ok = await confirm(hl, calc.cancelConfirmation(coin, o, hl.state.position, activeSl()));
    if (!ok || !stillOn(hl, coin)) return;
    const done = await run(hl, 'Annulation', async () => {
      await hl.cancel(coin, o);
      return o.children?.length ? 'Ordre annulé, avec ses TP / SL en attente' : 'Ordre annulé';
    });
    if (!done || !o.children?.length || !(await upToDate(hl)) || !stillOn(hl, coin)) return;
    const px = calc.residualStop(o, hl.state.position, activeSl());
    if (px !== null) await protect(hl, coin, 'sl', px);
  }

  async function moveOrder(hl: Hyperliquid, coin: string, o: HlOrder, price: number): Promise<void> {
    if (!(await upToDate(hl)) || !stillOn(hl, coin)) return;
    const c = calc.moveConfirmation(coin, o, price, hl.state.position, hl.state.mid, hl.state.mark);
    if (calc.refused(c)) return toast('Déplacement impossible', c.problem);
    let ok = await confirm(hl, c);
    // Ordre limite lâché à plus de 10 % du marché : même confirmation renforcée qu'à l'entrée.
    const far = o.kind === 'limit' ? calc.farPriceConfirmation(coin, o.buy, price, hl.state.mid) : null;
    if (ok && far && stillOn(hl, coin)) ok = await confirm(hl, far);
    if (ok && stillOn(hl, coin))
      await run(hl, 'Déplacement', async () => {
        await hl.move(coin, o, price);
        return `${o.label} à ${f.price(price)}`;
      });
  }

  // Les lignes portent le rang de leur compte (« 1:o:123 ») : le glissement vise toujours le bon compte.
  function lineOrder(line: TradeLine): { hl: Hyperliquid; o: HlOrder } | null {
    const { account, key } = calc.parseLineId(line.id);
    const hl = accounts[account];
    const o = hl?.state.orders.find(x => `o:${x.oid}` === key);
    return hl && o ? { hl, o } : null;
  }
  chart.onTradeDrop = (line: TradeLine, price: number) => {
    const hit = lineOrder(line);
    // La ligne porte l'actif pour lequel elle a été tracée : un glissement commencé avant une bascule est refusé.
    if (hit) void moveOrder(hit.hl, line.coin ?? '', hit.o, roundStep(price));
  };

  // ───────────── Rendu ─────────────

  /** Lignes de la position et des ordres de chaque compte suivi (`tradeLines`, trade-switch.ts). */
  function lines(): TradeLine[] {
    return tradeLines(accounts, { up: css('--up'), down: css('--down'), blue: css('--blue') }, k => (multi() ? `C${k + 1} · ` : ''));
  }

  /** Onglets des comptes, dès qu'un compte est suivi : le second se connecte depuis son onglet. */
  function tabsHtml(): SafeHtml {
    if (!accounts[0].state.address && !accounts[1].state.address && active === 0) return EMPTY_HTML;
    return html`<div class="hl-tabs" role="tablist">${accounts.map((hl, k) => {
      const s = hl.state;
      const pos = s.position;
      const text = s.address
        ? html`<b>C${k + 1}</b> ${shortAddr(s.address)}${pos ? html` <i data-side="${pos.size > 0 ? 'up' : 'down'}">${pos.size > 0 ? 'L' : 'S'}</i>` : ''}`
        : html`<b>C${k + 1}</b> + Ajouter`;
      return html`<button type="button" role="tab" data-tab="${k}" aria-selected="${String(k === active)}">${text}</button>`;
    })}</div>`;
  }

  /** Pastille du titre de la carte Hyperliquid : résultat latent des positions ouvertes, visible même carte repliée. */
  const badge = document.getElementById('tab-trade-badge');
  function renderBadge(): void {
    if (!badge) return;
    const open = accounts.map(a => a.state.position).filter((p): p is NonNullable<typeof p> => !!p);
    const pnl = open.reduce((sum, p) => sum + p.pnl, 0);
    const text = open.length ? signedUsd(pnl) : '';
    if (badge.textContent !== text) badge.textContent = text;
    badge.dataset.tone = !open.length ? '' : pnl >= 0 ? 'up' : 'down';
  }

  /** Panneau des positions sous le graphique : compte de l'onglet choisi, toutes ses positions et ses ordres. */
  function renderPanel(): void {
    const hl = cur();
    const s = hl.state;
    if (!s.address) return renderPositions(null);
    const p = s.position;
    renderPositions({
      account: `${prefix(hl)}${shortAddr(s.address)}`,
      trading: s.trading,
      busy: busy || gate.frozen,
      shownCoin: asset.coin,
      positions: s.positions,
      orders: s.orders,
      otherOrders: s.otherOrders,
      // Même condition que le bouton « Stop au point mort » de la carte.
      breakeven: !!(p && hl.triggerPrice() && !checkTrigger(p.size > 0, 'sl', p.entry, hl.triggerPrice()!)),
      accountValue: s.accountValue,
      marginUsed: s.marginUsed,
    });
  }

  /**
   * Rendu de la carte, du panneau des positions et des lignes du graphique. Gelé (changement d'actif en cours) :
   * chaque contrôle de la carte est désactivé, sauf les onglets des comptes.
   */
  function render(): void {
    paint();
    if (!gate.frozen) return;
    for (const x of el.body.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select'))
      if (!(x instanceof HTMLButtonElement && x.dataset.tab)) x.disabled = true;
  }

  function paint(): void {
    boundLeverage();
    chart.setTradeLines(lines());
    renderBadge();
    renderPanel();
    // Saisie en cours dans la carte : elle n'est pas redessinée (le champ perdrait le curseur), elle le sera au
    // changement de valeur.
    if (el.body.contains(document.activeElement) && (document.activeElement as HTMLElement).matches('input, select')) return;
    const hl = cur();
    const s = hl.state;
    el.card.dataset.state = s.address ? (s.trading ? 'trading' : 'watch') : 'off';
    // Les sections repliables ouvertes le restent d'un rendu à l'autre (la carte est redessinée à chaque prix).
    const opened = new Set([...el.body.querySelectorAll('details[open] > summary')].map(x => x.textContent ?? ''));
    queueMicrotask(() => {
      for (const d of el.body.querySelectorAll('details')) if (opened.has(d.querySelector('summary')?.textContent ?? '')) d.open = true;
    });
    const tabs = tabsHtml();
    if (!s.address) {
      const second = active > 0;
      setHtml(
        el.body,
        html`${tabs}
        ${second ? html`<p class="note">Second compte : MetaMask propose de choisir les comptes à connecter à cette page. Coche celui à ajouter ; un compte déjà suivi n’est pas repris.</p>` : ''}
        <div class="hl-acts">${connectButton(busy)}</div>
        <details class="more"><summary>Suivre une adresse sans MetaMask</summary>
          <form class="hl-watch" data-act="watch"><input name="addr" placeholder="0x… (lecture seule)" autocomplete="off" spellcheck="false" /><button type="submit">Suivre</button></form>
        </details>
        ${s.error ? html`<p class="hl-error">${s.error}</p>` : ''}`,
      );
      return;
    }
    const p = s.position;
    // Position de l'actif affiché, avec ses actions. Quand le panneau des positions est déplié sous le graphique, il
    // la montre déjà avec les mêmes actions : ce bloc est alors masqué par style.css (`.hl-pos`, `.hl-pos-none`).
    const posHtml = p
      ? html`<div class="hl-pos" data-side="${p.size > 0 ? 'up' : 'down'}">
          <div><strong>${p.size > 0 ? 'Long' : 'Short'} ${usd(Math.abs(p.value))}</strong><span>${p.leverage}× ${p.cross ? 'croisé' : 'isolé'}</span></div>
          <dl class="facts">
            <div><dt>Entrée</dt><dd>${f.price(p.entry)}</dd></div>
            <div><dt>Prix Hyperliquid</dt><dd>${s.mid ? f.price(s.mid) : '—'}</dd></div>
            <div><dt>PnL latent</dt><dd class="${p.pnl >= 0 ? 'up' : 'down'}">${signedUsd(p.pnl)} <small>${f.signed(p.roe * 100, 1)} %</small></dd></div>
            <div><dt>Liquidation</dt><dd>${p.liquidation ? f.price(p.liquidation) : '—'}</dd></div>
          </dl>
          ${s.trading ? html`<div class="hl-acts small"><button type="button" data-close="0.25" data-coin="${hl.coin}">Fermer 25 %</button><button type="button" data-close="0.5" data-coin="${hl.coin}">50 %</button><button type="button" data-close="1" data-coin="${hl.coin}" class="danger">Tout fermer</button></div>${hl.triggerPrice() && !checkTrigger(p.size > 0, 'sl', p.entry, hl.triggerPrice()!) ? html`<div class="hl-acts small"><button type="button" data-act="breakeven" data-coin="${hl.coin}" title="Stop loss au prix d’entrée. Exécuté au marché une fois déclenché : le prix obtenu peut différer (glissement, frais), et l’exécution peut être partielle ou ne pas avoir lieu dans un marché très rapide">Stop au point mort</button></div>` : ''}` : ''}
        </div>`
      : html`<p class="note hl-pos-none">Aucune position ${asset.coin} ouverte.</p>`;
    const buySide = ticket.side === 'buy';
    const limitMode = ticket.type === 'limit';
    const ticketHtml = s.trading
      ? html`<div class="hl-ticket" data-side="${buySide ? 'up' : 'down'}">
          <div class="tk-side" role="group" aria-label="Sens"><button type="button" data-side="buy" aria-pressed="${String(buySide)}">Achat / Long</button><button type="button" data-side="sell" aria-pressed="${String(!buySide)}">Vente / Short</button></div>
          <div class="tk-seg" role="group" aria-label="Type d’ordre"><button type="button" data-type="market" aria-pressed="${String(!limitMode)}">Marché</button><button type="button" data-type="limit" aria-pressed="${String(limitMode)}">Limite</button></div>
          <dl class="tk-info">
            <div><dt>Disponible pour trader</dt><dd data-tk="avail">—</dd></div>
            <div><dt>Position actuelle</dt><dd>${p ? `${p.size > 0 ? '' : '−'}${btc(Math.abs(p.size))}` : `0 ${asset.coin}`}</dd></div>
          </dl>
          ${limitMode ? html`<div class="tk-field"><span>Prix</span><input type="number" name="limitPx" step="${priceStep()}" min="0" value="${ticket.limitPx ?? ''}" placeholder="${s.mid ? roundStep(s.mid) : 'prix'}" title="Molette : ±${priceStep()} (Maj : ±${10 * priceStep()}). Ou clic droit sur le graphique" /><button type="button" class="tk-mini" data-act="mid">Milieu</button></div>` : ''}
          <div class="tk-field"><span>Taille</span><input type="text" inputmode="decimal" name="size" autocomplete="off" title="Molette : ±1 % (Maj : ±5 %)" /><button type="button" class="tk-mini" data-act="unit" title="Changer d’unité">${ticket.unit === 'btc' ? asset.coin : 'USDC'} ⇄</button></div>
          <div class="tk-slider">
            <div class="tk-track"><input type="range" name="pct" min="0" max="100" step="1" aria-label="Part du maximum" title="Glisse, ou tourne la molette (Maj : par 5 %)" /><div class="tk-ticks">${[0, 25, 50, 75, 100].map(v => html`<button type="button" data-pct="${v}" style="left:${v}%" aria-label="${v} %"></button>`)}</div></div>
            <label class="tk-pct"><input type="number" name="pctBox" min="0" max="100" step="1" aria-label="Pourcentage du maximum" /><span>%</span></label>
          </div>
          <div class="tk-checks">
            <label><input type="checkbox" name="reduce"${ticket.reduce ? ' checked' : ''}${p ? '' : ' disabled'} /> Réduire seulement</label>
            <label><input type="checkbox" name="tpsl"${ticket.tpsl ? ' checked' : ''}${ticket.reduce ? ' disabled' : ''} /> TP / SL</label>
          </div>
          ${
            ticket.tpsl && !ticket.reduce
              ? html`<div class="tk-pair">
            <label>Take profit <input type="number" name="tp" step="${priceStep()}" min="0" value="${ticket.tp ?? ''}" placeholder="prix" title="Molette : ±${priceStep()} (Maj : ±${10 * priceStep()})" /></label>
            <label>Stop loss <input type="number" name="sl" step="${priceStep()}" min="0" value="${ticket.sl ?? ''}" placeholder="prix" title="Molette : ±${priceStep()} (Maj : ±${10 * priceStep()})" /></label>
          </div>
          <div class="tk-risk"><label>Risque <input type="number" name="riskPct" step="0.1" min="0.1" max="100" value="${ticket.riskPct}" /><span class="unit">% du compte</span></label><button type="button" data-act="risk-size" title="Calcule la taille pour perdre ce pourcentage du compte si le stop est touché">Taille au risque</button></div>`
              : ''
          }
          ${p ? html`<div class="tk-lev"><span>Levier</span><b>${p.leverage}× ${p.cross ? 'croisé' : 'isolé'}</b><small>celui de la position</small></div>` : html`<div class="tk-lev"><span>Levier</span><input type="number" name="lev" min="1" max="${s.maxLeverage}" step="1" value="${ticket.leverage}" title="Molette : ±1" /><select name="mode"><option value="cross"${ticket.cross ? ' selected' : ''}>Croisé</option><option value="iso"${ticket.cross ? '' : ' selected'}>Isolé</option></select></div>`}
          <button type="button" class="tk-submit ${buySide ? 'buy' : 'sell'}" data-act="submit"${busy || (PARTNER.builder && PARTNER.required && s.builderApproved === false) ? ' disabled' : ''}>${limitMode ? (buySide ? 'Placer l’achat limite' : 'Placer la vente limite') : buySide ? 'Acheter / Long' : 'Vendre / Short'}</button>
          <dl class="tk-info tk-sum" data-tk="sum"></dl>
          <details class="more"><summary>Garde-fous</summary><label class="tk-field"><span>Taille max. par ordre</span><input type="number" name="maxOrder" min="${calc.MAX_ORDER_FLOOR}" step="10" value="${maxOrder ?? ''}" placeholder="aucune" title="Au-delà, l’ordre est refusé avant toute confirmation. Vide : pas de plafond." /><span class="unit">USDC</span></label><p class="note">Facultatif, propre à cet appareil : un ordre plus gros est refusé avant toute confirmation. Un prix limite à plus de ${calc.FAR_LIMIT * 100} % du prix actuel demande toujours une seconde confirmation.</p></details>
          <details class="more"><summary>Aide</summary><p class="note">Comme sur Hyperliquid : choisis le sens et le type, puis la taille, en USDC ou en ${asset.coin} (bouton ⇄), au curseur ou en pourcentage du maximum disponible pour trader. La molette ajuste la taille, le curseur et le pourcentage par 1 % (Maj : 5 %), et les prix par 1 (Maj : 10). « TP / SL » ajoute un take profit (ordre limite réduisant seulement) et un stop loss à l’entrée ; « Taille au risque » calcule la taille pour ne perdre que le pourcentage choisi du compte au stop. Clic droit sur le graphique : ordre limite, take profit (total ou partiel), stop loss au prix visé. Chaque ordre est confirmé avant envoi.</p></details>
        </div>`
      : hl.keyPending
        ? html`<div class="hl-acts"><button type="button" class="primary" disabled>Lecture de la clé de l’agent…</button></div>`
        : riskOpen
          ? riskNotice(riskChecked)
          : html`<div class="hl-acts"><button type="button" class="primary" data-act="enable"${busy ? ' disabled' : ''}>${busy ? 'Signature demandée dans MetaMask…' : 'Activer le trading'}</button></div>
         <details class="more"><summary>Comment ça marche</summary><p class="note">Une signature MetaMask, à renouveler tous les ${AGENT_DAYS} jours, autorise un portefeuille agent créé dans ce navigateur à passer des ordres pour ce compte. Il ne peut ni retirer ni transférer de fonds, mais il peut trader : sa clé, gardée chiffrée dans ce navigateur pendant ${AGENT_DAYS} jours au plus (ou seulement en mémoire, pour la session, si le chiffrement est indisponible), permettrait à qui la volerait de faire perdre le solde du compte par des ordres. Le chiffrement protège contre la copie isolée du stockage local, pas contre la copie du profil complet du navigateur, ni contre un script malveillant qui s’exécuterait dans cette page : un tel script pourrait trader directement, et même faire sortir la clé. N’active le trading que sur un appareil et un navigateur de confiance ; « Oublier » révoque l’agent chez Hyperliquid et efface la clé. Hyperliquid ne garde qu’un agent HyperChart par compte : l’activer ici remplace celui d’un autre navigateur.${PARTNER.builder ? ` Une seconde signature autorise le frais d’interface de ${feeText(PARTNER.builder.fee)} par ordre exécuté depuis cette app.` : ''} Le compte doit être connecté à cette page dans MetaMask au moment de la signature (pas forcément affiché).</p></details>`;
    const ordersHtml = s.orders.length
      ? html`<ul class="hl-orders">${s.orders.map(
          o =>
            html`<li data-kind="${o.kind}"><strong>${o.label}${tpShare(s, o)}</strong><span>${f.price(o.price)} · ${exitResult(s, o) !== null ? signedUsd(exitResult(s, o)!) : o.position ? 'position' : usd(o.size * o.price)}</span>${o.children?.length ? html`<small class="hl-pending">${o.children.map(c => `${c.label} ${f.price(c.price)}`).join(', ')} en attente : actifs seulement à l’exécution complète${filledPart(o) > 0 ? ' (entrée déjà exécutée en partie, partie non protégée)' : ''}</small>` : ''}${s.trading ? html`<button type="button" data-cancel="${o.oid}" data-coin="${hl.coin}" aria-label="Annuler">×</button>` : ''}</li>`,
        )}</ul>`
      : '';
    const fillsHtml = s.fills.length
      ? html`<ul class="hl-fills">${s.fills
          .slice(-4)
          .reverse()
          .map(
            x =>
              html`<li data-side="${x.buy ? 'up' : 'down'}"><time>${new Date(x.t * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</time> ${dir(x.dir)} ${usd(x.size * x.price)} à ${f.price(x.price)}${x.pnl ? ` · ${signedUsd(x.pnl)}` : ''}</li>`,
          )}</ul>`
      : '';
    setHtml(
      el.body,
      html`${tabs}
      <div class="hl-head"><span class="dot" data-live="${String(s.live)}"></span><span>${shortAddr(s.address)}</span><span class="hl-mode">${s.trading ? 'Trading actif' : s.orphanAgent ? 'Lecture seule · agent encore autorisé' : 'Lecture seule'}</span><button type="button" data-act="forget">Oublier</button></div>
      <dl class="facts">
        <div><dt>Valeur du compte</dt><dd>${s.accountValue === null ? '—' : usd(s.accountValue)}</dd></div>
        <div><dt>Disponible</dt><dd>${s.trade ? usd(Math.max(...s.trade.avail)) : s.withdrawable === null ? '—' : usd(s.withdrawable)}</dd></div>
      </dl>
      ${partnerHtml(hl)}${posHtml}${ordersHtml}${ticketHtml}${fillsHtml}
      ${s.keyNote ? html`<p class="note hl-key-note">${s.keyNote}</p>` : ''}${orphanHtml(hl)}${intentsHtml(hl)}
      ${s.error ? html`<p class="hl-error">${s.error}</p>` : ''}`,
    );
    refreshTicket();
  }

  const sizeText = (hl: Hyperliquid) => calc.sizeText(ticket, hl.state.mid, hl.szDecimals);

  /**
   * Taille, curseur, pourcentage et résumé du ticket mis à jour sans redessiner la carte, pour suivre le curseur,
   * la molette et la saisie en direct. `skip` : le champ en cours de saisie, laissé tel quel.
   */
  function refreshTicket(skip?: string): void {
    boundLeverage();
    const hl = cur();
    const q = <T extends HTMLElement>(sel: string) => el.body.querySelector<T>(sel);
    const sum = q<HTMLElement>('[data-tk="sum"]');
    if (!sum) return;
    const buy = ticket.side === 'buy';
    const max = maxUsd(hl, buy);
    const pct = Math.round(powerPct(calc.orderUsdc(ticket, refPrice(hl)), max));
    const avail = availUsd(hl, buy);
    q<HTMLElement>('[data-tk="avail"]')!.textContent = ticket.reduce
      ? `${usd(max)} à réduire`
      : avail === null
        ? '—'
        : `${usd(avail)} · max ${usd(max)}`;
    const set = (name: string, v: string) => {
      const i = q<HTMLInputElement>(`input[name="${name}"]`);
      if (i && name !== skip && i.value !== v) i.value = v;
    };
    set('size', sizeText(hl));
    set('pct', String(pct));
    set('pctBox', String(pct));
    q<HTMLElement>('.tk-track')?.style.setProperty('--fill', `${pct}%`);
    const entry = entryPrice(hl);
    if (!entry) {
      setHtml(
        sum,
        html`<div><dt>${ticket.type === 'limit' ? 'Prix limite à indiquer, ou clic droit sur le graphique' : 'Prix Hyperliquid en attente'}</dt><dd></dd></div>`,
      );
      return;
    }
    const pl = plan(hl, buy, entry);
    const row = (k: string, v: string, tone = '') => html`<div><dt>${k}</dt><dd class="${tone}">${v}</dd></div>`;
    setHtml(
      sum,
      html`${[
        row('Valeur de l’ordre', `${usd(pl.notional)} · ${btc(pl.size)}`),
        row('Marge requise', ticket.reduce ? '—' : usd(pl.notional / effectiveLeverage(hl))),
        pl.risk !== null
          ? row(
              'Perte au stop',
              `${signedUsd(-pl.risk)}${pl.riskShare !== null ? ` · ${calc.pctText(pl.riskShare)} du compte` : ''}`,
              'down',
            )
          : '',
        pl.reward !== null ? row('Gain au TP', `${signedUsd(pl.reward)}${pl.rr !== null ? ` · ${calc.rrText(pl.rr)} R` : ''}`, 'up') : '',
        pl.problem
          ? row('Attention', pl.problem, 'down')
          : max > 0 && pl.notional > max * 1.001
            ? row('Attention', 'au-delà du maximum disponible', 'down')
            : calc.overMaxOrder(pl.notional, maxOrder)
              ? row('Attention', `au-delà de ta taille maximale par ordre (${usd(maxOrder!)})`, 'down')
              : '',
      ]}`,
    );
  }

  /** Règle la taille sur un pourcentage du maximum, sans redessiner la carte. */
  function setPct(pct: number, skip?: string): void {
    const max = maxUsd(cur(), ticket.side === 'buy');
    if (!(max > 0)) return;
    calc.setUsdc(ticket, Math.max(MIN_NOTIONAL, pctToUsdc(pct, max)), refPrice(cur()));
    saveTicket();
    refreshTicket(skip);
  }

  /** Molette : `n` crans vers le haut ou le bas, ×5 (taille) ou ×10 (prix) avec Maj. */
  function wheelStep(t: HTMLInputElement, up: boolean, shift: boolean, n = 1): void {
    const hl = cur();
    const dir = (up ? 1 : -1) * n;
    if (t.name === 'pct' || t.name === 'pctBox' || t.name === 'size') {
      const max = maxUsd(hl, ticket.side === 'buy');
      if (max > 0) return setPct(Math.round(powerPct(calc.orderUsdc(ticket, refPrice(hl)), max)) + (shift ? 5 : 1) * dir);
      // Maximum inconnu : pas de 10 USDC (100 avec Maj).
      calc.setUsdc(ticket, Math.max(MIN_NOTIONAL, calc.orderUsdc(ticket, refPrice(hl)) + (shift ? 100 : 10) * dir), refPrice(hl));
      saveTicket();
      return refreshTicket();
    }
    if (t.name === 'lev') {
      ticket.leverage = calc.leverageStep(ticket.leverage, dir, hl.state.maxLeverage);
      t.value = String(ticket.leverage);
      saveTicket();
      return refreshTicket();
    }
    if (t.name === 'limitPx' || t.name === 'tp' || t.name === 'sl') {
      const base = +t.value > 0 ? +t.value : roundStep(hl.state.mid ?? 0);
      if (!base) return;
      const v = Math.max(priceStep(), roundStep(base + (shift ? 10 : 1) * priceStep() * dir));
      t.value = String(v);
      if (t.name === 'limitPx') ticket.limitPx = v;
      else ticket[t.name as 'tp' | 'sl'] = v;
      refreshTicket();
    }
  }

  /**
   * Agent connu dont la clé n'est pas utilisable ici (perdue, illisible) : il reste autorisé chez Hyperliquid jusqu'à
   * son échéance, la carte le dit et propose de le révoquer (signature du compte, 23/11/2026).
   */
  function orphanHtml(hl: Hyperliquid): SafeHtml {
    const a = hl.state.orphanAgent;
    if (!a || hl.state.trading) return EMPTY_HTML;
    const until = a.until ? `jusqu’au ${calc.dateText(a.until)}` : 'sans échéance connue';
    return html`<div class="hl-partner">
        <p><b>Agent toujours autorisé chez Hyperliquid ${until}</b>${a.address ? ` (${shortAddr(a.address)})` : ''} : ce navigateur n’a plus sa clé et ne peut plus trader avec, mais une copie de la clé le pourrait. Révoque-le (une signature MetaMask du compte), ou réactive le trading, ce qui le remplace.</p>
        <div class="hl-acts small"><button type="button" class="primary" data-act="revoke"${busy ? ' disabled' : ''}>Révoquer</button></div>
      </div>`;
  }

  /**
   * Ordre dont la réponse s'est perdue (23/11/2026) : tant que son sort n'est pas tranché, les ouvertures sont bloquées
   * (fermer, annuler et poser un stop restent possibles). Le bouton le rapproche avec Hyperliquid.
   */
  function intentsHtml(hl: Hyperliquid): SafeHtml {
    const list = hl.state.intents;
    if (!list.length) return EMPTY_HTML;
    const when = new Date(Math.max(...list.map(i => i.at))).toLocaleTimeString('fr-FR');
    return html`<div class="hl-partner">
        <p><b>Ordre en suspens</b> (envoyé à ${when}, réponse d’Hyperliquid perdue) : il a peut-être été reçu. Aucun nouvel ordre d’ouverture ne part tant que son sort n’est pas tranché ; fermer, annuler et poser un stop restent possibles.</p>
        <div class="hl-acts small"><button type="button" class="primary" data-act="check-pending"${busy ? ' disabled' : ''}>Vérifier l’ordre en suspens</button></div>
      </div>`;
  }

  /** Clé locale : proposition de parrainage écartée (« Plus tard ») pour ce compte. */
  const REF_LATER = 'strate:hl-referral-later';
  const referralLater = (a: string) => {
    try {
      return (JSON.parse(localStorage.getItem(REF_LATER) ?? '[]') as string[]).includes(a);
    } catch {
      return false;
    }
  };

  /**
   * Encadrés de l'interface en ligne : frais d'interface à autoriser (une signature MetaMask, une fois), et code de
   * parrainage proposé aux comptes sans parrain. Rien ne s'affiche si l'interface n'en configure pas.
   */
  function partnerHtml(hl: Hyperliquid): SafeHtml {
    const s = hl.state;
    if (!s.trading || !s.address) return EMPTY_HTML;
    const out: SafeHtml[] = [];
    if (PARTNER.builder && s.builderApproved === false)
      out.push(html`<div class="hl-partner">
        <p><b>Frais d’interface : ${feeText(PARTNER.builder.fee)} par ordre exécuté</b> depuis cette app, prélevé par Hyperliquid sur l’ordre et versé à l’éditeur de l’interface. ${PARTNER.required ? 'À autoriser une fois pour pouvoir trader ici' : 'À autoriser une fois'} (signature MetaMask, sans dépôt ni retrait de fonds).</p>
        <div class="hl-acts small"><button type="button" class="primary" data-act="approve-builder"${busy ? ' disabled' : ''}>Autoriser</button></div>
      </div>`);
    if (PARTNER.referral && s.referredBy === 'aucun' && !referralLater(s.address))
      out.push(html`<div class="hl-partner">
        <p><b>Parrainage :</b> ce compte n’a pas encore de parrain. Le code <b>${PARTNER.referral}</b> donne la réduction de frais du programme de parrainage d’Hyperliquid. Facultatif ; un parrain ne se change plus ensuite.</p>
        <div class="hl-acts small"><button type="button" class="primary" data-act="use-referral"${busy ? ' disabled' : ''}>Utiliser le code</button><button type="button" data-act="referral-later">Plus tard</button></div>
      </div>`);
    return html`${out}`;
  }

  /**
   * Activation du trading (23/11/2026) : AVANT la signature, ce qui doit être su (clé gardée en mémoire seulement
   * faute de coffre ; agent HyperChart d'un autre navigateur qui sera remplacé) ; après, le résultat de chaque
   * signature, séparément (l'agent est activé même si la signature du frais d'interface est refusée).
   */
  async function enableTrading(hl: Hyperliquid): Promise<void> {
    if (busy) return;
    let check: Awaited<ReturnType<Hyperliquid['activationCheck']>>;
    try {
      check = await hl.activationCheck();
    } catch {
      check = { sessionOnly: false, replaced: null };
    }
    const pre = calc.activationConfirmation(check);
    if (pre && !(await confirm(hl, pre))) return;
    await run(
      hl,
      'Activation du trading',
      async () => {
        const r = await hl.enableTrading();
        return r.fee ? `${r.agent} ${r.fee}` : r.agent;
      },
      'account',
    );
  }

  /** Révocation de l'agent sans oublier le compte (agent sans clé utilisable ici, 23/11/2026). */
  async function revokeOnly(hl: Hyperliquid): Promise<void> {
    const agent = hl.state.orphanAgent ?? { address: null, until: hl.state.agentUntil };
    if (!(await confirm(hl, calc.revokeConfirmation(agent)))) return;
    await run(hl, 'Révocation de l’agent', async () => (await hl.revokeAgent()).text, 'account');
  }

  /**
   * « Oublier » : un compte dont le trading est activé a un agent autorisé chez Hyperliquid. Effacer sa clé d'ici
   * ne le désactive pas : une copie de la clé resterait utilisable jusqu'à son expiration. L'agent est donc révoqué
   * d'abord (une signature MetaMask) ; si la révocation échoue, l'oubli seul reste possible, en connaissance de cause.
   */
  async function forgetAccount(hl: Hyperliquid): Promise<void> {
    const done = () => {
      // Le second compte oublié : retour au premier.
      if (active > 0) setActive(0);
    };
    // Agent encore autorisé, même sans clé utilisable ici (23/11/2026) : révoqué d'abord, comme un agent actif.
    if (!hl.state.trading && !hl.state.orphanAgent) return void (await hl.forget().then(done));
    const until = hl.state.agentUntil ?? hl.state.orphanAgent?.until ?? null;
    const expiry = until
      ? new Date(until).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
      : 'sans expiration';
    // Action du compte, pas d'un ordre : aucun actif à nommer.
    const ok = await confirm(hl, {
      title: 'Oublier ce compte',
      rows: [
        ['Agent de trading', 'révoqué chez Hyperliquid'],
        ['Clé de l’agent', 'effacée de ce navigateur'],
        ['Signature', 'une, dans MetaMask'],
      ],
      warn: 'La révocation rend la clé inutilisable partout, même si elle a été copiée. Les ordres déjà dans le carnet restent en place.',
      tone: 'flat',
      ok: 'Révoquer et oublier',
    });
    if (!ok || busy) return;
    busy = true;
    hl.state.error = null;
    render();
    let failure: unknown = null;
    let revoked = '';
    try {
      revoked = (await hl.revokeAgent()).text;
    } catch (err) {
      console.error(`[Hyperliquid] ${prefix(hl)}Révocation de l’agent`, err);
      failure = err;
    }
    busy = false;
    render();
    if (failure === null) {
      await hl.forget().then(done);
      return toast(`${prefix(hl)}Compte oublié`, `${revoked} Clé effacée de ce navigateur.`);
    }
    const anyway = await confirm(hl, {
      title: 'Révocation impossible',
      rows: [
        ['Raison', message(failure)],
        ['Agent valable jusqu’au', expiry],
      ],
      warn: 'Oublier quand même efface la clé de ce navigateur, mais l’agent reste autorisé chez Hyperliquid jusqu’à cette date : retire-le depuis app.hyperliquid.xyz (More, API) si la clé a pu être copiée.',
      tone: 'down',
      ok: 'Oublier quand même',
    });
    if (!anyway) return;
    await hl.forget().then(done);
    toast(`${prefix(hl)}Compte oublié`, 'Clé effacée de ce navigateur ; l’agent n’a pas été révoqué chez Hyperliquid.');
  }

  // ───────────── Événements de la carte ─────────────

  /**
   * Actions sur la position et les ordres de l'actif affiché, communes à la carte et au panneau des positions :
   * fermeture d'une part (`data-close`), stop au point mort, annulation d'un ordre (`data-cancel`). Toutes passent
   * par leur fenêtre de confirmation. Vrai si le bouton était l'une d'elles.
   */
  function positionAction(hl: Hyperliquid, t: HTMLElement): boolean {
    if (t.dataset.act !== 'breakeven' && !t.dataset.close && !t.dataset.cancel) return false;
    // Le bouton porte l'actif de la ligne où il a été dessiné : resté à l'écran après une bascule, il viserait la
    // position du nouvel actif. Il est ignoré.
    const coin = t.dataset.coin ?? '';
    if (!stillOn(hl, coin)) return true;
    if (t.dataset.act === 'breakeven') {
      const p = hl.state.position;
      if (p) void protect(hl, coin, 'sl', roundStep(p.entry));
    } else if (t.dataset.close) void closePosition(hl, coin, +t.dataset.close);
    else if (t.dataset.cancel) {
      const o = hl.state.orders.find(x => x.oid === +t.dataset.cancel!);
      if (o) void cancelOrder(hl, coin, o);
    }
    return true;
  }

  el.body.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest('button');
    if (!t) return;
    if (t.dataset.tab) return setActive(+t.dataset.tab);
    if (busy || gate.frozen) return;
    const hl = cur();
    const act = t.dataset.act;
    if (act === 'connect')
      void run(
        hl,
        'Connexion',
        async () => {
          await hl.connect(others(hl));
          return 'Compte connecté (lecture seule tant que le trading n’est pas activé).';
        },
        'account',
      );
    else if (act === 'approve-builder')
      void run(
        hl,
        'Frais d’interface',
        async () => {
          await hl.approveBuilder();
          return 'Autorisé : il s’applique aux ordres passés depuis cette app.';
        },
        'account',
      );
    else if (act === 'use-referral')
      void run(
        hl,
        'Parrainage',
        async () => {
          await hl.useReferral();
          return `Code ${PARTNER.referral} enregistré sur ce compte.`;
        },
        'account',
      );
    else if (act === 'referral-later') {
      try {
        const list = JSON.parse(localStorage.getItem(REF_LATER) ?? '[]') as string[];
        localStorage.setItem(REF_LATER, JSON.stringify([...list, hl.state.address]));
      } catch {
        /* rien */
      }
      render();
    } else if (act === 'enable' && !riskAccepted()) {
      // Première activation sur cet appareil : l'avertissement de risque d'abord, à cocher une fois.
      riskOpen = true;
      render();
    } else if (act === 'risk-cancel') {
      riskOpen = riskChecked = false;
      render();
    } else if (act === 'risk-accept') {
      if (!riskChecked) return;
      try {
        localStorage.setItem(RISK_ACK_KEY, String(Date.now()));
      } catch {
        /* stockage indisponible : l'avertissement reviendra à la prochaine activation */
      }
      riskOpen = riskChecked = false;
      render();
      void enableTrading(hl);
    } else if (act === 'enable') void enableTrading(hl);
    else if (act === 'forget') void forgetAccount(hl);
    else if (act === 'revoke') void revokeOnly(hl);
    else if (act === 'check-pending') void run(hl, 'Ordre en suspens', () => hl.checkPending(), 'account');
    else if (act === 'submit') void openEntry(hl, asset.coin, ticket.side === 'buy');
    else if (t.dataset.side) {
      ticket.side = t.dataset.side === 'sell' ? 'sell' : 'buy';
      saveTicket();
      render();
    } else if (t.dataset.type) {
      ticket.type = t.dataset.type === 'limit' ? 'limit' : 'market';
      saveTicket();
      render();
    } else if (t.dataset.pct) setPct(+t.dataset.pct);
    else if (act === 'unit') {
      calc.switchUnit(ticket, refPrice(hl));
      saveTicket();
      render();
    } else if (act === 'mid') {
      if (hl.state.mid) ticket.limitPx = roundStep(hl.state.mid);
      render();
    } else if (act === 'risk-size') {
      const r = calc.riskSize(ticket, hl.state, ticket.side === 'buy');
      if (calc.refused(r)) return toast('Taille au risque', r.problem);
      calc.setUsdc(ticket, r.usdc, refPrice(hl));
      saveTicket();
      refreshTicket();
      if (r.warning) toast('Taille au risque', r.warning);
    } else positionAction(hl, t);
  });
  // Panneau des positions sous le graphique : ses boutons (ligne de l'actif affiché seulement) passent par le même
  // code que ceux de la carte, avec les mêmes confirmations, sur le compte de l'onglet choisi.
  document.getElementById('pos-body')?.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest('button');
    if (!t || busy || gate.frozen) return;
    positionAction(cur(), t);
  });
  el.body.addEventListener('submit', e => {
    e.preventDefault();
    const hl = cur();
    const input = (e.target as HTMLFormElement).querySelector('input') as HTMLInputElement;
    void hl.watchAddress(input.value, others(hl)).catch(err => toast('Adresse refusée', message(err)));
  });
  el.body.addEventListener('change', e => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t.name === 'riskAck') {
      // Pas de nouveau rendu (la case garde le focus) : seul le bouton « Continuer » suit la case.
      riskChecked = (t as HTMLInputElement).checked;
      const go = el.body.querySelector<HTMLButtonElement>('button[data-act="risk-accept"]');
      if (go) go.disabled = !riskChecked;
      return;
    }
    if (t.name === 'maxOrder') {
      maxOrder = calc.maxOrderInput(t.value);
      t.value = maxOrder === null ? '' : String(maxOrder);
      try {
        if (maxOrder === null) localStorage.removeItem(MAX_ORDER_KEY);
        else localStorage.setItem(MAX_ORDER_KEY, String(maxOrder));
      } catch {
        /* stockage indisponible : le plafond vaut pour cette session */
      }
      return refreshTicket();
    }
    if (t.name === 'reduce' || t.name === 'tpsl') {
      ticket[t.name] = (t as HTMLInputElement).checked;
      saveTicket();
      return render();
    }
    const risk = t.name === 'riskPct' ? calc.riskPctInput(t.value) : null;
    if (risk !== null) ticket.riskPct = risk;
    else if (t.name === 'lev') ticket.leverage = calc.leverageInput(t.value, cur().state.maxLeverage);
    else if (t.name === 'mode') ticket.cross = t.value === 'cross';
    else return refreshTicket();
    saveTicket();
    render();
  });
  // Saisie en direct : taille, curseur, pourcentage et prix se suivent sans redessiner la carte.
  el.body.addEventListener('input', e => {
    const t = e.target as HTMLInputElement;
    const hl = cur();
    const price = calc.priceInput;
    if (t.name === 'pct' || t.name === 'pctBox') return setPct(+t.value, t.name === 'pctBox' ? 'pctBox' : undefined);
    if (t.name === 'size') {
      const v = calc.parseSize(t.value);
      if (v === null) return;
      calc.setSize(ticket, v, refPrice(hl));
      saveTicket();
      return refreshTicket('size');
    }
    if (t.name === 'limitPx') ticket.limitPx = price(t.value);
    else if (t.name === 'sl') ticket.sl = price(t.value);
    else if (t.name === 'tp') ticket.tp = price(t.value);
    else return;
    refreshTicket(t.name);
  });
  // Molette sur la taille, le curseur, le pourcentage, le levier et les prix (Maj : pas plus grand).
  el.body.addEventListener(
    'wheel',
    e => {
      const t = e.target as HTMLInputElement;
      if (
        !t.matches?.(
          '.hl-ticket input[name="pct"], .hl-ticket input[name="pctBox"], .hl-ticket input[name="size"], .hl-ticket input[name="lev"], .hl-ticket input[name="limitPx"], .hl-ticket input[name="tp"], .hl-ticket input[name="sl"]',
        )
      )
        return;
      // Seulement sur le champ en cours de saisie : faire défiler le panneau au-dessus du ticket ne doit changer ni
      // une taille, ni un prix, ni un stop.
      if (document.activeElement !== t) return;
      e.preventDefault();
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!d) return;
      // Un cran de molette vaut environ 100 px (une seule rafale peut en porter plusieurs) ; pavé tactile : 1 pas.
      wheelStep(
        t,
        d < 0,
        e.shiftKey,
        e.deltaMode === 1 ? Math.max(1, Math.round(Math.abs(d) / 3)) : Math.max(1, Math.round(Math.abs(d) / 100)),
      );
    },
    { passive: false },
  );
  render();

  return {
    /** Entrées du menu du clic droit au prix visé, pour le compte de l'onglet choisi. */
    menu(price: number, line?: TradeLine | null): TradeMenuItem[] {
      // Actif affiché à l'ouverture du menu : chaque entrée le porte jusqu'à l'envoi (revérifié à chaque étape).
      const coin = asset.coin;
      if (gate.frozen)
        return [
          {
            label: 'Changement d’actif en cours : trading suspendu',
            icon: html`<path d="M12 8v4M12 16h.01" />`,
            disabled: true,
            run: () => {},
          },
        ];
      // Clic droit sur la ligne d'un ordre : l'annuler, pour le compte qui le porte (pas forcément l'onglet choisi).
      const hit = line ? lineOrder(line) : null;
      const cancel: TradeMenuItem[] =
        hit && hit.hl.state.trading
          ? [
              {
                label: `${prefix(hit.hl)}Annuler : ${hit.o.label} à ${f.price(hit.o.price)}`,
                icon: html`<path d="M6 6l12 12M18 6L6 18" />`,
                danger: true,
                run: () => void cancelOrder(hit.hl, line?.coin ?? coin, hit.o),
              },
            ]
          : [];
      const hl = cur();
      const s = hl.state;
      const p = roundStep(price);
      const items: TradeMenuItem[] = [...cancel];
      if (s.trading) {
        const pre = prefix(hl);
        const extra = tpOf() || slOf() ? ' (TP / SL du ticket)' : '';
        items.push(
          {
            label: `${pre}Acheter en limite à ${f.price(p)}${extra}`,
            icon: html`<path d="M12 19V5M6 11l6-6 6 6" />`,
            run: () => void openEntry(hl, coin, true, p),
          },
          {
            label: `${pre}Vendre en limite à ${f.price(p)}${extra}`,
            icon: html`<path d="M12 5v14M6 13l6 6 6-6" />`,
            run: () => void openEntry(hl, coin, false, p),
          },
        );
        // Sans position : le prix visé peut remplir le ticket (stop, objectif) avant l'entrée.
        if (!s.position) {
          const fill = (k: 'sl' | 'tp', what: string) => () => {
            ticket[k] = p;
            ticket.tpsl = true;
            ticket.reduce = false;
            render();
            toast('Ticket', `${what} à ${f.price(p)}`);
          };
          items.push(
            { label: `Ticket : stop loss à ${f.price(p)}`, icon: html`<path d="M4 7h16M4 12h10M4 17h6" />`, run: fill('sl', 'Stop loss') },
            {
              label: `Ticket : take profit à ${f.price(p)}`,
              icon: html`<path d="M4 7h16M4 12h10M4 17h6" />`,
              run: fill('tp', 'Take profit'),
            },
          );
        }
      }
      // Take profit et stop loss pour chaque compte qui a une position, pas seulement celui de l'onglet choisi.
      const none = () => {};
      for (const a of [hl, ...accounts.filter(x => x !== hl)]) {
        const pos = a.state.position;
        if (!pos || !a.state.address) continue;
        const pre = prefix(a);
        const long = pos.size > 0;
        if (!a.state.trading) {
          items.push({
            label: `${pre}Take profit / stop loss : compte en lecture seule, autorise le trading dans la carte Hyperliquid`,
            icon: html`<path d="M5 12l5 5L20 7" />`,
            disabled: true,
            run: none,
          });
          continue;
        }
        // TP / SL contrôlés sur le mark price, qui les déclenche chez Hyperliquid (23/11/2026) ; le milieu en repli.
        const mid = a.triggerPrice();
        if (!mid) {
          items.push({
            label: `${pre}Take profit : prix Hyperliquid pas encore reçu`,
            icon: html`<path d="M5 12l5 5L20 7" />`,
            disabled: true,
            run: none,
          });
          continue;
        }
        const tpOk = !checkTrigger(long, 'tp', p, mid);
        const split = a.tpSplit();
        const TP_ICON = html`<path d="M5 12l5 5L20 7" />`;
        if (!tpOk)
          items.push({
            label: `${pre}Take profit : clic droit ${long ? 'au-dessus' : 'au-dessous'} de ${f.price(mid)} pour un ${long ? 'long' : 'short'}`,
            icon: TP_ICON,
            disabled: true,
            run: none,
          });
        else {
          items.push(
            split.fullSize > 0
              ? {
                  label: `${pre}TP limite ${split.partialSize > 0 ? 'du reste' : 'complet'} à ${f.price(p)}${split.full ? ' (déplace l’actuel)' : ''}`,
                  icon: TP_ICON,
                  run: () => void protect(a, coin, 'tp', p),
                }
              : { label: `${pre}TP complet : les TP partiels couvrent déjà toute la position`, icon: TP_ICON, disabled: true, run: none },
          );
          const k = 10 ** a.szDecimals;
          const room = Math.floor((Math.abs(pos.size) - split.partialSize) * k + 1e-6) / k;
          if (room > 0)
            for (const share of [0.25, 0.33, 0.5])
              items.push({
                label: `${pre}TP partiel ${Math.round(share * 100)} % à ${f.price(p)}`,
                icon: TP_ICON,
                run: () => void partialTp(a, coin, p, share),
              });
        }
        if (!checkTrigger(long, 'sl', p, mid))
          items.push({
            label: `${pre}Stop loss à ${f.price(p)}`,
            icon: html`<path d="M6 6l12 12M18 6L6 18" />`,
            danger: true,
            run: () => void protect(a, coin, 'sl', p),
          });
      }
      return items;
    },

    freeze() {
      gate.frozen = true;
      confirmBox.cancelOpen();
      render();
    },

    drain: () => gate.drain(accounts),

    switched() {
      const coin = asset.coin;
      for (const hl of accounts) void hl.setCoin(coin);
      // Ticket : repasse en USDC (une quantité saisie en unités de l'ancien actif n'a plus de sens), prix vidés.
      if (ticket.unit !== 'usdc') ticket.unit = 'usdc';
      ticket.qty = null;
      ticket.limitPx = ticket.tp = ticket.sl = null;
      ticket.reduce = false;
      saveTicket();
      gate.resume(accounts);
      render();
    },

    resume() {
      gate.resume(accounts);
      render();
    },
  };
}
