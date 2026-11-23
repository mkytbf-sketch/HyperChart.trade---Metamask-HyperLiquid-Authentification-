// Accès aux éléments de la page de l'application et écritures qui ne touchent le DOM que si le contenu change.
// Sortis de main.ts (audit du 20/11/2026, Q-01) : chaque module de l'interface les partage.
import { setHtml as writeHtml, type SafeHtml } from '../safe-html';

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

export const setText = (el: HTMLElement, text: string) => {
  if (el.textContent !== text) el.textContent = text;
};

/**
 * Remplace le contenu HTML seulement s'il change (le navigateur ne refait alors ni analyse ni mise en page). Fragment
 * sûr seulement (`html`…``, safe-html.ts), écrit par la politique Trusted Types.
 */
const htmlCache = new WeakMap<HTMLElement, string>();
export const setHtml = (el: HTMLElement, fragment: SafeHtml) => {
  const text = fragment.toString();
  if (htmlCache.get(el) === text) return;
  htmlCache.set(el, text);
  writeHtml(el, fragment);
};

/** Éléments fixes de index.html, lus une fois au démarrage de l'interface. */
export function pageElements() {
  return {
    scope: $('#scope'),
    price: $('#price'),
    chg: $('#chg'),
    tfs: $('#tfs'),
    theme: $<HTMLButtonElement>('#theme'),
    menuBtn: $<HTMLButtonElement>('#menu-btn'),
    menu: $('#menu'),
    cats: $('#ind-cats'),
    marks: $('#marks'),
    volmode: $('#volmode'),
    liveLines: $<HTMLButtonElement>('#live-lines'),
    liqSense: $<HTMLInputElement>('#liq-sense'),
    liqSenseOut: $('#liq-sense-out'),
    blockMin: $<HTMLInputElement>('#block-min'),
    blockMinOut: $('#block-min-out'),
    ribbon: $('#ribbon'),
    tools: $('#tools'),
    del: $<HTMLButtonElement>('#del'),
    wipe: $<HTMLButtonElement>('#wipe'),
    ohlc: $('#ohlc'),
    rows: $('#rows'),
    fold: $<HTMLButtonElement>('#fold'),
    hint: $('#hint'),
    busy: $('#busy'),
    golive: $<HTMLButtonElement>('#golive'),
    fail: $('#fail'),
    retry: $<HTMLButtonElement>('#retry'),
    reading: $('#reading'),
    rHeadline: $('#r-headline'),
    rDetail: $('#r-detail'),
    rPending: $('#r-pending'),
    rHealth: $('#r-health'),
    rCheck: $('#r-check'),
    rForce: $('#r-force'),
    rGauge: $('#r-gauge'),
    rDriver: $('#r-driver'),
    rFacts: $('#r-facts'),
    rNotes: $('#r-notes'),
    rWindow: $('#r-window'),
    rSources: $('#r-sources'),
    rWho: $('#r-who'),
    venues: $('#venues'),
    venuesNote: $('#venues-note'),
    styleBtn: $<HTMLButtonElement>('#style-btn'),
    styleMenu: $('#style-menu'),
    styleIcon: $('#style-icon'),
    styleLabel: $('#style-label'),
    indSearch: $<HTMLInputElement>('#ind-search'),
    shot: $<HTMLButtonElement>('#shot'),
    full: $<HTMLButtonElement>('#full'),
    live: $('#live'),
    liveText: $('#live-text'),
    countdown: $('#countdown'),
    magnet: $<HTMLButtonElement>('#magnet'),
    undo: $<HTMLButtonElement>('#undo'),
    toasts: $('#toasts'),
    floatBar: $('#float-bar'),
    floatColors: $('#float-colors'),
    floatWidth: $('#float-width'),
    floatDash: $<HTMLButtonElement>('#float-dash'),
    floatAmount: $('#float-amount'),
    floatRatio: $('#float-ratio'),
    floatCopy: $<HTMLButtonElement>('#float-copy'),
    floatCfg: $<HTMLButtonElement>('#float-cfg'),
    floatDel: $<HTMLButtonElement>('#float-del'),
    ctx: $('#ctx'),
    ranges: $('#ranges'),
    clock: $('#clock'),
    scalePct: $<HTMLButtonElement>('#scale-pct'),
    scaleLog: $<HTMLButtonElement>('#scale-log'),
    scaleAuto: $<HTMLButtonElement>('#scale-auto'),
    alerts: $('#alerts'),
    alertsCount: $('#alerts-count'),
    ticker: $('#ticker'),
    alertsEmpty: $('#alerts-empty'),
    help: $<HTMLButtonElement>('#help'),
    helpDialog: $<HTMLDialogElement>('#help-dialog'),
    helpClose: $<HTMLButtonElement>('#help-close'),
    sideToggle: $<HTMLButtonElement>('#side-toggle'),
    sideGrip: $<HTMLButtonElement>('#side-grip'),
    hideDrawings: $<HTMLButtonElement>('#hide-drawings'),
    bare: $<HTMLButtonElement>('#bare'),
    hideHl: $<HTMLButtonElement>('#hide-hl'),
  };
}

/** Éléments fixes de la page, tels que les lit `pageElements`. */
export type Elements = ReturnType<typeof pageElements>;

let phoneQuery: MediaQueryList | undefined;
/**
 * Téléphone (étroit, ou tenu à l'horizontale) : même requête que la mise en page « graphique seul » de style.css.
 * Créée au premier appel, puis toujours la même (ses écouteurs y restent) ; rien n'est lu au chargement du module,
 * pour que les modules qui l'importent restent testables hors navigateur.
 */
export function phone(): MediaQueryList {
  return (phoneQuery ??= window.matchMedia('(max-width: 760px), (max-height: 500px) and (pointer: coarse)'));
}
