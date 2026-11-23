/**
 * Trading et changement d'actif sans rechargement (docs/CHANGEMENT-ACTIF-A-CHAUD.md, § 3) : les pièces de trade-ui.ts
 * qui décident de ce qui peut partir pendant et après une bascule, sorties ici pour être testées sans navigateur.
 *
 *  - `createConfirm` : la fenêtre de confirmation d'un ordre. `cancelOpen()` (gel au début d'une bascule) la ferme
 *    et la résout à « annulé » : l'ordre affiché, préparé pour l'ancien actif, ne part pas.
 *  - `TradeGate` : le gel de l'interface de trading. Gelée, aucune action ne commence ; `drain()` attend la fin de
 *    celles déjà confirmées (une entrée suivie de son TP et de son SL va à son terme sur son actif), puis gèle les
 *    comptes, qui attendent eux-mêmes leurs envois en cours.
 *  - `tradeLines` : les lignes de position et d'ordres du graphique, tirées de l'état des comptes. Après `setCoin`,
 *    cet état ne contient plus rien de l'ancien actif : ses lignes disparaissent.
 */
import type { TradeLine } from './chart';
import * as f from './format';
import { exitPnl, type HlOrder, type HlState } from './hyperliquid';
import { signedUsdc as signedUsd, usdc as usd } from './format';

// ───────────── Confirmation ─────────────

/** Ce que la confirmation utilise de la page : la fenêtre (`<dialog>`) et ses deux boutons. */
export interface ConfirmParts {
  dialog: Pick<HTMLDialogElement, 'open' | 'showModal' | 'close' | 'addEventListener' | 'removeEventListener'>;
  ok: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>;
  cancel: Pick<HTMLElement, 'addEventListener' | 'removeEventListener' | 'focus'>;
}

export interface Confirm {
  /** Ouvre la fenêtre (son contenu est déjà écrit) ; vrai si l'utilisateur confirme. */
  ask(): Promise<boolean>;
  /** Ferme la fenêtre ouverte, s'il y en a une, et la résout à « annulé ». */
  cancelOpen(): void;
}

export function createConfirm(parts: ConfirmParts): Confirm {
  const { dialog, ok, cancel } = parts;
  /** Fin de la confirmation ouverte (null : aucune). */
  let current: ((v: boolean) => void) | null = null;
  return {
    ask() {
      // Une confirmation encore ouverte (cas improbable) est annulée : une seule à la fois.
      current?.(false);
      dialog.showModal();
      cancel.focus();
      return new Promise<boolean>(resolve => {
        const done = (v: boolean) => {
          ok.removeEventListener('click', yes);
          cancel.removeEventListener('click', no);
          dialog.removeEventListener('close', closed);
          if (current === done) current = null;
          if (dialog.open) dialog.close();
          resolve(v);
        };
        const yes = () => done(true);
        const no = () => done(false);
        // close() n'émet « close » qu'un instant plus tard : si une autre confirmation s'est ouverte entre-temps,
        // l'événement de la précédente arrive sur une fenêtre ouverte et ne doit pas la refermer.
        const closed = () => {
          if (!dialog.open) done(false);
        };
        current = done;
        ok.addEventListener('click', yes);
        cancel.addEventListener('click', no);
        dialog.addEventListener('close', closed);
      });
    },
    cancelOpen() {
      current?.(false);
    },
  };
}

// ───────────── Gel pendant une bascule ─────────────

/** Ce que le gel utilise d'un compte (`Hyperliquid`). */
export interface Drainable {
  drain(): Promise<void>;
  unfreeze(): void;
}

export class TradeGate {
  /** Vrai entre le début d'une bascule et le départ du nouvel actif (ou son abandon) : rien ne commence. */
  frozen = false;
  private readonly jobs = new Set<Promise<unknown>>();
  /**
   * Incrémenté à chaque dégel : un `drain()` commencé avant ne gèle plus les comptes à sa fin (bascule abandonnée
   * pendant l'attente des actions confirmées ; sans cela, les comptes resteraient gelés pour de bon).
   */
  private epoch = 0;

  /**
   * Suit une action de trading confirmée, jusqu'à sa fin. `kind` : seules les actions qui dépendent de l'actif
   * (`'order'` : envoi, modification, annulation d'ordres) sont attendues par la bascule ; celles du compte
   * (`'account'` : connexion, signatures MetaMask, parrainage) ne la retiennent pas (une fenêtre MetaMask
   * laissée ouverte bloquerait sinon le changement d'actif sans limite).
   */
  track<T>(job: Promise<T>, kind: 'order' | 'account' = 'order'): Promise<T> {
    if (kind === 'account') return job;
    this.jobs.add(job);
    const done = () => void this.jobs.delete(job);
    job.then(done, done);
    return job;
  }

  /** Actions confirmées en cours. */
  get busy(): boolean {
    return this.jobs.size > 0;
  }

  /**
   * Gèle, puis attend la fin des actions confirmées et des envois des comptes. Dégelé entre-temps (`resume` :
   * bascule abandonnée) : les comptes ne sont pas gelés.
   */
  async drain(accounts: readonly Drainable[]): Promise<void> {
    const epoch = this.epoch;
    this.frozen = true;
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
    if (epoch !== this.epoch) return;
    await Promise.all(accounts.map(a => a.drain()));
  }

  /** Dégèle (nouvel actif en place, ou bascule abandonnée). */
  resume(accounts: readonly Drainable[]): void {
    this.epoch++;
    this.frozen = false;
    for (const a of accounts) a.unfreeze();
  }
}

// ───────────── Lignes du graphique ─────────────

/** Résultat d'un TP ou d'un SL exécuté à `at`, hors frais (voir `exitPnl`). */
export const exitResult = (s: Pick<HlState, 'position'>, o: HlOrder, at = o.price): number | null => exitPnl(s.position, o, at);

/**
 * Part de la position qu'un TP limite ferme, à accoler à son libellé (« TP partiel 25 % ») ; vide pour tout autre
 * ordre ou sans position. Seule implémentation, partagée par les lignes du graphique et la liste de la carte.
 */
export function tpShare(s: Pick<HlState, 'position'>, o: Pick<HlOrder, 'kind' | 'trigger' | 'size'>): string {
  const pos = s.position;
  if (o.kind !== 'tp' || o.trigger || !pos || !pos.size) return '';
  return ` ${Math.round((Math.min(o.size, Math.abs(pos.size)) / Math.abs(pos.size)) * 100)} %`;
}

/** Étiquette d'un ordre sur sa ligne : gain ou perte pour un TP / SL, montant de l'ordre sinon. */
export function orderTitle(s: Pick<HlState, 'position'>, o: HlOrder): string {
  const r = exitResult(s, o);
  const share = tpShare(s, o);
  if (r !== null) return `${o.label}${share} ${signedUsd(r)}`;
  return o.position ? o.label : `${o.label} ${usd(o.size * o.price)}`;
}

/** Couleurs des lignes (lues dans le thème par l'appelant). */
export interface LineColors {
  up: string;
  down: string;
  blue: string;
}

/**
 * Lignes de la position (entrée, liquidation) et des ordres de chaque compte suivi, pour l'actif du compte
 * (`coin`, porté par chaque ligne : un glissement commencé sur l'ancien actif est refusé). `prefix` : « C1 · »
 * quand plusieurs comptes sont suivis. Fonction pure.
 */
export function tradeLines(
  accounts: readonly { state: HlState; coin: string }[],
  colors: LineColors,
  prefix: (k: number) => string,
): TradeLine[] {
  const out: TradeLine[] = [];
  const { up, down, blue } = colors;
  accounts.forEach((hl, k) => {
    const s = hl.state;
    if (!s.address) return;
    const pre = prefix(k);
    const coin = hl.coin;
    const p = s.position;
    if (p) {
      out.push({
        id: `${k}:entry`,
        coin,
        price: p.entry,
        color: p.size > 0 ? up : down,
        title: `${pre}${p.size > 0 ? 'Long' : 'Short'} ${usd(Math.abs(p.value))} · ${signedUsd(p.pnl)}`,
      });
      if (p.liquidation !== null && p.liquidation > 0)
        out.push({ id: `${k}:liq`, coin, price: p.liquidation, color: down, title: `${pre}Liquidation`, dashed: true });
    }
    for (const o of s.orders) {
      const color = o.kind === 'tp' ? up : o.kind === 'sl' ? down : blue;
      const preview =
        exitResult(s, o) === null ? undefined : (at: number) => `${pre}${o.label} ${signedUsd(exitResult(s, o, at)!)} · ${f.price(at)}`;
      out.push({
        id: `${k}:o:${o.oid}`,
        coin,
        price: o.price,
        color,
        title: `${pre}${orderTitle(s, o)}`,
        dashed: o.kind !== 'limit',
        draggable: s.trading,
        preview,
      });
      // TP / SL rattachés à une entrée qui attend au carnet (23/11/2026) : tracés, mais dits EN ATTENTE (Hyperliquid ne
      // les place qu'à l'exécution complète de l'entrée) et jamais déplaçables tant qu'ils n'existent pas.
      for (const c of o.children ?? [])
        out.push({
          id: `${k}:c:${c.oid}`,
          coin,
          price: c.price,
          color: c.kind === 'tp' ? up : down,
          title: `${pre}${c.label} en attente (actif à l’exécution complète de l’entrée)`,
          dashed: true,
          draggable: false,
        });
    }
  });
  return out;
}
