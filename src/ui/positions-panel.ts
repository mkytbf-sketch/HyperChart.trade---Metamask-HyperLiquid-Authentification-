// Panneau des positions, sous le graphique (charte B2 · Focus, 21/11/2026) : onglets « Positions » et « Ordres
// ouverts » du compte Hyperliquid choisi dans la carte de droite, toutes les positions du compte (pas seulement
// l'actif affiché), et un pied avec la valeur du compte, la marge utilisée et le PnL non réalisé total.
//
// Sécurité : ce module ne passe aucun ordre. Il dessine le panneau (`positionsHtml`, fonction pure) ; les boutons
// d'action portent les mêmes attributs que ceux de la carte Hyperliquid (`data-close`, `data-act="breakeven"`,
// `data-cancel`) et c'est trade-ui.ts qui les traite, par le même code et avec les mêmes confirmations. Ces boutons
// n'existent que sur la ligne de l'actif affiché ; une autre ligne n'a qu'un bouton « Afficher » (changement d'actif).
// Chaque bouton d'action porte aussi son actif (`data-coin`) : trade-ui.ts ignore un bouton resté à l'écran après un
// changement d'actif, qui viserait sinon la position du nouvel actif.
//
// Sans compte suivi (trading pas encore chargé), le panneau garde le bandeau d'index.html. Il se replie sur son
// titre (réglage retenu), ce qui rend la hauteur au graphique.
import type { HlAnyPosition, HlOrder, HlOtherOrder } from '../hyperliquid';
import { chooseCoin, rowPrice } from '../coin-picker';
import * as f from '../format';
import { EMPTY_HTML, html, type SafeHtml } from '../safe-html';
import { coinLogoHtml } from './coin-logo';
import { $, setHtml, setText } from './dom';
import type { Settings } from './settings';

/** Ce que le panneau affiche, préparé par trade-ui.ts à partir du compte choisi. */
export interface PositionsView {
  /** Compte affiché (« C1 · 0x1234…abcd »), null sans compte suivi. */
  account: string | null;
  /** Trading activé sur ce compte : les boutons d'action de l'actif affiché apparaissent. */
  trading: boolean;
  /** Une action de trading est en cours : les boutons sont grisés. */
  busy: boolean;
  /** Actif affiché sur le graphique. */
  shownCoin: string;
  positions: HlAnyPosition[];
  /** Ordres de l'actif affiché (annulables depuis le panneau, comme depuis la carte). */
  orders: HlOrder[];
  /** Ordres des autres actifs (lecture seule). */
  otherOrders: HlOtherOrder[];
  /** « Stop au point mort » possible pour la position de l'actif affiché (même condition que la carte). */
  breakeven: boolean;
  accountValue: number | null;
  marginUsed: number | null;
}

/** Prix d'un actif quelconque : décimales de l'actif affiché pour lui, selon le niveau du prix pour les autres. */
const px = (coin: string, shown: string, v: number) => (coin === shown ? f.price(v) : rowPrice(v));
const qty = (v: number, coin: string) => `${v.toLocaleString('fr-FR', { maximumFractionDigits: 6 })} ${coin}`;
const dash = html`<span class="pos-none">—</span>`;

/** TP et SL posés sur la position d'un actif : premier TP, premier SL de ses ordres ouverts. */
function tpsl(orders: HlOrder[], shown: (v: number) => string): SafeHtml {
  const tp = orders.find(o => o.kind === 'tp');
  const sl = orders.find(o => o.kind === 'sl');
  return html`${tp ? html`<span class="up">${shown(tp.price)}</span>` : dash} / ${sl ? html`<span class="down">${shown(sl.price)}</span>` : dash}`;
}

/** Une ligne de position. Actions : celles de la carte pour l'actif affiché, « Afficher » pour les autres. */
function positionRow(p: HlAnyPosition, v: PositionsView): SafeHtml {
  const long = p.size > 0;
  const side = long ? 'up' : 'down';
  const coin = p.coin;
  const isShown = p.coin === v.shownCoin;
  const fmt = (x: number) => px(p.coin, v.shownCoin, x);
  const size = Math.abs(p.size);
  const mark = size > 0 ? Math.abs(p.value) / size : null;
  const orders = isShown ? v.orders : v.otherOrders.filter(o => o.coin === p.coin);
  const dis = v.busy ? html` disabled` : '';
  const actions = isShown
    ? v.trading
      ? html`<button type="button" data-close="0.25" data-coin="${coin}" aria-label="Fermer 25 % de la position ${coin}"${dis}>25 %</button><button type="button" data-close="0.5" data-coin="${coin}" aria-label="Fermer 50 % de la position ${coin}"${dis}>50 %</button><button type="button" data-close="1" data-coin="${coin}" class="danger" aria-label="Fermer toute la position ${coin}"${dis}>Fermer</button>${
          v.breakeven
            ? html`<button type="button" data-act="breakeven" data-coin="${coin}"${dis} title="Stop loss au prix d’entrée. Exécuté au marché une fois déclenché : le prix obtenu peut différer (glissement, frais), et l’exécution peut être partielle ou ne pas avoir lieu dans un marché très rapide">Point mort</button>`
            : ''
        }`
      : html`<span class="pos-none" title="Active le trading dans la carte Hyperliquid pour agir sur la position">Lecture seule</span>`
    : html`<button type="button" data-show="${coin}" aria-label="Afficher ${coin} sur le graphique" title="Afficher ${coin} sur le graphique">Afficher</button>`;
  return html`<tr data-side="${side}"${isShown ? html` class="shown"` : ''}>
    <th scope="row"><span class="pos-coin"><i class="pos-bar" aria-hidden="true"></i>${coinLogoHtml(p.coin, 20)}<span><b>${coin}</b><small class="${side}">${long ? 'Long' : 'Short'} · ${String(p.leverage)}× ${p.cross ? 'croisé' : 'isolé'}</small></span></span></th>
    <td>${qty(size, coin)}</td>
    <td>${f.usdc(Math.abs(p.value))}</td>
    <td>${fmt(p.entry)}</td>
    <td>${mark === null ? dash : fmt(mark)}</td>
    <td class="liq">${p.liquidation ? fmt(p.liquidation) : dash}</td>
    <td>${f.usdc(p.margin)}</td>
    <td class="${p.pnl >= 0 ? 'up' : 'down'}">${f.signedUsdc(p.pnl)} <small>(${f.signed(p.roe * 100, 1)} %)</small></td>
    <td>${tpsl(orders, fmt)}</td>
    <td class="pos-acts">${actions}</td>
  </tr>`;
}

/** Une ligne d'ordre ouvert. L'annulation n'existe que pour l'actif affiché (même code que la carte). */
function orderRow(o: HlOrder | HlOtherOrder, v: PositionsView): SafeHtml {
  const coin = 'coin' in o ? o.coin : v.shownCoin;
  const isShown = coin === v.shownCoin;
  const c = coin;
  const fmt = (x: number) => px(coin, v.shownCoin, x);
  const action = isShown
    ? v.trading
      ? html`<button type="button" data-cancel="${o.oid}" data-coin="${c}" aria-label="Annuler l’ordre ${o.label} à ${fmt(o.price)}"${v.busy ? html` disabled` : ''}>Annuler</button>`
      : ''
    : html`<button type="button" data-show="${c}" aria-label="Afficher ${c} sur le graphique" title="Afficher ${c} sur le graphique">Afficher</button>`;
  return html`<tr data-side="${o.buy ? 'up' : 'down'}">
    <th scope="row"><span class="pos-coin">${coinLogoHtml(coin, 20)}<b>${c}</b></span></th>
    <td class="left">${o.label}</td>
    <td class="${o.buy ? 'up' : 'down'}">${o.buy ? 'Achat' : 'Vente'}</td>
    <td>${fmt(o.price)}</td>
    <td>${o.position ? 'position' : qty(o.size, c)}</td>
    <td>${o.position ? dash : f.usdc(o.size * o.price)}</td>
    <td class="pos-acts">${action}</td>
  </tr>`;
}

/** Contenu du panneau en fragments sûrs : tableaux des deux onglets, nombres des onglets, pied. Fonction pure. */
export function positionsFragments(v: PositionsView): {
  positions: SafeHtml;
  orders: SafeHtml;
  nPos: number;
  nOrd: number;
  foot: SafeHtml;
} {
  // La position de l'actif affiché d'abord, puis les autres par valeur décroissante.
  const pos = [...v.positions].sort(
    (a, b) => +(b.coin === v.shownCoin) - +(a.coin === v.shownCoin) || Math.abs(b.value) - Math.abs(a.value),
  );
  const ords: (HlOrder | HlOtherOrder)[] = [...v.orders, ...v.otherOrders];
  const positions = pos.length
    ? html`<table class="pos-table">
        <thead><tr><th scope="col" class="left">Actif</th><th scope="col">Taille</th><th scope="col">Valeur</th><th scope="col">Entrée</th><th scope="col">Prix de marque</th><th scope="col">Liquidation</th><th scope="col">Marge</th><th scope="col">PnL (ROE)</th><th scope="col">TP / SL</th><th scope="col">Actions</th></tr></thead>
        <tbody>${pos.map(p => positionRow(p, v))}</tbody>
      </table>`
    : html`<p class="pos-empty">Aucune position ouverte sur ce compte.</p>`;
  const orders = ords.length
    ? html`<table class="pos-table">
        <thead><tr><th scope="col" class="left">Actif</th><th scope="col" class="left">Type</th><th scope="col">Sens</th><th scope="col">Prix</th><th scope="col">Taille</th><th scope="col">Valeur</th><th scope="col">Actions</th></tr></thead>
        <tbody>${ords.map(o => orderRow(o, v))}</tbody>
      </table>`
    : html`<p class="pos-empty">Aucun ordre ouvert sur ce compte.</p>`;
  const pnl = v.positions.reduce((s, p) => s + p.pnl, 0);
  const foot = html`${[
    v.accountValue === null ? '' : html`<span><span class="lbl">Valeur du compte</span> ${f.usdc(v.accountValue)}</span>`,
    v.marginUsed === null
      ? ''
      : html`<span><span class="lbl">Marge utilisée</span> ${f.usdc(v.marginUsed)}${v.accountValue ? html` <small>(${f.num((v.marginUsed / v.accountValue) * 100, 1)} %)</small>` : ''}</span>`,
    v.positions.length
      ? html`<span><span class="lbl">PnL non réalisé</span> <span class="${pnl >= 0 ? 'up' : 'down'}">${f.signedUsdc(pnl)}</span></span>`
      : '',
  ]}`;
  return { positions, orders, nPos: pos.length, nOrd: ords.length, foot };
}

/** Même contenu en texte HTML (tests, comparaisons). L'écriture dans la page passe par `positionsFragments`. */
export function positionsHtml(v: PositionsView): { positions: string; orders: string; nPos: number; nOrd: number; foot: string } {
  const h = positionsFragments(v);
  return { ...h, positions: h.positions.toString(), orders: h.orders.toString(), foot: h.foot.toString() };
}

/** Bouton du panneau enfoncé (souris ou doigt) ; rendu demandé pendant ce temps, fait au relâchement. */
let holding = false;
let pending: PositionsView | null = null;

/** Écrit le panneau (appelé par trade-ui.ts à chaque rendu du compte). null : aucun compte suivi, bandeau d'accueil. */
export function renderPositions(v: PositionsView | null): void {
  const body = document.getElementById('pos-body');
  if (!body) return;
  const panel = document.getElementById('positions')!;
  panel.dataset.account = v ? 'on' : 'off';
  if (!v) {
    setHtml(body, html`<p class="pos-banner">${BANNER}</p>`);
    setText($('#pos-n'), '');
    setText($('#ord-n'), '');
    setText($('#pos-acct'), '');
    setHtml($('#pos-foot'), EMPTY_HTML);
    return;
  }
  // Bouton enfoncé dans le panneau : le rendu attend qu'il soit relâché, pour que le clic arrive sur le bouton visé
  // (les chiffres changent à chaque prix et le tableau est réécrit).
  if (holding) {
    pending = v;
    return;
  }
  const h = positionsFragments(v);
  // Le focus clavier reste sur le même bouton après la réécriture du tableau.
  const active = document.activeElement;
  const keep =
    active instanceof HTMLElement && body.contains(active)
      ? ['data-close', 'data-act', 'data-cancel', 'data-show']
          .map(k => (active.hasAttribute(k) ? `[${k}="${CSS.escape(active.getAttribute(k)!)}"]` : ''))
          .join('')
      : '';
  setHtml(
    body,
    html`<div class="pos-pane" data-pane="positions">${h.positions}</div><div class="pos-pane" data-pane="orders">${h.orders}</div>`,
  );
  if (keep && !body.contains(document.activeElement)) body.querySelector<HTMLElement>(keep)?.focus();
  setText($('#pos-n'), String(h.nPos));
  setText($('#ord-n'), String(h.nOrd));
  setText($('#pos-acct'), v.account ?? '');
  setHtml($('#pos-foot'), h.foot);
}

/** Bandeau du panneau sans compte suivi (le même est écrit dans index.html, avant le chargement du trading). */
export const BANNER = 'Connecte ou suis un compte Hyperliquid pour voir ici tes positions et tes ordres ouverts.';

/** Onglets et repli du panneau ; l'onglet ouvert et l'état replié sont retenus dans les réglages. */
export function setupPositionsPanel(settings: Settings, saveSettings: () => void): void {
  const panel = $('#positions');
  const fold = $<HTMLButtonElement>('#pos-fold');
  const tabs = [...panel.querySelectorAll<HTMLButtonElement>('[data-pos-tab]')];
  const body = $('#pos-body');
  function apply(): void {
    const folded = !!settings.posFolded;
    const tab = settings.posTab === 'orders' ? 'orders' : 'positions';
    document.body.classList.toggle('pos-folded', folded);
    panel.dataset.tab = tab;
    fold.setAttribute('aria-expanded', String(!folded));
    fold.setAttribute('aria-label', folded ? 'Déplier le panneau des positions' : 'Replier le panneau des positions');
    fold.title = fold.getAttribute('aria-label')!;
    for (const t of tabs) {
      const on = t.dataset.posTab === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      // Le panneau porte le nom de l'onglet ouvert.
      if (on) body.setAttribute('aria-labelledby', t.id);
    }
  }
  fold.addEventListener('click', () => {
    settings.posFolded = !settings.posFolded;
    saveSettings();
    apply();
  });
  for (const t of tabs)
    t.addEventListener('click', () => {
      settings.posTab = t.dataset.posTab === 'orders' ? 'orders' : 'positions';
      // Un onglet choisi panneau replié le déplie.
      settings.posFolded = false;
      saveSettings();
      apply();
    });
  body.addEventListener('pointerdown', e => {
    if ((e.target as HTMLElement).closest('button')) holding = true;
  });
  const release = () => {
    if (!holding) return;
    holding = false;
    // Après le clic (qui suit le relâchement) : le tableau est réécrit avec l'état du moment.
    window.setTimeout(() => {
      if (pending && !holding) {
        const v = pending;
        pending = null;
        renderPositions(v);
      }
    }, 0);
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  // « Afficher » : l'actif d'une autre ligne passe sur le graphique (même chemin que la liste des actifs).
  body.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-show]');
    if (b) chooseCoin(b.dataset.show!);
  });
  // Flèches gauche et droite entre les onglets (motif « tablist »).
  panel.querySelector('[role="tablist"]')!.addEventListener('keydown', e => {
    const k = (e as KeyboardEvent).key;
    if (k !== 'ArrowLeft' && k !== 'ArrowRight') return;
    const i = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
    const next = tabs[(i + (k === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.click();
    next.focus();
    e.preventDefault();
  });
  apply();
}
